import type { BrowserWindow } from 'electron';
import type { ProjectState } from '../../shared/contracts/ipc';
import { desktopFateDataRoot } from '../../core/FatePaths';
import { ProjectTrustService, type ProjectActivation } from '../../core/projects/ProjectTrustService';
import { PiDesktopError } from '../pi/errors';
import { DesktopProjectAdapter } from './DesktopProjectAdapter';

export { canonicalizeProjectPath, type ProjectActivation } from '../../core/projects/ProjectTrustService';

/** Desktop compatibility facade. It retains the existing callers and single trust writer. */
export class ProjectService extends ProjectTrustService {
  constructor(dataRoot = desktopFateDataRoot(), private readonly desktop = new DesktopProjectAdapter()) {
    super(dataRoot);
  }

  async select(owner?: BrowserWindow): Promise<ProjectState | null> {
    const activation = await this.prepareSelect(owner);
    return activation ? this.commitActivation(activation) : null;
  }

  async prepareSelect(owner?: BrowserWindow): Promise<ProjectActivation | null> {
    const selected = await this.desktop.selectProject(await this.lastProjectPath(), owner);
    return selected ? this.prepareOpenPath(selected, owner) : null;
  }

  async openPath(projectPath: string, owner?: BrowserWindow): Promise<ProjectState | null> {
    const activation = await this.prepareOpenPath(projectPath, owner);
    return activation ? this.commitActivation(activation) : null;
  }

  async prepareOpenPath(projectPath: string, owner?: BrowserWindow): Promise<ProjectActivation | null> {
    return this.prepareProjectPath(projectPath, this.desktop.trustDecision(owner));
  }

  async revealPath(projectPath: string): Promise<{ opened: true }> {
    return this.desktop.revealProject(await this.prepareSessionListPath(projectPath));
  }

  async selectFile(owner?: BrowserWindow): Promise<string | null> {
    const project = this.getCurrent();
    if (!project) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before referencing a file.', retryable: true });
    const selected = await this.desktop.selectFile(project.path, owner);
    return selected ? this.validateSelectedFilePath(selected, project) : null;
  }

  async revealCurrent(openPath?: (projectPath: string) => Promise<string>): Promise<{ opened: true }> {
    return this.desktop.revealProject(await this.validateRevealCurrentPath(), openPath);
  }
}
