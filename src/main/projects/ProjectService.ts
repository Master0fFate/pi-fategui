import { dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectState } from '../../shared/contracts/ipc';
import { PiDesktopError } from '../pi/errors';

const MAX_TRUST_STATE_BYTES = 256 * 1024;
const MAX_TRUSTED_PROJECTS = 2_000;
const MAX_PROJECT_PATH_CHARACTERS = 32_768;

export async function canonicalizeProjectPath(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'A project directory is required.', retryable: false });
  }
  const absolute = path.resolve(input);
  try {
    const canonical = path.normalize(await fs.realpath(absolute));
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error('The selected path is not a directory.');
    return canonical;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The directory is not accessible.';
    throw new PiDesktopError({ code: 'INVALID_PROJECT', message: `Cannot open project: ${message}`, retryable: true });
  }
}

export interface ProjectActivation {
  readonly project: ProjectState;
  commit(): Promise<ProjectState>;
  rollback(): Promise<void>;
}

export class ProjectService {
  // Fate UI owns this trust state. It never mutates Pi CLI's shared trust store
  // or silently authorizes project code in another Pi client.
  private readonly trustedProjects = new Set<string>();
  private trustStateLoad: Promise<void> | null = null;
  private currentProject: ProjectState | null = null;

  constructor(
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
  ) {}

  async select(owner?: BrowserWindow): Promise<ProjectState | null> {
    const activation = await this.prepareSelect(owner);
    return activation ? this.commitActivation(activation) : null;
  }

  async prepareSelect(owner?: BrowserWindow): Promise<ProjectActivation | null> {
    const defaultPath = await this.lastProjectPath();
    const options: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Open project in Fate UI',
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    return this.prepareOpenPath(selected, owner);
  }

  async openPath(projectPath: string, owner?: BrowserWindow): Promise<ProjectState | null> {
    const activation = await this.prepareOpenPath(projectPath, owner);
    return activation ? this.commitActivation(activation) : null;
  }

  async prepareOpenPath(projectPath: string, owner?: BrowserWindow): Promise<ProjectActivation | null> {
    const canonical = await canonicalizeProjectPath(projectPath);
    await this.loadTrustedProjects();
    let trusted = this.trustedProjects.has(canonical);

    if (!trusted) {
      const prompt = {
        type: 'warning' as const,
        title: 'Trust this project?',
        message: `Do you trust “${path.basename(canonical)}”?`,
        detail: `New Pi sessions start with Full access: they can read and modify host files outside this project and run shell commands with your user account. Trusted project settings, skills, prompts, and configured packages may be loaded. Fate UI still blocks project-local extensions. You can lower access per session in the composer. Commands in the manual terminal remain under your control.`,
        buttons: ['Trust and open', 'Open without Pi', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      };
      const confirmation = owner ? await dialog.showMessageBox(owner, prompt) : await dialog.showMessageBox(prompt);
      if (confirmation.response === 2) return null;
      trusted = confirmation.response === 0;
    }

    return this.activation({ path: canonical, name: path.basename(canonical) || canonical, trusted });
  }

  /** Return the last project only when Fate UI already trusts it. */
  async lastTrustedProjectPath(): Promise<string | null> {
    const recent = await this.lastProjectPath();
    if (!recent) return null;
    await this.loadTrustedProjects();
    return this.trustedProjects.has(recent) ? recent : null;
  }

  /**
   * Resolve a path for read-only session previews. Previewing is allowed for
   * the active project and folders Fate has already trusted, but never for an
   * arbitrary local path supplied by the renderer.
   */
  async prepareSessionListPath(projectPath: string): Promise<string> {
    const canonical = await canonicalizeProjectPath(projectPath);
    await this.loadTrustedProjects();
    if (this.currentProject?.path === canonical || this.trustedProjects.has(canonical)) return canonical;
    throw new PiDesktopError({
      code: 'PROJECT_NOT_TRUSTED',
      message: 'Trust this project before previewing its sessions.',
      actionable: 'Open the folder and choose “Trust and open” first.',
      retryable: true,
    });
  }

  /**
   * Resolve a previously trusted project for local cleanup after it disappears
   * from disk. This deliberately avoids realpath/stat: closing an idle runtime
   * and deleting its persisted sessions do not require the project directory.
   */
  async prepareKnownProjectCleanupPath(projectPath: string): Promise<string> {
    if (typeof projectPath !== 'string' || projectPath.trim() === '' || projectPath.includes('\0')) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'A project directory is required.', retryable: false });
    }
    const normalized = path.normalize(path.resolve(projectPath));
    await this.loadTrustedProjects();
    const knownPaths = [this.currentProject?.path, ...this.trustedProjects].filter((value): value is string => Boolean(value));
    const known = knownPaths.find((candidate) => this.projectPathsMatch(candidate, normalized));
    if (known) return known;
    throw new PiDesktopError({
      code: 'PROJECT_NOT_TRUSTED',
      message: 'Trust this project before managing its saved sessions.',
      actionable: 'Open the folder and choose “Trust and open” first.',
      retryable: true,
    });
  }

  async revealPath(projectPath: string): Promise<{ opened: true }> {
    const canonical = await this.prepareSessionListPath(projectPath);
    const failure = await shell.openPath(canonical);
    if (failure) {
      throw new PiDesktopError({
        code: 'INVALID_PROJECT',
        message: `The file browser could not open the project: ${failure}`,
        actionable: 'Check that the project is still accessible, then retry.',
        retryable: true,
      });
    }
    return { opened: true };
  }

  private projectPathsMatch(left: string, right: string): boolean {
    // Windows filesystems are case-insensitive by contract; macOS and Linux
    // volumes can be case-sensitive, so do not weaken matching there.
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }

  private async lastProjectPath(): Promise<string | undefined> {
    if (this.currentProject) return this.currentProject.path;
    try {
      const statePath = path.join(this.dataRoot, 'recent-project.json');
      if ((await fs.stat(statePath)).size > 8_192) return undefined;
      const value: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string') return undefined;
      return await canonicalizeProjectPath(value.path);
    } catch {
      return undefined;
    }
  }

  private async loadTrustedProjects(): Promise<void> {
    this.trustStateLoad ??= this.readTrustedProjects();
    await this.trustStateLoad;
  }

  private async readTrustedProjects(): Promise<void> {
    try {
      const target = path.join(this.dataRoot, 'trusted-projects.json');
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_TRUST_STATE_BYTES) return;
      const value: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('paths' in value) || !Array.isArray(value.paths)) return;
      if (value.paths.length > MAX_TRUSTED_PROJECTS) return;
      for (const trustedPath of value.paths) {
        if (
          typeof trustedPath === 'string'
          && trustedPath.length > 0
          && trustedPath.length <= MAX_PROJECT_PATH_CHARACTERS
          && !trustedPath.includes('\0')
          && path.isAbsolute(trustedPath)
        ) {
          this.trustedProjects.add(path.normalize(trustedPath));
        }
      }
    } catch {
      // Missing, unreadable, or malformed state fails closed and prompts again.
    }
  }

  private async rememberTrustedProjects(): Promise<void> {
    const paths = [...this.trustedProjects].slice(-MAX_TRUSTED_PROJECTS);
    await this.writeState('trusted-projects.json', { version: 1, paths });
  }

  private async rememberProjectPath(projectPath: string): Promise<void> {
    await this.writeState('recent-project.json', { path: projectPath });
  }

  private async restoreProjectPath(projectPath: string | undefined): Promise<void> {
    if (projectPath) {
      await this.rememberProjectPath(projectPath);
      return;
    }
    await fs.rm(path.join(this.dataRoot, 'recent-project.json'), { force: true });
  }

  private async writeState(fileName: string, value: unknown): Promise<void> {
    const target = path.join(this.dataRoot, fileName);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(this.dataRoot, { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  getCurrent(): ProjectState | null {
    return this.currentProject;
  }

  async openDerivedWorktree(worktreePath: string, sourceProjectPath: string): Promise<ProjectState> {
    return this.commitActivation(await this.prepareDerivedWorktree(worktreePath, sourceProjectPath));
  }

  async prepareDerivedWorktree(worktreePath: string, sourceProjectPath: string): Promise<ProjectActivation> {
    const source = await canonicalizeProjectPath(sourceProjectPath);
    if (!this.currentProject?.trusted || this.currentProject.path !== source) {
      throw new PiDesktopError({
        code: 'PROJECT_NOT_TRUSTED',
        message: 'Only a trusted active project can create an isolated worktree session.',
        retryable: false,
      });
    }
    const canonical = await canonicalizeProjectPath(worktreePath);
    await this.loadTrustedProjects();
    return this.activation({ path: canonical, name: path.basename(source) || source, trusted: true });
  }

  private async commitActivation(activation: ProjectActivation): Promise<ProjectState> {
    try {
      return await activation.commit();
    } catch (error) {
      try {
        await activation.rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `${error instanceof Error ? error.message : String(error)} Project rollback also failed.`);
      }
      throw error;
    }
  }

  private async activation(project: ProjectState): Promise<ProjectActivation> {
    const previousProject = this.currentProject;
    const previousRecentPath = await this.lastProjectPath();
    const trustAlreadyPresent = this.trustedProjects.has(project.path);
    let commitStarted = false;
    let trustAdded = false;

    return {
      project,
      commit: async () => {
        if (commitStarted) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'This project activation was already used.', retryable: false });
        commitStarted = true;
        if (project.trusted && !trustAlreadyPresent) {
          this.trustedProjects.add(project.path);
          trustAdded = true;
        }
        this.currentProject = project;
        if (trustAdded) await this.rememberTrustedProjects();
        await this.rememberProjectPath(project.path);
        return project;
      },
      rollback: async () => {
        if (!commitStarted) return;
        this.currentProject = previousProject;
        if (trustAdded) this.trustedProjects.delete(project.path);
        const failures: unknown[] = [];
        if (trustAdded) {
          try { await this.rememberTrustedProjects(); } catch (error) { failures.push(error); }
        }
        try { await this.restoreProjectPath(previousRecentPath); } catch (error) { failures.push(error); }
        if (failures.length > 0) throw new AggregateError(failures, 'Project persistence rollback failed.');
      },
    };
  }

  async selectFile(owner?: BrowserWindow): Promise<string | null> {
    const project = this.currentProject;
    if (!project) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before referencing a file.', retryable: true });
    }
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      title: 'Reference a project file',
      defaultPath: project.path,
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;

    const canonical = path.normalize(await fs.realpath(selected));
    const relative = path.relative(project.path, canonical);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new PiDesktopError({
        code: 'INVALID_PROJECT',
        message: 'Choose a file inside the active project.',
        actionable: `The active project is ${project.path}.`,
        retryable: true,
      });
    }
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The selected path is not a file.', retryable: true });
    }
    return relative.split(path.sep).join('/');
  }

  async revealCurrent(openPath: (projectPath: string) => Promise<string> = shell.openPath): Promise<{ opened: true }> {
    const project = this.currentProject;
    if (!project) {
      throw new PiDesktopError({
        code: 'RUNTIME_NOT_READY',
        message: 'Open a project before showing it in the file browser.',
        actionable: 'Open a project, then try again.',
        retryable: true,
      });
    }

    try {
      const stat = await fs.stat(project.path);
      if (!stat.isDirectory()) throw new Error('The project path is no longer a directory.');
    } catch (error) {
      throw new PiDesktopError({
        code: 'INVALID_PROJECT',
        message: `Cannot show project: ${error instanceof Error ? error.message : 'The project path is not accessible.'}`,
        actionable: 'Open the project again, then retry.',
        retryable: true,
      });
    }

    const failure = await openPath(project.path);
    if (failure) {
      throw new PiDesktopError({
        code: 'INVALID_PROJECT',
        message: `The file browser could not open the project: ${failure}`,
        actionable: 'Check that the project is still accessible, then retry.',
        retryable: true,
      });
    }
    return { opened: true };
  }
}
