import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getAgentDir, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import type { ProjectState } from '../../shared/contracts/ipc';
import { PiDesktopError } from '../pi/errors';

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

export class ProjectService {
  private readonly trustStore = new ProjectTrustStore(getAgentDir());
  private currentProject: ProjectState | null = null;

  async select(owner?: BrowserWindow): Promise<ProjectState | null> {
    const options: OpenDialogOptions = { properties: ['openDirectory'], title: 'Open project in Pi Desktop' };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    const canonical = await canonicalizeProjectPath(selected);
    let trusted = this.trustStore.get(canonical) === true;

    if (!trusted) {
      const prompt = {
        type: 'warning' as const,
        title: 'Trust this project?',
        message: `Do you trust “${path.basename(canonical)}”?`,
        detail: `Pi may read and modify files and run project tools in:\n${canonical}\n\nOnly trust repositories whose contents you understand.`,
        buttons: ['Trust and open', 'Open without Pi', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      };
      const confirmation = owner ? await dialog.showMessageBox(owner, prompt) : await dialog.showMessageBox(prompt);
      if (confirmation.response === 2) return null;
      trusted = confirmation.response === 0;
      if (trusted) this.trustStore.set(canonical, true);
    }

    this.currentProject = { path: canonical, name: path.basename(canonical) || canonical, trusted };
    return this.currentProject;
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
}
