import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { SubagentRole } from '../../shared/contracts/ipc';

const MAX_PROFILE_FILES = 200;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PROFILE_NAME = 80;
const MAX_PROFILE_DESCRIPTION = 500;
const MAX_PROFILE_MODEL = 500;
const MAX_PROFILE_TOOLS = 20;

export type SubagentAgentSource = 'direct' | 'user' | 'project';

export interface SubagentProfile {
  selector: string;
  name: string;
  description: string;
  source: SubagentAgentSource;
  systemPrompt: string;
  tools?: string[];
  modelReference?: string;
  role?: SubagentRole;
  filePath?: string;
}

export const directSubagentProfile: SubagentProfile = {
  selector: 'direct',
  name: 'direct',
  description: 'An unopinionated child session configured entirely by the launch specification.',
  source: 'direct',
  systemPrompt: '',
};

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(cleaned) ? cleaned : undefined;
}

function profileRole(value: unknown): SubagentRole | undefined {
  return cleanString(value, MAX_PROFILE_NAME);
}

function profileTools(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const tools = [...new Set(raw
    .flatMap((item) => typeof item === 'string' ? [item.trim()] : [])
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, MAX_PROFILE_TOOLS))];
  return tools.length ? tools : undefined;
}

async function loadProfiles(directory: string, source: 'user' | 'project', projectRoot?: string): Promise<SubagentProfile[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }

  let canonicalProjectRoot: string | undefined;
  if (projectRoot) {
    try { canonicalProjectRoot = await fs.realpath(projectRoot); } catch { return []; }
  }
  const profiles: SubagentProfile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_PROFILE_FILES)) {
    if (!entry.name.toLowerCase().endsWith('.md') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const canonical = await fs.realpath(filePath);
      if (canonicalProjectRoot && !isContained(canonicalProjectRoot, canonical)) continue;
      const stat = await fs.stat(canonical);
      if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) continue;
      const content = await fs.readFile(canonical, 'utf8');
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
      const name = cleanString(frontmatter.name, MAX_PROFILE_NAME);
      const description = cleanString(frontmatter.description, MAX_PROFILE_DESCRIPTION);
      if (!name || !description || /[\\/]/u.test(name)) continue;
      const modelReference = cleanString(frontmatter.model, MAX_PROFILE_MODEL);
      const tools = profileTools(frontmatter.tools);
      const role = profileRole(frontmatter.role);
      profiles.push({
        selector: `${source}/${name}`,
        name,
        description,
        source,
        systemPrompt: body.trim().slice(0, MAX_PROFILE_BYTES),
        ...(tools ? { tools } : {}),
        ...(modelReference ? { modelReference } : {}),
        ...(role ? { role } : {}),
        filePath: canonical,
      });
    } catch {
      // A malformed or concurrently removed profile is omitted from discovery.
    }
  }
  return profiles;
}

export async function discoverSubagentProfiles(projectPath: string): Promise<SubagentProfile[]> {
  const [user, project] = await Promise.all([
    loadProfiles(path.join(getAgentDir(), 'agents'), 'user'),
    loadProfiles(path.join(projectPath, CONFIG_DIR_NAME, 'agents'), 'project', projectPath),
  ]);
  return [directSubagentProfile, ...user, ...project];
}

export function resolveSubagentProfile(
  profiles: readonly SubagentProfile[],
  selector: string | undefined,
  _fallbackRole?: SubagentRole,
): SubagentProfile | undefined {
  if (!selector) return profiles.find((profile) => profile.source === 'direct') ?? directSubagentProfile;
  const normalized = selector.trim();
  if (normalized.includes('/')) return profiles.find((profile) => profile.selector === normalized);
  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    if (profiles[index]?.name === normalized) return profiles[index];
  }
  return undefined;
}
