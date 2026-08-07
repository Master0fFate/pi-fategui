import { promises as fs } from 'node:fs';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SubagentSkillMode } from '../../shared/contracts/ipc';
import { childToolNames, type ChildToolName } from './SubagentProtocol';

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_PRELOADED_SKILL_BYTES = 1024 * 1024;

interface PiSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo?: { source?: string; scope?: string; origin?: string };
}

export interface SubagentSkillInfo {
  name: string;
  description: string;
  source: string;
  scope: string;
  disableModelInvocation: boolean;
  compatibility?: string;
  allowedTools: string[];
  requiredTools: string[];
}

export interface SelectedSubagentSkill extends SubagentSkillInfo {
  filePath: string;
  baseDir: string;
  content?: string;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/u)
      : [];
  return [...new Set(values.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []))].slice(0, 64);
}

async function skillMetadata(skill: PiSkill): Promise<SubagentSkillInfo> {
  let frontmatter: Record<string, unknown> = {};
  try {
    const stat = await fs.stat(skill.filePath);
    if (stat.isFile() && stat.size <= MAX_SKILL_FILE_BYTES) {
      const parsed = parseFrontmatter<Record<string, unknown>>(await fs.readFile(skill.filePath, 'utf8'));
      frontmatter = parsed.frontmatter;
    }
  } catch {
    // The loader's discovered metadata remains useful when the file changes concurrently.
  }
  const requiredTools = stringList(frontmatter['required-tools']);
  const compatibility = typeof frontmatter.compatibility === 'string' && frontmatter.compatibility.trim()
    ? frontmatter.compatibility.trim().slice(0, 500)
    : undefined;
  return {
    name: skill.name,
    description: skill.description.slice(0, 2_000),
    source: skill.sourceInfo?.source ?? 'unknown',
    scope: skill.sourceInfo?.scope ?? 'unknown',
    disableModelInvocation: skill.disableModelInvocation,
    ...(compatibility ? { compatibility } : {}),
    allowedTools: stringList(frontmatter['allowed-tools']),
    requiredTools,
  };
}

export function discoveredSkills(session: AgentSession): PiSkill[] {
  const loader = session.resourceLoader;
  if (!loader) return [];
  return [...loader.getSkills().skills] as PiSkill[];
}

export async function catalogSubagentSkills(session: AgentSession): Promise<SubagentSkillInfo[]> {
  const skills = discoveredSkills(session);
  return Promise.all(skills.map(skillMetadata));
}

export async function selectSubagentSkills(
  session: AgentSession,
  names: readonly string[],
  mode: SubagentSkillMode,
  preload: boolean,
): Promise<SelectedSubagentSkill[]> {
  if (mode === 'none') return [];
  const available = discoveredSkills(session);
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const selected: SelectedSubagentSkill[] = [];
  let preloadedBytes = 0;
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) throw new Error(`Pi skill ${name} is not available to this parent session. Call subagent_catalog with section skills for exact names.`);
    const metadata = await skillMetadata(skill);
    let content: string | undefined;
    if (preload) {
      const stat = await fs.stat(skill.filePath);
      if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES || preloadedBytes + stat.size > MAX_PRELOADED_SKILL_BYTES) {
        throw new Error(`Pi skill ${name} exceeds the bounded preload budget.`);
      }
      content = await fs.readFile(skill.filePath, 'utf8');
      preloadedBytes += Buffer.byteLength(content, 'utf8');
    }
    selected.push({ ...metadata, filePath: skill.filePath, baseDir: skill.baseDir, ...(content === undefined ? {} : { content }) });
  }
  return selected;
}

export function assertSkillTools(skills: readonly SelectedSubagentSkill[], enabledTools: readonly ChildToolName[]): void {
  const enabled = new Set(enabledTools);
  for (const skill of skills) {
    const unsupported = skill.requiredTools.filter((tool) => !(childToolNames as readonly string[]).includes(tool));
    if (unsupported.length) throw new Error(`Pi skill ${skill.name} requires tools unavailable to isolated Fate children: ${unsupported.join(', ')}.`);
    const missing = skill.requiredTools.filter((tool) => !enabled.has(tool as ChildToolName));
    if (missing.length) throw new Error(`Pi skill ${skill.name} requires child tools that are not enabled: ${missing.join(', ')}.`);
  }
}

export function filterSkillsForChild<T extends { name: string }>(
  skills: readonly T[],
  mode: SubagentSkillMode,
  selectedNames: readonly string[],
): T[] {
  if (mode === 'none') return [];
  if (mode === 'all') return [...skills];
  const selected = new Set(selectedNames);
  return skills.filter((skill) => selected.has(skill.name));
}
