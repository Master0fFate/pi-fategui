import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserHistoryRepository, isRestorableBrowserUrl } from './BrowserHistoryRepository';

describe('browser last-URL history', () => {
  it('classifies real network pages and local preview files as restorable', () => {
    expect(isRestorableBrowserUrl('http://localhost:3000/app')).toBe(true);
    expect(isRestorableBrowserUrl('https://example.com')).toBe(true);
    expect(isRestorableBrowserUrl('file:///C:/Users/fate/project/index.html')).toBe(true);
    expect(isRestorableBrowserUrl('about:blank')).toBe(false);
    expect(isRestorableBrowserUrl('fate-local://abc/page.html')).toBe(false);
    expect(isRestorableBrowserUrl('chrome://settings')).toBe(false);
    expect(isRestorableBrowserUrl('')).toBe(false);
  });

  it('persists the last restorable URL per project and survives a reopen', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-browser-history-'));
    try {
      const repo = new BrowserHistoryRepository(root);
      await repo.save('/project-a', 'http://localhost:3000/app');
      expect(await repo.load('/project-a')).toBe('http://localhost:3000/app');
      // Isolated per project.
      expect(await repo.load('/project-b')).toBeNull();
      // Non-restorable URLs never overwrite the remembered page.
      await repo.save('/project-a', 'about:blank');
      expect(await repo.load('/project-a')).toBe('http://localhost:3000/app');
      // A fresh instance reads the value from disk.
      const reopened = new BrowserHistoryRepository(root);
      expect(await reopened.load('/project-a')).toBe('http://localhost:3000/app');
      // Clearing forgets the URL.
      await reopened.save('/project-a', null);
      expect(await reopened.load('/project-a')).toBeNull();
      expect(await reopened.loadSession('/project-a')).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('remembers a local preview file across a reopen and replaces it with the next page', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-browser-history-'));
    try {
      const repo = new BrowserHistoryRepository(root);
      const localPage = 'file:///C:/Users/fate/project/preview/index.html';
      await repo.save('/project-a', localPage);
      expect(await repo.load('/project-a')).toBe(localPage);
      // The ephemeral capability token never overwrites the remembered file.
      await repo.save('/project-a', 'fate-local://a1b2c3d4/index.html');
      expect(await repo.load('/project-a')).toBe(localPage);
      // Moving on to a network page replaces it.
      await repo.save('/project-a', 'https://example.com/');
      expect(await repo.load('/project-a')).toBe('https://example.com/');
      // A fresh instance still reads the file entry from disk.
      await repo.save('/project-b', localPage);
      const reopened = new BrowserHistoryRepository(root);
      expect(await reopened.load('/project-b')).toBe(localPage);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('persists every restorable tab and the active index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-browser-history-'));
    try {
      const repo = new BrowserHistoryRepository(root);
      await repo.save('/project-a', {
        tabs: ['https://one.example/', 'https://two.example/', 'about:blank', 'https://three.example/'],
        activeIndex: 2,
      });
      expect(await repo.loadSession('/project-a')).toEqual({
        tabs: ['https://one.example/', 'https://two.example/', 'https://three.example/'],
        activeIndex: 2,
      });
      expect(await repo.load('/project-a')).toBe('https://three.example/');
      await repo.save('/project-a', { tabs: [], activeIndex: 0 });
      expect(await repo.loadSession('/project-a')).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('migrates a v1 single-url history file into a one-tab session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-browser-history-'));
    try {
      const key = createHash('sha256').update('/project-a').digest('hex');
      await fs.writeFile(path.join(root, 'browser-history.json'), JSON.stringify({
        schemaVersion: 1,
        urls: { [key]: 'https://legacy.example/' },
      }), { encoding: 'utf8' });
      const repo = new BrowserHistoryRepository(root);
      expect(await repo.loadSession('/project-a')).toEqual({ tabs: ['https://legacy.example/'], activeIndex: 0 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('treats a corrupt history file as empty instead of crashing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-browser-history-'));
    try {
      await fs.writeFile(path.join(root, 'browser-history.json'), '{ not valid json', { encoding: 'utf8' });
      const repo = new BrowserHistoryRepository(root);
      expect(await repo.load('/project-a')).toBeNull();
      await repo.save('/project-a', 'http://localhost:5173');
      expect(await repo.load('/project-a')).toBe('http://localhost:5173');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
