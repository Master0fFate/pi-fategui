import { shell } from 'electron';
import { UnsupportedHostCapabilityError, type HostFileReference, type LocalFileActionsPort } from '../../core/ports';

/** Receives only files already validated by the local host's file service. */
export class DesktopFileActions implements LocalFileActionsPort {
  private localPath(file: HostFileReference): string {
    // Never turn a remote host's valid path into a local shell action.
    if (file.origin !== 'local') throw new UnsupportedHostCapabilityError('local-file-actions');
    return file.path;
  }

  async openPath(file: HostFileReference): Promise<string> {
    return shell.openPath(this.localPath(file));
  }

  showItemInFolder(file: HostFileReference): void {
    shell.showItemInFolder(this.localPath(file));
  }
}
