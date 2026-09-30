import { ProjectService } from '../projects/ProjectService';

/** The native initial-restore callback must not even look up a local project for a remote target. */
export class TargetProjectService extends ProjectService {
  constructor(private readonly localTarget: () => boolean) { super(); }
  override async lastTrustedProjectPath(): Promise<string | null> {
    if (!this.localTarget()) return null;
    const result = await super.lastTrustedProjectPath();
    return this.localTarget() ? result : null;
  }
}
