import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserHistoryRepository, isRestorableBrowserUrl } from './BrowserHistoryRepository';

describe('browser last-URL history', () => {
  it('classifies only real network pages as restorable', () => {
    expect(isRestorableBrowserUrl('http://localhost:3000/app')).toBe(true);
    expect(isRestorableBrowserUrl('https://example.com')).toBe(true);
    expect(isRestorableBrowserUrl('about:blank')).toBe(false);
    expect(isRestorableBrowserUrl('fate-local://abc')).toBe(false);
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
