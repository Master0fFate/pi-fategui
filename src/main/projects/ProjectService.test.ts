import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openPath: vi.fn() },
}));
import { dialog } from 'electron';
import { ProjectService } from './ProjectService';

const temporaryDirectories: string[] = [];

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function setCurrentProject(service: ProjectService, projectPath: string): void {
  (service as unknown as { currentProject: { path: string; name: string; trusted: boolean } | null }).currentProject = {
    path: projectPath,
    name: path.basename(projectPath),
    trusted: true,
  };
}

describe('ProjectService.select', () => {
  it('ignores oversized or corrupt recent-project state instead of loading it', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    temporaryDirectories.push(dataRoot);
    await writeFile(path.join(dataRoot, 'recent-project.json'), 'x'.repeat(8_193));
    const showOpenDialog = vi.mocked(dialog.showOpenDialog);
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(new ProjectService(dataRoot).select()).resolves.toBeNull();
    expect(showOpenDialog).toHaveBeenCalledWith(expect.not.objectContaining({ defaultPath: expect.anything() }));
  });

  it('remembers Fate UI trust across app restarts without using Pi CLI trust state', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(dataRoot, projectPath);
    const showOpenDialog = vi.mocked(dialog.showOpenDialog);
    const showMessageBox = vi.mocked(dialog.showMessageBox);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectPath] });
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    const firstProcess = new ProjectService(dataRoot);
    await expect(firstProcess.select()).resolves.toMatchObject({ trusted: true });
    await expect(firstProcess.select()).resolves.toMatchObject({ trusted: true });
    await expect(new ProjectService(dataRoot).select()).resolves.toMatchObject({ trusted: true });
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('opens an explicit worktree path through the same canonical trust flow', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-worktree-'));
    temporaryDirectories.push(dataRoot, worktreePath);
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const service = new ProjectService(dataRoot);

    await expect(service.openPath(worktreePath)).resolves.toMatchObject({ path: await realpath(worktreePath), trusted: true });
    await expect(service.openPath(worktreePath)).resolves.toMatchObject({ path: await realpath(worktreePath), trusted: true });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it('inherits trust only for a derived worktree of the active trusted project', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-worktree-'));
    temporaryDirectories.push(dataRoot, projectPath, worktreePath);
    const service = new ProjectService(dataRoot);
    setCurrentProject(service, await realpath(projectPath));

    await expect(service.openDerivedWorktree(worktreePath, projectPath)).resolves.toMatchObject({
      path: await realpath(worktreePath),
      name: path.basename(await realpath(projectPath)),
      trusted: true,
    });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();

    const unrelated = await mkdtemp(path.join(tmpdir(), 'pi-desktop-unrelated-'));
    temporaryDirectories.push(unrelated);
    await expect(service.openDerivedWorktree(unrelated, projectPath)).rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });
  });

  it('fails closed and asks again when persisted trust state is malformed', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(dataRoot, projectPath);
    await writeFile(path.join(dataRoot, 'trusted-projects.json'), '{not valid json');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [projectPath] });
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 2, checkboxChecked: false });

    await expect(new ProjectService(dataRoot).select()).resolves.toBeNull();
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it('remembers the last opened project for the next native folder picker', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(dataRoot, projectPath);
    const showOpenDialog = vi.mocked(dialog.showOpenDialog);
    const showMessageBox = vi.mocked(dialog.showMessageBox);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectPath] });
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    await expect(new ProjectService(dataRoot).select()).resolves.toMatchObject({ path: await realpath(projectPath) });

    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(new ProjectService(dataRoot).select()).resolves.toBeNull();
    expect(showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: await realpath(projectPath) }));
  });

  it('prepares trust without mutating authority and rolls back only transaction-added trust', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const sourcePath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    const targetPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(dataRoot, sourcePath, targetPath);
    const service = new ProjectService(dataRoot);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const source = await service.openPath(sourcePath);
    const activation = await service.prepareOpenPath(targetPath);

    expect(service.getCurrent()).toEqual(source);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'trusted-projects.json'), 'utf8')).paths).toEqual([await realpath(sourcePath)]);

    await activation?.commit();
    await activation?.rollback();

    expect(service.getCurrent()).toEqual(source);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'trusted-projects.json'), 'utf8')).paths).toEqual([await realpath(sourcePath)]);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'recent-project.json'), 'utf8'))).toEqual({ path: await realpath(sourcePath) });
  });

  it('preserves trust that existed before a rolled-back activation', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pi-desktop-state-'));
    const sourcePath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    const targetPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(dataRoot, sourcePath, targetPath);
    const service = new ProjectService(dataRoot);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    await service.openPath(targetPath);
    const source = await service.openPath(sourcePath);
    const activation = await service.prepareOpenPath(targetPath);

    await activation?.commit();
    await activation?.rollback();

    expect(service.getCurrent()).toEqual(source);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'trusted-projects.json'), 'utf8')).paths).toEqual([
      await realpath(targetPath),
      await realpath(sourcePath),
    ]);
  });
});

describe('ProjectService.revealCurrent', () => {
  it('rejects a missing current project with an actionable normalized error', async () => {
    await expect(new ProjectService().revealCurrent(vi.fn())).rejects.toMatchObject({
      normalized: {
        code: 'RUNTIME_NOT_READY',
        message: 'Open a project before showing it in the file browser.',
        actionable: 'Open a project, then try again.',
        retryable: true,
      },
    });
  });

  it('opens only the canonical project retained by main-owned state', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(projectPath);
    const service = new ProjectService();
    const canonicalProjectPath = await realpath(projectPath);
    setCurrentProject(service, canonicalProjectPath);
    const openPath = vi.fn(async () => '');

    await expect(service.revealCurrent(openPath)).resolves.toEqual({ opened: true });
    expect(openPath).toHaveBeenCalledWith(canonicalProjectPath);
  });

  it('normalizes file-browser failures with retry guidance', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-desktop-project-'));
    temporaryDirectories.push(projectPath);
    const service = new ProjectService();
    setCurrentProject(service, await realpath(projectPath));

    await expect(service.revealCurrent(async () => 'No application is registered')).rejects.toMatchObject({
      normalized: {
        code: 'INVALID_PROJECT',
        actionable: 'Check that the project is still accessible, then retry.',
        retryable: true,
      },
    });
  });
});
