import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSubagentProfiles, resolveSubagentProfile } from './SubagentProfiles';

const temporaryDirectories: string[] = [];

async function project(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-subagent-profiles-'));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, '.pi', 'agents'), { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('SubagentProfiles', () => {
  it('discovers bounded trusted-project Pi agents and preserves explicit source selectors', async () => {
    const directory = await project();
    await fs.writeFile(path.join(directory, '.pi', 'agents', 'security-reviewer.md'), [
      '---',
      'name: security-reviewer',
      'description: Review authentication boundaries',
      'role: reviewer',
      'tools: read, bash, unknown-tool',
      'model: alternate/glm',
      '---',
      'Inspect defensively and return evidence.',
    ].join('\n'));

    const profiles = await discoverSubagentProfiles(directory);
    const profile = profiles.find((candidate) => candidate.selector === 'project/security-reviewer');

    expect(profile).toMatchObject({
      name: 'security-reviewer',
      source: 'project',
      role: 'reviewer',
      tools: ['read', 'bash', 'unknown-tool'],
      modelReference: 'alternate/glm',
      systemPrompt: 'Inspect defensively and return evidence.',
    });
    expect(resolveSubagentProfile(profiles, 'project/security-reviewer', 'scout')).toBe(profile);
    expect(resolveSubagentProfile(profiles, 'security-reviewer', 'scout')).toBe(profile);
    expect(resolveSubagentProfile(profiles, undefined, 'reviewer')).toMatchObject({ selector: 'direct', source: 'direct', systemPrompt: '' });
  });

  it('ignores malformed, oversized, and path-ambiguous profile definitions', async () => {
    const directory = await project();
    const agents = path.join(directory, '.pi', 'agents');
    await fs.writeFile(path.join(agents, 'missing-description.md'), '---\nname: incomplete\n---\nPrompt');
    await fs.writeFile(path.join(agents, 'slash.md'), '---\nname: bad/name\ndescription: invalid selector\n---\nPrompt');
    await fs.writeFile(path.join(agents, 'oversized.md'), `---\nname: huge\ndescription: too large\n---\n${'x'.repeat(70_000)}`);

    const projectProfiles = (await discoverSubagentProfiles(directory)).filter((profile) => profile.source === 'project');
    expect(projectProfiles).toEqual([]);
  });
});
