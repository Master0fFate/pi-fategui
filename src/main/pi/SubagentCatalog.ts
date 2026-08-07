import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelInfo, SubagentAgentSource, SubagentRole } from '../../shared/contracts/ipc';
import { discoverSubagentProfiles } from './SubagentProfiles';
import { catalogSubagentSkills } from './SubagentSkills';
import {
  DEFAULT_RUNNING_CONCURRENCY,
  modelInfo,
  modelKey,
  modelThinkingLevels,
  type ParentModel,
} from './SubagentProtocol';

export interface CatalogDetails {
  kind: 'fate-subagent-catalog';
  version: 2;
  models: ModelInfo[];
  agents: Array<{
    selector: string;
    name: string;
    description: string;
    source: SubagentAgentSource;
    role?: SubagentRole;
    tools?: string[];
    modelReference?: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
    source: string;
    scope: string;
    disableModelInvocation: boolean;
    compatibility?: string;
    allowedTools: string[];
    requiredTools: string[];
  }>;
}

export async function buildSubagentCatalog(
  projectPath: string,
  session: AgentSession,
  modelRuntime: ModelRuntime,
  params: { section?: 'all' | 'models' | 'agents' | 'skills' | 'capabilities'; query?: string; provider?: string; limit?: number },
) {
  const [available, profiles, skillCatalog] = await Promise.all([
    modelRuntime.getAvailable(),
    discoverSubagentProfiles(projectPath),
    catalogSubagentSkills(session),
  ]);
  const section = params.section ?? 'all';
  const query = params.query?.trim().toLocaleLowerCase() ?? '';
  const limit = Math.max(1, Math.round(params.limit ?? 200));
  const matchingModels = [...available]
    .filter((model) => !params.provider || model.provider === params.provider)
    .filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  const matchingProfiles = profiles
    .filter((profile) => profile.source !== 'direct')
    .filter((profile) => !query || `${profile.selector} ${profile.description}`.toLocaleLowerCase().includes(query));
  const matchingSkills = skillCatalog
    .filter((skill) => !query || `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selectedModels = section === 'all' || section === 'models' ? matchingModels.slice(0, limit) : [];
  const models = selectedModels.map((model) => modelInfo(model as ParentModel));
  const agents = section === 'all' || section === 'agents' ? matchingProfiles.slice(0, limit).map((profile) => ({
    selector: profile.selector,
    name: profile.name,
    description: profile.description,
    source: profile.source,
    ...(profile.role ? { role: profile.role } : {}),
    ...(profile.tools ? { tools: profile.tools } : {}),
    ...(profile.modelReference ? { modelReference: profile.modelReference } : {}),
  })) : [];
  const skills = section === 'all' || section === 'skills' ? matchingSkills.slice(0, limit) : [];
  const currentKey = session.model ? modelKey(session.model) : '';
  const modelLines = models.map((model, index) => {
    const current = modelKey(model as ParentModel) === currentKey ? ' · parent' : '';
    const selected = selectedModels[index]!;
    const pricing = selected.cost.input || selected.cost.output ? ` · $/1M in:${selected.cost.input} out:${selected.cost.output}` : '';
    return `- ${model.provider}/${model.id} · ${model.name} · thinking:${modelThinkingLevels(selected as ParentModel).join(',')} · context:${model.contextWindow}${pricing}${current}`;
  });
  const agentLines = agents.map((agent) => `- ${agent.selector} · ${agent.description}${agent.role ? ` · role:${agent.role}` : ''}${agent.modelReference ? ` · model:${agent.modelReference}` : ''}${agent.tools ? ` · tools:${agent.tools.join(',')}` : ''}`);
  const skillLines = skills.map((skill) => `- ${skill.name} · ${skill.description} · ${skill.scope}/${skill.source}${skill.disableModelInvocation ? ' · explicit-only' : ''}${skill.requiredTools.length ? ` · requires:${skill.requiredTools.join(',')}` : ''}`);
  const capabilities = [
    'Child specification fields: task, agent, role label, permission, exact model, thinkingLevel, exact tools, instructions, skills, skillMode, preloadSkills, timeoutSeconds, idleTimeoutSeconds, mailboxTtlSeconds, notifyParent, budget, routing.',
    'Skill modes: all exposes discovered skills; selected exposes only named skills; none disables skills. Selected bodies preload when preloadSkills is true. Prompt templates and child extensions are disabled.',
    'Routing: model is the first exact model. routing.fallbackModels is an ordered opt-in list. routing.maxAttempts retries failed provider/model turns; neither list length nor attempt count has a policy ceiling.',
    'Resource and turn thresholds: maxCostUsd, maxInputTokens, maxOutputTokens, maxTotalTokens, and maxTurns are advisory liveness checkpoints. Crossing any threshold records inspector telemetry and never stops a child or workflow.',
    'Mailboxes: successful managed children default softly to 300 seconds of follow-up retention when mailboxTtlSeconds is omitted; workflow node mailboxes are opt-in. Zero disables retention, any positive duration is accepted, retarget can configure an idle mailbox, and close releases it.',
    'Completion notifications: never; next-turn adds model-visible parent context without starting a turn; immediate triggers a parent turn or queues a follow-up if the parent is streaming. Liveness remains inspector-only telemetry.',
    `Workflows: arbitrary acyclic nodes, dependsOn, includeDependencyResults, dependencyFailure, per-node child specs, maxConcurrency, workflow budget, persistence, cancellation, and explicit post-restart resume. maxConcurrency defaults softly to ${DEFAULT_RUNNING_CONCURRENCY} only when omitted. Node mailboxes are opt-in.`,
    'Autonomy: direct batches, workflow size, concurrent children, selected skills, routing attempts, and configured durations have no policy ceiling. Honor explicit user counts exactly. When unconstrained, prefer four or fewer concurrent children as a soft planning default, then scale when independent work benefits.',
    'Liveness: timeoutSeconds and idleTimeoutSeconds are opt-in advisory telemetry thresholds, never automatic stops. Progress, sustained low-diversity repetition, liberal checkpoints, and adaptive turn thresholds produce structured inspector reports without triggering parent model turns.',
    'Authority: permission and exact tools define capability, not a hidden concurrency tier. Coordinate overlapping writes in prompts or dependencies instead of silently reducing team size.',
    'Selection precedence: explicit model > agent profile model > parent model. Explicit user model constraints are binding; Fate does not infer replacements.',
  ];
  const blocks = [
    ...(section === 'all' || section === 'models' ? [`Authenticated Pi models (${models.length}${matchingModels.length > models.length ? ` of ${matchingModels.length}` : ''})`, ...(modelLines.length ? modelLines : ['- none']), ''] : []),
    ...(section === 'all' || section === 'agents' ? [`Reusable Pi agents (${agents.length}${matchingProfiles.length > agents.length ? ` of ${matchingProfiles.length}` : ''})`, ...(agentLines.length ? agentLines : ['- none']), ''] : []),
    ...(section === 'all' || section === 'skills' ? [`Pi skills (${skills.length}${matchingSkills.length > skills.length ? ` of ${matchingSkills.length}` : ''})`, ...(skillLines.length ? skillLines : ['- none']), ''] : []),
    ...(section === 'all' || section === 'capabilities' ? ['Capability contract', ...capabilities] : []),
  ];
  return {
    content: [{ type: 'text' as const, text: blocks.join('\n') }],
    details: { kind: 'fate-subagent-catalog' as const, version: 2 as const, models, agents, skills },
  };
}
