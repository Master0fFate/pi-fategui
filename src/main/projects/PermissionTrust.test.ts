import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() }, shell: {} }));
import { dialog } from 'electron';
import { ProjectService } from './ProjectService';
import { PiRuntimeService, type PiSdkAdapter } from '../pi/PiRuntimeService';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('native permission trust gate', () => {
  it.each([{ response: 1, label: 'Open without Pi' }, { response: 2, label: 'Cancel' }])('$label does not initialize Pi or project-local resources', async ({ response }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-trust-permission-'));
    directories.push(root);
    const adapter: PiSdkAdapter = {
      createModelRuntime: vi.fn(async () => { throw new Error('Unexpected Pi model initialization'); }),
      createRuntime: vi.fn(async () => { throw new Error('Unexpected project resource initialization'); }),
    };
    const runtime = new PiRuntimeService(adapter);
    const projects = new ProjectService(path.join(root, 'data'));
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response, checkboxChecked: false });
    try {
      const activation = await projects.prepareOpenPath(root);
      if (response === 2) expect(activation).toBeNull();
      else {
        expect(activation?.project.trusted).toBe(false);
        const state = await runtime.openProject(await activation!.commit());
        expect(state).toMatchObject({ status: 'disconnected', error: { code: 'PROJECT_NOT_TRUSTED' } });
      }
      expect(adapter.createModelRuntime).not.toHaveBeenCalled();
      expect(adapter.createRuntime).not.toHaveBeenCalled();
      expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Trust and open', 'Open without Pi', 'Cancel'], defaultId: 2, cancelId: 2 }));
    } finally { await runtime.dispose(); }
  });

  it('Trust and open retains an explicit native trust decision on recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-trust-permission-'));
    directories.push(root);
    const data = path.join(root, 'data');
    vi.mocked(dialog.showMessageBox).mockClear().mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const first = await new ProjectService(data).openPath(root);
    expect(first?.trusted).toBe(true);
    const recovered = await new ProjectService(data).openPath(root);
    expect(recovered).toEqual(first);
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });
});
