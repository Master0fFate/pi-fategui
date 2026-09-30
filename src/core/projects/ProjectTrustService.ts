import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectState } from '../../shared/contracts/ipc';
import { PiDesktopError } from '../../main/pi/errors';
import type { ProjectRegistrationPort, ProjectTrustPort } from '../ports';

const MAX_TRUST_STATE_BYTES = 256 * 1024;
const MAX_TRUSTED_PROJECTS = 2_000;
const MAX_PROJECT_PATH_CHARACTERS = 32_768;

async function readBoundedState(target: string, maximumBytes: number): Promise<unknown> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Project state is not a bounded regular file.');
  const file = await fs.open(target, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > maximumBytes) throw new Error('Project state changed before it could be read.');
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error('Project state exceeds its read limit.');
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

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

/** Node-only trust store. UI answers come exclusively from the host-owned decision port. */
export class ProjectTrustService {
  // Fate owns this state, never Pi CLI's shared trust store.
  private readonly trustedProjects = new Set<string>();
  private trustStateLoad: Promise<void> | null = null;
  private currentProject: ProjectState | null = null;

  constructor(private readonly dataRoot: string) {}

  async prepareProjectPath(projectPath: string, trust: ProjectTrustPort): Promise<ProjectActivation | null> {
    const canonical = await canonicalizeProjectPath(projectPath);
    await this.loadTrustedProjects();
    let trusted = this.trustedProjects.has(canonical);
    if (!trusted) {
      const decision = await trust.decide({ path: canonical, name: path.basename(canonical) });
      if (decision === 'cancel') return null;
      if (decision !== 'trust' && decision !== 'open-without-pi') {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The host returned an invalid project trust decision.', retryable: false });
      }
      trusted = decision === 'trust';
    }
    return this.activation({ path: canonical, name: path.basename(canonical) || canonical, trusted });
  }

  /** Host-local configuration admission, never an ordinary client registration API. */
  async prepareRegisteredProject(projectPath: string, registration: ProjectRegistrationPort): Promise<ProjectActivation> {
    const canonical = await canonicalizeProjectPath(projectPath);
    // A prior desktop trust record cannot substitute for this host's registration.
    // Registration is a separate authority: it must not write desktop trust or
    // recent-project preferences. No dialog or project-supplied flag is used.
    if (registration.isRegistered(canonical) !== true) {
      throw new PiDesktopError({
        code: 'PROJECT_NOT_TRUSTED',
        message: 'This project is not registered in the execution host configuration.',
        retryable: false,
      });
    }
    const activation = await this.activation({ path: canonical, name: path.basename(canonical) || canonical, trusted: true }, false);
    return {
      project: activation.project,
      commit: async () => {
        if (registration.isRegistered(canonical) !== true) {
          throw new PiDesktopError({ code: 'PROJECT_NOT_TRUSTED', message: 'Host workspace registration changed.', retryable: true });
        }
        return activation.commit();
      },
      rollback: () => activation.rollback(),
    };
  }

  /** Return the last project only when Fate UI already trusts it. */
  async lastTrustedProjectPath(): Promise<string | null> {
    const recent = await this.lastProjectPath();
    if (!recent) return null;
    await this.loadTrustedProjects();
    return this.trustedProjects.has(recent) ? recent : null;
  }

  /** Preview only a trusted active project or folders already trusted by this host. */
  async prepareSessionListPath(projectPath: string): Promise<string> {
    const canonical = await canonicalizeProjectPath(projectPath);
    await this.loadTrustedProjects();
    if ((this.currentProject?.trusted && this.currentProject.path === canonical) || this.trustedProjects.has(canonical)) return canonical;
    throw new PiDesktopError({
      code: 'PROJECT_NOT_TRUSTED',
      message: 'Trust this project before previewing its sessions.',
      actionable: 'Open the folder and choose “Trust and open” first.',
      retryable: true,
    });
  }

  /** Deleted known projects can be cleaned up, but cannot be previewed or activated. */
  async prepareKnownProjectCleanupPath(projectPath: string): Promise<string> {
    if (typeof projectPath !== 'string' || projectPath.trim() === '' || projectPath.includes('\0')) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'A project directory is required.', retryable: false });
    }
    const normalized = path.normalize(path.resolve(projectPath));
    await this.loadTrustedProjects();
    const knownPaths = [this.currentProject?.trusted ? this.currentProject.path : null, ...this.trustedProjects].filter((value): value is string => Boolean(value));
    const known = knownPaths.find((candidate) => this.projectPathsMatch(candidate, normalized));
    if (known) return known;
    throw new PiDesktopError({
      code: 'PROJECT_NOT_TRUSTED',
      message: 'Trust this project before managing its saved sessions.',
      actionable: 'Open the folder and choose “Trust and open” first.',
      retryable: true,
    });
  }

  private projectPathsMatch(left: string, right: string): boolean {
    // Preserve host-platform rules; do not weaken matching on case-sensitive volumes.
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  protected async lastProjectPath(): Promise<string | undefined> {
    if (this.currentProject) return this.currentProject.path;
    try {
      const statePath = path.join(this.dataRoot, 'recent-project.json');
      const value = await readBoundedState(statePath, 8_192);
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
      const value = await readBoundedState(target, MAX_TRUST_STATE_BYTES);
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('paths' in value) || !Array.isArray(value.paths)) return;
      const trustedPaths: unknown[] = value.paths;
      if (trustedPaths.length > MAX_TRUSTED_PROJECTS || !trustedPaths.every((trustedPath): trustedPath is string =>
        typeof trustedPath === 'string' && trustedPath.length > 0 && trustedPath.length <= MAX_PROJECT_PATH_CHARACTERS
          && !trustedPath.includes('\0') && path.isAbsolute(trustedPath))) return;
      for (const trustedPath of trustedPaths) this.trustedProjects.add(path.normalize(trustedPath));
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
      throw new PiDesktopError({ code: 'PROJECT_NOT_TRUSTED', message: 'Only a trusted active project can create an isolated worktree session.', retryable: false });
    }
    const canonical = await canonicalizeProjectPath(worktreePath);
    await this.loadTrustedProjects();
    return this.activation({ path: canonical, name: path.basename(source) || source, trusted: true });
  }

  protected async commitActivation(activation: ProjectActivation): Promise<ProjectState> {
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

  private async activation(project: ProjectState, persistDesktopState = true): Promise<ProjectActivation> {
    const previousProject = this.currentProject;
    const previousRecentPath = persistDesktopState ? await this.lastProjectPath() : undefined;
    const trustAlreadyPresent = this.trustedProjects.has(project.path);
    let commitStarted = false;
    let trustAdded = false;
    return {
      project,
      commit: async () => {
        if (commitStarted) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'This project activation was already used.', retryable: false });
        commitStarted = true;
        if (persistDesktopState && project.trusted && !trustAlreadyPresent) {
          this.trustedProjects.add(project.path);
          trustAdded = true;
        }
        this.currentProject = project;
        if (trustAdded) await this.rememberTrustedProjects();
        if (persistDesktopState) await this.rememberProjectPath(project.path);
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
        if (persistDesktopState) {
          try { await this.restoreProjectPath(previousRecentPath); } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Project persistence rollback failed.');
      },
    };
  }

  async validateSelectedFilePath(selected: string, project = this.currentProject): Promise<string> {
    if (!project) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before referencing a file.', retryable: true });
    const canonical = path.normalize(await fs.realpath(selected));
    const relative = path.relative(project.path, canonical);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'Choose a file inside the active project.', actionable: `The active project is ${project.path}.`, retryable: true });
    }
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The selected path is not a file.', retryable: true });
    return relative.split(path.sep).join('/');
  }

  async validateRevealCurrentPath(): Promise<string> {
    const project = this.currentProject;
    if (!project) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before showing it in the file browser.', actionable: 'Open a project, then try again.', retryable: true });
    }
    try {
      const stat = await fs.stat(project.path);
      if (!stat.isDirectory()) throw new Error('The project path is no longer a directory.');
    } catch (error) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: `Cannot show project: ${error instanceof Error ? error.message : 'The project path is not accessible.'}`, actionable: 'Open the project again, then retry.', retryable: true });
    }
    return project.path;
  }
}
