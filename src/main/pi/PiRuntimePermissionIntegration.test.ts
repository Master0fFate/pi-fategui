import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRuntimeService } from './PiRuntimeService';
import { InMemorySessionPermissionStore, SessionPermissionStore } from './SessionPermissionStore';
import { AppLogService } from '../logging/AppLogService';
import { PiDesktopError } from './errors';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function isolatedRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fate-real-permission-')));
  roots.push(root);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'PI_CONFIG_DIR', 'FATE_GUI_DATA_DIR']) {
    const directory = path.join(root, key);
    await fs.mkdir(directory);
    vi.stubEnv(key, directory);
  }
  vi.stubEnv('PI_OFFLINE', '1');
  return root;
}

describe('real SDK root permission fencing (no provider requests)', () => {
  it('preserves structured host denial details and synchronous shell refusal on retained tools', async () => {
    const root = await isolatedRoot();
    const service = new PiRuntimeService();
    try {
      await service.openProject({ path: root, name: 'fixture', trusted: true });
      await service.setPermissionLevel('full-access');
      const session = (service as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      const write = session.agent.state.tools.find((tool) => tool.name === 'write')!;
      const bash = session.agent.state.tools.find((tool) => tool.name === 'bash')!;
      const target = path.join(root, 'sentinel.txt');
      await fs.writeFile(target, 'unchanged');
      const denial = { code: 'INVALID_REQUEST' as const, message: 'Execution requires a fresh review.', retryable: false, actionable: 'Review the retained execution first.' };
      service.setExecutionAdmissionGuard(() => { throw new PiDesktopError(denial); });
      const expected = { ...denial, message: `Tool execution authority is unavailable. ${denial.message}` };
      await expect(write.execute('denied-write', { path: target, content: 'not allowed' })).rejects.toMatchObject({ normalized: expected });
      let thrown: unknown;
      try { bash.execute('denied-bash', { command: 'echo must-not-execute' }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(PiDesktopError);
      expect(thrown).toMatchObject({ normalized: expected });
      expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
    } finally { await service.dispose(); }
  });

  it('starts edit, persists before escalation, and revokes retained write/bash handles on reduction', async () => {
    const root = await isolatedRoot();
    const permissions = new InMemorySessionPermissionStore();
    const service = new PiRuntimeService(undefined, undefined, permissions);
    try {
      const state = await service.openProject({ path: root, name: 'fixture', trusted: true });
      expect(state.status).toBe('auth-required');
      expect(state.permissionLevel).toBe('edit');
      const slot = (service as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot;
      const session = slot.runtime.session;
      expect(session.getActiveToolNames()).not.toContain('bash');
      await service.setPermissionLevel('full-access');
      await expect(permissions.get(root, session.sessionId)).resolves.toBe('full-access');
      const write = session.agent.state.tools.find((tool) => tool.name === 'write');
      const bash = session.agent.state.tools.find((tool) => tool.name === 'bash');
      expect(write).toBeDefined();
      expect(bash).toBeDefined();
      const target = path.join(root, 'sentinel.txt');
      await fs.writeFile(target, 'unchanged');
      await service.setPermissionLevel('read-only');
      await expect(write!.execute('stale-write', { path: target, content: 'not allowed' })).rejects.toThrow(/authority|read.only/i);
      expect(() => bash!.execute('stale-bash', { command: 'echo must-not-execute' })).toThrow(/authority|shell/i);
      expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
      expect(session.getActiveToolNames()).not.toContain('write');
      expect(session.getActiveToolNames()).not.toContain('bash');
    } finally { await service.dispose(); }
  });

  it.each(['read-only', 'edit'] as const)('staged SDK names cannot exceed %s tool-effect authority before the save resolves', async (previous) => {
    const root = await isolatedRoot();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const target = path.join(root, 'outside-project.txt');
    await fs.writeFile(target, 'unchanged');
    const permissions = new InMemorySessionPermissionStore();
    const service = new PiRuntimeService(undefined, undefined, permissions);
    try {
      await service.openProject({ path: project, name: 'fixture', trusted: true });
      await service.setPermissionLevel(previous);
      const session = (service as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      let entered!: () => void;
      const saving = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const finish = new Promise<void>((resolve) => { release = resolve; });
      const persist = permissions.set.bind(permissions);
      vi.spyOn(permissions, 'set').mockImplementationOnce(async (...args) => { entered(); await finish; await persist(...args); });
      const change = service.setPermissionLevel('full-access');
      try {
        await saving;
        expect(service.getState(false).permissionLevel).toBe(previous);
        expect(service.agentAuthority(session.sessionId)).toBeNull();
        const write = session.agent.state.tools.find((tool) => tool.name === 'write');
        const bash = session.agent.state.tools.find((tool) => tool.name === 'bash');
        expect(write).toBeDefined();
        expect(bash).toBeDefined(); // Names are staged, but effective authority is not.
        await expect(write!.execute('staged-write', { path: target, content: 'not allowed' })).rejects.toThrow(/authority|project|read.only/i);
        expect(() => bash!.execute('staged-bash', { command: 'echo must-not-execute' })).toThrow(/authority|shell/i);
        expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
      } finally { release(); await change; }
      expect(service.getState(false).permissionLevel).toBe('full-access');
      await expect(permissions.get(project, session.sessionId)).resolves.toBe('full-access');
    } finally { await service.dispose(); }
  });

  it('revokes another real SDK root and its retained tools when shared persistence fails', async () => {
    const root = await isolatedRoot();
    const firstProject = path.join(root, 'first-project');
    const secondProject = path.join(root, 'second-project');
    await fs.mkdir(firstProject);
    await fs.mkdir(secondProject);
    const permissions = new SessionPermissionStore(new AppLogService(), path.join(root, 'permission-data'));
    const first = new PiRuntimeService(undefined, undefined, permissions);
    const second = new PiRuntimeService(undefined, undefined, permissions);
    try {
      await first.openProject({ path: firstProject, name: 'first', trusted: true });
      await first.setPermissionLevel('full-access');
      const session = (first as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      const write = session.agent.state.tools.find((tool) => tool.name === 'write');
      const bash = session.agent.state.tools.find((tool) => tool.name === 'bash');
      expect(write).toBeDefined();
      expect(bash).toBeDefined();
      await second.openProject({ path: secondProject, name: 'second', trusted: true });
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('grant rename failed'));
      await expect(second.setPermissionLevel('full-access')).rejects.toThrow(/blocked/);
      expect(first.agentAuthority(session.sessionId)).toBeNull();
      expect(first.getState(false).permissionLevel).toBe('read-only');
      const target = path.join(firstProject, 'sentinel.txt');
      await fs.writeFile(target, 'unchanged');
      await expect(write!.execute('stale-write', { path: target, content: 'not allowed' })).rejects.toThrow(/authority|read.only/i);
      expect(() => bash!.execute('stale-bash', { command: 'echo must-not-execute' })).toThrow(/authority|shell/i);
      expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
    } finally { await Promise.all([first.dispose(), second.dispose()]); }
  });

  it('revokes retained real SDK tools before waiting for teardown, even if the shared store then fails', async () => {
    const root = await isolatedRoot();
    const firstProject = path.join(root, 'teardown-project');
    const secondProject = path.join(root, 'other-project');
    await fs.mkdir(firstProject);
    await fs.mkdir(secondProject);
    const permissions = new SessionPermissionStore(new AppLogService(), path.join(root, 'permission-data'));
    const first = new PiRuntimeService(undefined, undefined, permissions);
    const second = new PiRuntimeService(undefined, undefined, permissions);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let disposal: Promise<void> | undefined;
    try {
      await first.openProject({ path: firstProject, name: 'first', trusted: true });
      await first.setPermissionLevel('full-access');
      const session = (first as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      const write = session.agent.state.tools.find((tool) => tool.name === 'write');
      const bash = session.agent.state.tools.find((tool) => tool.name === 'bash');
      expect(write).toBeDefined();
      expect(bash).toBeDefined();
      await second.openProject({ path: secondProject, name: 'second', trusted: true });
      const workflows = (first as unknown as { agentWorkflows: { cancelAll: () => Promise<void> } }).agentWorkflows;
      vi.spyOn(workflows, 'cancelAll').mockImplementationOnce(async () => { entered(); await blocked; });
      disposal = first.dispose();
      await waiting;
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('grant rename failed'));
      await expect(second.setPermissionLevel('full-access')).rejects.toThrow(/blocked/);
      const target = path.join(firstProject, 'sentinel.txt');
      await fs.writeFile(target, 'unchanged');
      await expect(write!.execute('stale-write', { path: target, content: 'not allowed' })).rejects.toThrow(/authority|read.only/i);
      expect(() => bash!.execute('stale-bash', { command: 'echo must-not-execute' })).toThrow(/authority|shell/i);
      expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
    } finally {
      release();
      await Promise.all([disposal ?? first.dispose(), second.dispose()]);
    }
  });

  it('does not make bash available in the real adapter after an escalation save fails', async () => {
    const root = await isolatedRoot();
    const permissions = new InMemorySessionPermissionStore();
    const service = new PiRuntimeService(undefined, undefined, permissions);
    try {
      await service.openProject({ path: root, name: 'fixture', trusted: true });
      vi.spyOn(permissions, 'set').mockRejectedValueOnce(new Error('deterministic disk failure'));
      await expect(service.setPermissionLevel('full-access')).rejects.toThrow(/blocked/);
      const session = (service as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      expect(session.getActiveToolNames()).not.toContain('bash');
      expect(service.getState(false).permissionLevel).toBe('edit');
      expect(session.agent.state.tools.some((tool) => tool.name === 'bash')).toBe(false);
    } finally { await service.dispose(); }
  });
});
