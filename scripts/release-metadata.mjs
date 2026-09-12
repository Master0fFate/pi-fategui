import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const strictSemVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const releaseNameControlPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const numericIdentifierPattern = /^(?:0|[1-9]\d*)$/u;

export function formatReleaseDisplayVersion(version, releaseName) {
  return `V${version}${releaseName ? ` - ${releaseName}` : ''}`;
}

function parseSemanticVersion(value, source) {
  const match = strictSemVerPattern.exec(value);
  if (!match) throw new Error(`${source} is not strict SemVer: ${value}`);
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split('.') ?? null,
  };
}

function comparePrerelease(left, right) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = numericIdentifierPattern.test(leftIdentifier);
    const rightNumeric = numericIdentifierPattern.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function shouldMarkReleaseLatest(candidateVersion, publishedTag) {
  const candidate = parseSemanticVersion(candidateVersion, 'Candidate version');
  if (candidate.prerelease !== null) return false;
  if (publishedTag === undefined || publishedTag === null) return true;
  if (typeof publishedTag !== 'string' || !publishedTag.startsWith('v') || publishedTag !== publishedTag.trim()) {
    throw new Error(`Published release tag is invalid: ${String(publishedTag)}`);
  }
  const published = parseSemanticVersion(publishedTag.slice(1), 'Published release tag');
  return compareSemanticVersions(candidate, published) > 0;
}

export function validateReleaseMetadata(manifest, productionVersion) {
  const versionMatch = manifest && typeof manifest === 'object' && typeof manifest.version === 'string'
    ? strictSemVerPattern.exec(manifest.version)
    : null;
  if (!versionMatch) {
    throw new Error(`package.json version is not strict SemVer: ${String(manifest?.version)}`);
  }
  if (productionVersion !== manifest.version) {
    throw new Error(`PRODVER (${JSON.stringify(productionVersion)}) must exactly match package.json (${manifest.version}).`);
  }
  const releaseName = manifest.releaseName;
  if (releaseName !== undefined && (
    typeof releaseName !== 'string'
    || releaseName.length === 0
    || releaseName.length > 80
    || releaseName !== releaseName.trim()
    || releaseNameControlPattern.test(releaseName)
  )) {
    throw new Error(`package.json releaseName is invalid: ${JSON.stringify(releaseName)}.`);
  }
  return Object.freeze({
    version: manifest.version,
    releaseName,
    displayVersion: formatReleaseDisplayVersion(manifest.version, releaseName),
    tag: `v${manifest.version}`,
    isPrerelease: versionMatch[4] !== undefined,
  });
}

export async function readReleaseMetadata(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const productionVersion = await readFile(path.join(root, 'PRODVER'), 'utf8');
  return validateReleaseMetadata(manifest, productionVersion);
}
