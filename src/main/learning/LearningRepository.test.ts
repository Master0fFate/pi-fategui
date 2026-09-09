import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLearningSnapshot, learningDigest, learningIdentity, LearningRepository } from './LearningRepository';
import { LEARNING_LIMITS } from '../../shared/contracts/learning';

let root: string;
let repo: LearningRepository;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'learning-store-'))); repo = new LearningRepository(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const binding = () => learningIdentity(root, 'project');
const expected = (snapshot: { epoch: string; revision: number }) => ({ epoch: snapshot.epoch, revision: snapshot.revision });

describe('LearningRepository', () => {
  it('persists across repository instances and rejects stale on-disk compare-and-swap', async () => {
    const first = await repo.read(binding());
    const saved = await repo.mutate(binding(), expected(first), (state) => { state.mode = 'automatic'; });
    const second = new LearningRepository(root);
    expect(await second.read(binding())).toEqual(saved);
    await expect(second.mutate(binding(), expected(first), () => undefined)).rejects.toThrow('store changed');
    expect((await repo.read(binding())).revision).toBe(1);
  });
  it('isolates same-named roots, linked-worktree paths and explicit global scope', async () => {
    expect(learningIdentity(path.join(root, 'a/repo'), 'project').projectKey).not.toBe(learningIdentity(path.join(root, 'b/repo'), 'project').projectKey);
    expect(learningIdentity(path.join(root, 'worktree'), 'project')).not.toEqual(binding());
    const state = await repo.read(binding());
    await repo.mutate(binding(), expected(state), (next) => { next.mode = 'automatic'; });
    expect((await repo.read(learningIdentity(root, 'global'))).mode).toBe('manual');
  });
  it.each(['{broken', JSON.stringify({ schemaVersion: 99 }), JSON.stringify(emptyLearningSnapshot(learningIdentity('different/root', 'project')))])('preserves invalid snapshot bytes: %s', async (bytes) => {
    await repo.read(binding());
    const target = path.join(repo.directory(binding()), 'current.json');
    await fs.writeFile(target, bytes);
    await expect(repo.read(binding())).rejects.toThrow('Store is corrupt');
    await expect(repo.mutate(binding(), null, () => undefined)).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
  });
  it('requires an exact preview digest for explicit corrupt reset', async () => {
    await repo.read(binding());
    const target = path.join(repo.directory(binding()), 'current.json');
    await fs.writeFile(target, 'broken');
    await expect(repo.resetCorrupt(binding(), '0'.repeat(64))).rejects.toThrow('preview changed');
    await repo.resetCorrupt(binding(), learningDigest('broken'));
    expect((await repo.read(binding())).lessons).toEqual([]);
  });
  it('does not replace the prior snapshot when rename fails or the snapshot is full', async () => {
    const first = await repo.mutate(binding(), null, () => undefined);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
    await expect(repo.mutate(binding(), expected(first), (next) => { next.mode = 'automatic'; })).rejects.toThrow('Disk full');
    rename.mockRestore();
    expect(await repo.read(binding())).toEqual(first);
    await expect(repo.mutate(binding(), expected(first), (next) => { next.drafts = Array.from({ length: 101 }, () => ({} as never)); })).rejects.toThrow();
    expect(await repo.read(binding())).toEqual(first);
    expect((await fs.readdir(repo.directory(binding()))).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });
  it('refuses oversized files without reading or resetting them', async () => {
    await repo.read(binding());
    const target = path.join(repo.directory(binding()), 'current.json');
    await fs.writeFile(target, Buffer.alloc(LEARNING_LIMITS.snapshotBytes + 1));
    await expect(repo.read(binding())).rejects.toThrow('Store is corrupt');
    expect(await repo.recoveryDigest(binding())).toBeNull();
    expect((await fs.stat(target)).size).toBe(LEARNING_LIMITS.snapshotBytes + 1);
  });
  it('refuses symlink snapshot targets', async (context) => {
    await repo.read(binding());
    const target = path.join(repo.directory(binding()), 'current.json');
    const external = path.join(root, 'outside.json');
    await fs.writeFile(external, '{}');
    try { await fs.symlink(external, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    await expect(repo.read(binding())).rejects.toThrow();
    await expect(repo.mutate(binding(), null, () => undefined)).rejects.toThrow();
    expect(await fs.readFile(external, 'utf8')).toBe('{}');
  });
  it('refuses directory junctions below the configured data root', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'learning'), 'junction');
    await expect(repo.read(binding())).rejects.toThrow('Unsafe store directory');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('detects replacement between lstat and opening the snapshot handle', async () => {
    await repo.mutate(binding(), null, () => undefined);
    const target = path.join(repo.directory(binding()), 'current.json');
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === target && !swapped) {
        swapped = true;
        await fs.rename(target, `${target}.old`);
        await fs.writeFile(target, 'replacement');
      }
      return open(...args);
    });
    await expect(repo.read(binding())).rejects.toThrow('Store is corrupt');
    expect(await fs.readFile(target, 'utf8')).toBe('replacement');
  });
  it('serializes local mutations and does not steal a live second-process writer lock', async () => {
    const first = await repo.mutate(binding(), null, () => undefined);
    const attempts = await Promise.allSettled([repo.mutate(binding(), expected(first), (state) => { state.mode = 'off'; }), repo.mutate(binding(), expected(first), (state) => { state.mode = 'automatic'; })]);
    expect(attempts.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lock = path.join(repo.directory(binding()), 'writer.lock');
    const child = spawn(process.execPath, ['-e', `const fs=require('fs'); fs.mkdirSync(process.argv[1]); fs.writeFileSync(process.argv[1]+'/owner.json', JSON.stringify({pid:process.pid,host:require('os').hostname(),token:'child'})); console.log('locked'); setInterval(()=>{},1000);`, lock], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Lock holder exited early'))); });
      await expect(repo.mutate(binding(), null, () => undefined)).rejects.toThrow('locked');
      const digest = await repo.lockDigest(binding());
      expect(digest).not.toBeNull();
      await expect(repo.recoverLock(binding(), digest!)).rejects.toThrow('still alive');
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill(); await exited;
      await repo.recoverLock(binding(), digest!);
      await repo.mutate(binding(), null, () => undefined);
    } finally { child.kill(); }
  });
  it('retains unknown/incomplete locks instead of age-based takeover', async () => {
    await repo.read(binding());
    await fs.mkdir(path.join(repo.directory(binding()), 'writer.lock'));
    await fs.writeFile(path.join(repo.directory(binding()), 'writer.lock/owner.json'), JSON.stringify({ pid: -1, host: os.hostname(), token: randomUUID() }));
    await expect(repo.recoverLock(binding(), (await repo.lockDigest(binding()))!)).rejects.toThrow('cannot be established');
  });
});
