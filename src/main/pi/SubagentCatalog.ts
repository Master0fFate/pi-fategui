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
import { visibleModels } from '../../shared/modelVisibility';

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
  disabledModels: readonly string[] = [],
) {
  const [available, profiles, skillCatalog] = await Promise.all([
    modelRuntime.getAvailable(),
    discoverSubagentProfiles(projectPath),
    catalogSubagentSkills(session),
  ]);
  const section = params.section ?? 'all';
  const query = params.query?.trim().toLocaleLowerCase() ?? '';
  const limit = Math.max(1, Math.round(params.limit ?? 200));
  const matchingModels = visibleModels([...available], disabledModels)
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
    'One canonical agent system: spawn_agent and the Team lifecycle/workspace/message tools execute direct or recursive delegation; agent_workflow schedules an acyclic graph through the same Team executor. No separate executor or alternate tool contract is selected.',
    'spawn_agent fields: task, optional teamId, name, role, agent, permission, exact model, thinkingLevel, exact tools, instructions, skills, skillMode, preloadSkills, contextTurns (1-5), and workspace {mode: shared|worktree, baseRef?, branch?}. It creates one direct child; it does not accept workflow routing, advisory clocks, budgets, notifications, or mailbox TTL fields.',
    `agent_workflow-only controls: nodes add id, dependsOn, includeDependencyResults, dependencyFailure, routing.fallbackModels/routing.maxAttempts, advisory timeoutSeconds/idleTimeoutSeconds, advisory budget thresholds, opt-in mailboxTtlSeconds, and notifyParent; the graph adds maxConcurrency and an advisory budget. maxConcurrency defaults to ${DEFAULT_RUNNING_CONCURRENCY} when omitted and remains an upper bound subject to Team admission.`,
    'Routing and liveness: an omitted node model inherits the primary selection before exact opt-in fallbacks. Runtime, observable-Team-idle, turn, token, and cost thresholds only record inspector checkpoints; they never abort, retry, skip, or pause work. Cancellation stops routing retries.',
    'Capacity and transport: each team permits depth 2, 16 live unreleased non-root nodes, and 3 active turns; the project permits 64 live non-root nodes across teams. Finite history bounds are 512 nodes/tasks/receipts and 256 message envelopes, entries are not evicted to admit a workflow, and each Team envelope is limited to 32 KiB UTF-8. Workflow preflight may explicitly reject a graph whose retained-node or configured routing footprint cannot fit; logical DAG size is not capped at 16 when settled nodes release capacity.',
    'Messaging: send_message persists bounded non-executable information. queue waits for the recipient turn to settle without waking an idle agent; steer injects into a streaming turn. followup_task creates executable work only for an owned direct child and reuses its retained Pi context. interrupt_agent stops a turn; close_agent retains history; release_agent frees live capacity.',
    'Results and files are separate: a task result is bounded text transported through the Team ledger. includeDependencyResults opts dependency text into a later workflow prompt as untrusted evidence. Shared-workspace files are already in the shared checkout; isolated worktree files never transfer or integrate automatically. A successful execution whose result transport fails is reported as result-unavailable and is never replayed to reconstruct output.',
    'Workspace policy: omitted workspace uses the live global preference; soft policy permits an explicit override and strict policy rejects incompatible admission. Shared inherits the direct caller checkout. Worktree starts from committed history and requires explicit agent_workspace review/checkpoint/integration/cleanup; uncommitted parent changes stay behind. Worktrees are not security sandboxes and cleanup retains the branch.',
    'Completion notifications: never sends nothing; next-turn queues model-visible parent context; immediate triggers a parent turn or queues it behind streaming. Liveness reports remain inspector telemetry and do not trigger turns.',
    'Skills and authority: all exposes discovered skills, selected exposes only named skills, and none disables them; preloadSkills controls selected body preloading. Descendant permission and tools can only narrow the caller, writer leases are per checkout, and explicit requested capabilities are refused rather than silently dropped.',
    'Selection precedence: explicit model > agent profile model > inherited parent model. Explicit model constraints are binding; Fate does not infer replacements.',
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
