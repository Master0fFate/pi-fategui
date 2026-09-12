export function formatReleaseDisplayVersion(version: string, releaseName?: string): string {
  return `V${version}${releaseName ? ` - ${releaseName}` : ''}`;
}
