import type {
  SubagentChildEvent,
  SubagentLivenessReport,
  SubagentRun,
  SubagentUsage,
} from '../../shared/contracts/ipc';
import { subagentDisplayName, subagentHandle } from '../../shared/subagentIdentity';

export const LIVENESS_REPORT_COOLDOWN_MS = 5 * 60_000;
export const REPETITION_WINDOW = 16;
export const REPETITION_THRESHOLD = 10;
export const REPEATED_ERROR_THRESHOLD = 12;
export const CHECKPOINT_TOOL_INTERVAL = 48;
export const DEFAULT_SOFT_TURN_THRESHOLD = 64;

interface ToolObservation {
  key: string;
  outcome: string;
  label: string;
  error: boolean;
  timestamp: number;
}

interface ProgressObservation {
  timestamp: number;
  summary: string;
}

export interface SubagentLivenessState {
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  activities: number;
  toolCalls: number;
  softTurnThreshold: number;
  nextCheckpointToolCount: number;
  recentTools: ToolObservation[];
  recentProgress: ProgressObservation[];
  reportedRepetition?: string;
  reportedResources: string[];
  reportSequence: number;
}

function normalizeFingerprint(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/0x[0-9a-f]+/gu, '<hex>')
    .replace(/\b\d{7,}\b/gu, '<number>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 800);
}

function baseSoftTurnThreshold(run: SubagentRun): number {
  if (run.budget?.maxTurns !== undefined) return run.budget.maxTurns;
  let threshold = DEFAULT_SOFT_TURN_THRESHOLD;
  if (run.enabledTools.some((tool) => tool === 'edit' || tool === 'write' || tool === 'generate_image')) threshold += 32;
  if (run.task.length >= 1_000) threshold += 32;
  if (run.executionMode === 'workflow') threshold += 32;
  return threshold;
}

export function createSubagentLivenessState(run: SubagentRun, startedAt: number): SubagentLivenessState {
  return {
    startedAt,
    lastActivityAt: startedAt,
    lastProgressAt: startedAt,
    activities: 0,
    toolCalls: 0,
    softTurnThreshold: baseSoftTurnThreshold(run),
    nextCheckpointToolCount: CHECKPOINT_TOOL_INTERVAL,
    recentTools: [],
    recentProgress: [],
    reportedResources: [],
    reportSequence: 0,
  };
}

function recordProgress(state: SubagentLivenessState, timestamp: number, summary: string): void {
  state.lastProgressAt = timestamp;
  state.recentProgress.push({ timestamp, summary: summary.slice(0, 1_000) });
  state.recentProgress = state.recentProgress.slice(-8);
  delete state.reportedRepetition;
}

function checkpointSummary(state: SubagentLivenessState, run: SubagentRun, usage: SubagentUsage): string {
  const progress = state.recentProgress.length
    ? state.recentProgress.map((item) => `- ${item.summary}`).join('\n')
    : '- No objective file change or novel successful tool result was observed in the retained window.';
  const activeTool = [...run.tools].reverse().find((tool) => tool.status === 'running');
  return [
    `Child remains ${run.status}; it has used ${usage.turns} assistant turns and completed ${state.toolCalls} tool calls.`,
    `Recent objective progress:\n${progress}`,
    activeTool ? `Current activity: ${activeTool.name} is still running.` : 'Current activity: no tool is presently marked running.',
  ].join('\n');
}

function report(
  state: SubagentLivenessState,
  run: SubagentRun,
  usage: SubagentUsage,
  trigger: SubagentLivenessReport['trigger'],
  reason: string,
  evidence: SubagentLivenessReport['evidence'],
  detectedAt: number,
  repeatedOccurrences = 0,
  idleForMs?: number,
): SubagentLivenessReport {
  state.reportSequence += 1;
  return {
    id: `${run.id}:${trigger}:${state.reportSequence}`,
    trigger,
    reason,
    evidence,
    recentProgress: state.recentProgress.map((item) => item.summary),
    counters: {
      turns: usage.turns,
      activities: state.activities,
      toolCalls: state.toolCalls,
      repeatedOccurrences,
      softTurnThreshold: state.softTurnThreshold,
    },
    timing: {
      detectedAt,
      startedAt: state.startedAt,
      lastActivityAt: state.lastActivityAt,
      lastProgressAt: state.lastProgressAt,
      ...(idleForMs === undefined ? {} : { idleForMs }),
      cooldownMs: LIVENESS_REPORT_COOLDOWN_MS,
    },
    child: {
      runId: run.id,
      handle: subagentHandle(run),
      displayName: subagentDisplayName(run),
      role: run.role,
      task: run.task,
    },
    checkpointSummary: checkpointSummary(state, run, usage),
    recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
  };
}

function observeCompletedTool(
  state: SubagentLivenessState,
  event: Extract<SubagentChildEvent, { type: 'tool.completed' }>,
  run: SubagentRun,
  usage: SubagentUsage,
): SubagentLivenessReport | undefined {
  state.toolCalls += 1;
  const tool = run.tools.find((candidate) => candidate.id === event.toolCallId);
  const input = normalizeFingerprint(tool?.input ?? '');
  const output = normalizeFingerprint(event.output);
  const key = `${event.name.toLocaleLowerCase()}\0${input}`;
  const outcome = `${event.error ? 'error' : 'success'}\0${output}`;
  const previousSameKey = [...state.recentTools].reverse().find((item) => item.key === key);
  const mutating = !event.error && ['edit', 'write', 'generate_image'].includes(event.name.toLocaleLowerCase());
  const novelSuccess = !event.error && previousSameKey !== undefined && previousSameKey.outcome !== outcome;
  const firstSuccessfulObservation = !event.error && previousSameKey === undefined;
  if (mutating || novelSuccess || firstSuccessfulObservation) {
    const detail = mutating
      ? `${event.name} completed a project-changing operation.`
      : previousSameKey
        ? `${event.name} produced a new successful result for a previously observed input.`
        : `${event.name} completed a new successful input.`;
    recordProgress(state, event.timestamp, detail);
  }

  const observation: ToolObservation = {
    key,
    outcome,
    label: `${event.name}(${input.slice(0, 180) || 'no input'})`,
    error: event.error,
    timestamp: event.timestamp,
  };
  state.recentTools.push(observation);
  state.recentTools = state.recentTools.slice(-REPETITION_WINDOW);

  const matching = state.recentTools.filter((item) => item.key === key && item.outcome === outcome);
  const threshold = event.error ? REPEATED_ERROR_THRESHOLD : REPETITION_THRESHOLD;
  const signature = `${key}\0${outcome}`;
  const diversity = new Set(state.recentTools.map((item) => `${item.key}\0${item.outcome}`)).size;
  const firstMatch = matching[0];
  if (
    matching.length < threshold
    || diversity > 3
    || !firstMatch
    || state.lastProgressAt > firstMatch.timestamp
    || state.reportedRepetition === signature
  ) return undefined;

  state.reportedRepetition = signature;
  const signal = event.error ? 'repeated-error' as const : 'repeated-tool' as const;
  return report(
    state,
    run,
    usage,
    'repetition',
    `Sustained low-diversity repetition is suspected after ${matching.length} materially identical ${event.error ? 'errors' : 'tool results'} without intervening objective progress. The child was not paused or terminated.`,
    [{ signal, detail: `${observation.label} returned the same normalized ${event.error ? 'error' : 'result'} repeatedly.`, count: matching.length }],
    event.timestamp,
    matching.length,
  );
}

export function resourceLivenessReports(
  state: SubagentLivenessState,
  run: SubagentRun,
  usage: SubagentUsage,
  detectedAt: number,
): SubagentLivenessReport[] {
  const budget = run.budget;
  if (!budget) return [];
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const candidates: Array<{
    key: string;
    crossed: boolean;
    signal: 'cost-threshold' | 'input-token-threshold' | 'output-token-threshold' | 'total-token-threshold';
    detail: string;
    count?: number;
  }> = [
    {
      key: 'maxCostUsd',
      crossed: budget.maxCostUsd !== undefined && usage.cost > budget.maxCostUsd,
      signal: 'cost-threshold',
      detail: `Observed cost $${usage.cost.toFixed(6)} crossed the advisory $${budget.maxCostUsd?.toFixed(6) ?? '0'} threshold.`,
    },
    {
      key: 'maxInputTokens',
      crossed: budget.maxInputTokens !== undefined && usage.input > budget.maxInputTokens,
      signal: 'input-token-threshold',
      detail: `Observed ${usage.input} input tokens crossed the advisory ${budget.maxInputTokens ?? 0} threshold.`,
      count: usage.input,
    },
    {
      key: 'maxOutputTokens',
      crossed: budget.maxOutputTokens !== undefined && usage.output > budget.maxOutputTokens,
      signal: 'output-token-threshold',
      detail: `Observed ${usage.output} output tokens crossed the advisory ${budget.maxOutputTokens ?? 0} threshold.`,
      count: usage.output,
    },
    {
      key: 'maxTotalTokens',
      crossed: budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens,
      signal: 'total-token-threshold',
      detail: `Observed ${totalTokens} aggregate tokens crossed the advisory ${budget.maxTotalTokens ?? 0} threshold.`,
      count: totalTokens,
    },
  ];
  const newlyCrossed = candidates.filter((candidate) => candidate.crossed && !state.reportedResources.includes(candidate.key));
  if (!newlyCrossed.length) return [];
  state.reportedResources.push(...newlyCrossed.map((candidate) => candidate.key));
  return [report(
    state,
    run,
    usage,
    'resource-limit',
    'One or more configured resource thresholds were crossed. They are advisory only: the child continues and the parent chooses any next step.',
    newlyCrossed.map((candidate) => ({
      signal: candidate.signal,
      detail: candidate.detail,
      ...(candidate.count === undefined ? {} : { count: candidate.count }),
    })),
    detectedAt,
  )];
}

/** Observe normalized child activity. Reports are advisory and this module never controls execution. */
export function observeSubagentLiveness(
  state: SubagentLivenessState,
  event: SubagentChildEvent,
  run: SubagentRun,
  usage: SubagentUsage,
): SubagentLivenessReport[] {
  state.activities += 1;
  state.lastActivityAt = Math.max(state.lastActivityAt, event.timestamp);
  const reports: SubagentLivenessReport[] = [];

  if (event.type === 'tool.completed') {
    const repetition = observeCompletedTool(state, event, run, usage);
    if (repetition) reports.push(repetition);
  }

  if (usage.turns > state.softTurnThreshold) {
    const crossed = state.softTurnThreshold;
    const recentProgressCount = state.recentProgress.filter((item) => item.timestamp >= state.startedAt).length;
    state.softTurnThreshold = usage.turns + (recentProgressCount >= 3 ? 64 : 32);
    reports.push(report(
      state,
      run,
      usage,
      'adaptive-limit',
      `The child crossed the advisory ${crossed}-turn threshold. This is a checkpoint signal, not a budget failure; execution continues while the parent decides.`,
      [{ signal: 'turn-threshold', detail: `Observed ${usage.turns} turns; the next adaptive checkpoint is ${state.softTurnThreshold}.`, count: usage.turns }],
      event.timestamp,
    ));
  } else if (state.toolCalls >= state.nextCheckpointToolCount) {
    const crossed = state.nextCheckpointToolCount;
    state.nextCheckpointToolCount += CHECKPOINT_TOOL_INTERVAL;
    reports.push(report(
      state,
      run,
      usage,
      'checkpoint',
      `A liberal ${crossed}-tool progress checkpoint was reached. Execution continues by default.`,
      [{ signal: 'checkpoint', detail: `${state.toolCalls} tool calls completed; a progress summary is attached.`, count: state.toolCalls }],
      event.timestamp,
    ));
  }
  reports.push(...resourceLivenessReports(state, run, usage, event.timestamp));
  return reports;
}

export function runtimeLivenessReport(
  state: SubagentLivenessState,
  run: SubagentRun,
  usage: SubagentUsage,
  detectedAt: number,
  configuredTimeoutMs: number,
): SubagentLivenessReport {
  return report(
    state,
    run,
    usage,
    'runtime-limit',
    `The child reached its advisory ${Math.round(configuredTimeoutMs / 1_000)} second runtime threshold. It remains active while the parent decides.`,
    [{ signal: 'runtime-duration', detail: `Observed runtime reached the configured ${configuredTimeoutMs} ms threshold.` }],
    detectedAt,
  );
}

export function idleLivenessReport(
  state: SubagentLivenessState,
  run: SubagentRun,
  usage: SubagentUsage,
  detectedAt: number,
): SubagentLivenessReport {
  const idleForMs = Math.max(0, detectedAt - state.lastActivityAt);
  return report(
    state,
    run,
    usage,
    'idle',
    `No observable child activity was seen for ${Math.round(idleForMs / 1_000)} seconds. Idleness is advisory only; the child remains active.`,
    [{ signal: 'idle-duration', detail: `Last observable activity was ${idleForMs} ms ago.` }],
    detectedAt,
    0,
    idleForMs,
  );
}
