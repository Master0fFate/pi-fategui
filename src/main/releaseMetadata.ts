import manifest from '../../package.json';
import { formatReleaseDisplayVersion } from '../shared/releaseMetadata';

const manifestMetadata = manifest as { version: string; releaseName?: string };
const releaseName = manifestMetadata.releaseName;

export function appReleaseDisplayVersion(version: string): string {
  return formatReleaseDisplayVersion(version, releaseName);
}

export const releaseMetadata = Object.freeze({
  version: manifestMetadata.version,
  ...(releaseName ? { releaseName } : {}),
  displayVersion: appReleaseDisplayVersion(manifestMetadata.version),
});
