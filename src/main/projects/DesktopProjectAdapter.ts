import { dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron';
import type { ProjectTrustPort } from '../../core/ports';
import { PiDesktopError } from '../pi/errors';

/** Native UI stays here; the portable trust store never receives a BrowserWindow. */
export class DesktopProjectAdapter {
  async selectProject(defaultPath?: string, owner?: BrowserWindow): Promise<string | null> {
    const options: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Open project in Fate UI',
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  trustDecision(owner?: BrowserWindow): ProjectTrustPort {
    return {
      decide: async ({ name }) => {
        const prompt = {
          type: 'warning' as const,
          title: 'Trust this project?',
          message: `Do you trust “${name}”?`,
          detail: `New Pi sessions start in Edit files mode: Fate's file tools stay confined to this project and agent shell execution is disabled. Valid saved session permissions restore within the host limit. Full access requires an explicit choice and confirmation in the composer. Trusted project settings, skills, prompts, and configured packages may be loaded. Fate UI still blocks project-local extensions. Commands in the manual terminal remain under your control and are not confined by the agent permission level.`,
          buttons: ['Trust and open', 'Open without Pi', 'Cancel'],
          defaultId: 2,
          cancelId: 2,
          noLink: true,
        };
        const confirmation = owner ? await dialog.showMessageBox(owner, prompt) : await dialog.showMessageBox(prompt);
        return confirmation.response === 2 ? 'cancel' : confirmation.response === 0 ? 'trust' : 'open-without-pi';
      },
    };
  }

  async selectFile(projectPath: string, owner?: BrowserWindow): Promise<string | null> {
    const options: OpenDialogOptions = { properties: ['openFile'], title: 'Reference a project file', defaultPath: projectPath };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async revealProject(projectPath: string, openPath: (projectPath: string) => Promise<string> = shell.openPath): Promise<{ opened: true }> {
    const failure = await openPath(projectPath);
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
