import type { FilesystemService } from '../../main/files/FilesystemService';
import type { GitService } from '../../main/git/GitService';
import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import type { WorkspaceAdmissionPort } from './WorkspaceAdmissionQueue';

/** A host-owned binding, never a path or an authority grant supplied in a command. */
export interface WorkspaceHandle {
  readonly id: string;
  readonly generation: number;
  readonly root: string;
  readonly files: FilesystemService;
  readonly git: GitService;
  readonly runtime: PiRuntimeService;
  readonly admission: WorkspaceAdmissionPort<PiRuntimeService>;
}
