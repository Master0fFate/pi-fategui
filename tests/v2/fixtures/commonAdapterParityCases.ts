import type { ErrorCode } from '../../../src/shared/protocol/errors';

export const parityIds = {
  epoch: '10000000-0000-4000-8000-000000000001',
  workspace: '20000000-0000-4000-8000-000000000002',
  foreignWorkspace: '20000000-0000-4000-8000-000000000009',
  principal: '30000000-0000-4000-8000-000000000003',
  connection: '40000000-0000-4000-8000-000000000004',
  session: '50000000-0000-4000-8000-000000000005',
  nextSession: '60000000-0000-4000-8000-000000000006',
  run: '70000000-0000-4000-8000-000000000007',
} as const;
export const parityTime = 1_800_000_000_000;
export const parityPrivateDetail = 'PRIVATE_PARITY_RUNTIME_DETAIL_NOT_FOR_NETWORK';
export const parityText = 'Shared adapter contract prompt';
export const paritySentinels = { a: 'Synthetic workspace A: unchanged\n', b: 'Synthetic workspace B: unchanged\n' };
export type ParityTransport = 'ipc' | 'http';
export type ParityMethod = 'runtime.prompt' | 'runtime.abort' | 'session.select' | 'workspace.monitor';
export type ParitySetup = 'normal' | 'prompt-declined' | 'abort-idle' | 'untrusted-project'
  | 'no-authority' | 'no-membership' | 'revoked-invocation' | 'changed-generation'
  | 'changed-selection' | 'selection-aba' | 'abort-throws' | 'invalid-prompt-result'
  | 'oversized-prompt-result' | 'invalid-monitor-result' | 'monitor-selection-race' | 'monitor-generation-race';
export type ParityFailure =
  | { source: 'zod' }
  | { source: 'desktop'; code: 'INVALID_REQUEST' | 'PROJECT_NOT_TRUSTED' | 'PI_RUNTIME_ERROR'; retryable: boolean }
  | { source: 'fault'; code: ErrorCode }
  | { source: 'native' }
  | { source: 'wire'; code: ErrorCode; execution: 'not-started' | 'unknown' };
export interface ParityCase {
  name: string;
  method: ParityMethod;
  input: object;
  setup?: ParitySetup;
  calls: number;
  effects: number;
  result?: object;
  failures?: Record<ParityTransport, ParityFailure>;
  selectedSession?: string;
  selectionRevision?: number;
  running?: boolean;
  text?: string;
}
const validation: Record<ParityTransport, ParityFailure> = {
  ipc: { source: 'zod' }, http: { source: 'wire', code: 'INVALID_REQUEST', execution: 'not-started' },
};
const stale = (code: 'STALE_SESSION' | 'STALE_WORKSPACE'): Record<ParityTransport, ParityFailure> => ({
  ipc: { source: 'desktop', code: 'INVALID_REQUEST', retryable: true },
  http: { source: 'wire', code, execution: 'not-started' },
});
export const parityMonitorQuery = { section: 'tasks' as const, offset: 2, limit: 1 };
export const parityMonitorResult = {
  sessionId: parityIds.session, section: 'tasks', offset: 2, limit: 1, total: 3, unchanged: false,
  overall: 'unknown', checkedAt: parityTime,
  sources: { runs: 'partial', teams: 'unknown', tasks: 'ready', activity: 'unknown' },
  sourceCheckedAt: { runs: parityTime, teams: null, tasks: parityTime, activity: null },
  counts: { active: 0, attention: 1, runs: 0, teams: 0, tasks: 3, activity: 0 },
  items: [{ source: 'tasks', state: 'attention', updatedAt: parityTime }],
};

/** One table, consumed unchanged by BOTH production adapters. This is the portable
 * plain-text/UUID mutation surface plus the named Monitor read, not an inventory
 * asserting that every inherited desktop operation must be exposed to the network. */
export const commonAdapterParityCases: readonly ParityCase[] = [
  { name: 'prompt trims text, enters the captured runtime once and changes only A', method: 'runtime.prompt',
    input: { text: `  ${parityText}  ` }, calls: 1, effects: 1, text: `applied:${parityText}\n`,
    result: { accepted: true, runId: parityIds.run } },
  { name: 'a declined prompt is not normalized into acceptance or a write', method: 'runtime.prompt',
    input: { text: parityText }, setup: 'prompt-declined', calls: 1, effects: 0,
    result: { accepted: false, runId: parityIds.run } },
  { name: 'abort reports the captured active run stopped once', method: 'runtime.abort', input: {},
    calls: 1, effects: 1, running: false, result: { aborted: true } },
  { name: 'nothing-to-abort stays false and has no mutation effect', method: 'runtime.abort', input: {},
    setup: 'abort-idle', calls: 1, effects: 0, running: false, result: { aborted: false } },
  { name: 'selection uses the same target and advances the real admission revision', method: 'session.select',
    input: { sessionId: parityIds.nextSession }, calls: 1, effects: 1,
    selectedSession: parityIds.nextSession, selectionRevision: 1,
    result: { sessionId: parityIds.nextSession, selectionRevision: 1 } },
  { name: 'Monitor (including a network observer) preserves paging and source health without a live root argument', method: 'workspace.monitor',
    input: parityMonitorQuery, calls: 1, effects: 0, result: parityMonitorResult },
  { name: 'blank prompt fails schema validation before runtime entry', method: 'runtime.prompt', input: { text: '  ' },
    calls: 0, effects: 0, failures: validation },
  { name: 'an oversized shared prompt is rejected before runtime entry', method: 'runtime.prompt', input: { text: 'x'.repeat(200_001) },
    calls: 0, effects: 0, failures: validation },
  { name: 'abort does not accept a caller-selected session field', method: 'runtime.abort', input: { sessionId: parityIds.nextSession },
    calls: 0, effects: 0, failures: validation },
  { name: 'selection rejects an empty target before touching the queue', method: 'session.select', input: { sessionId: '' },
    calls: 0, effects: 0, failures: validation },
  { name: 'Monitor rejects an out-of-range page before reading', method: 'workspace.monitor', input: { ...parityMonitorQuery, limit: 101 },
    calls: 0, effects: 0, failures: validation },
  { name: 'prompt input cannot grant its own identity or authority', method: 'runtime.prompt',
    input: { text: parityText, clientId: parityIds.connection, permissionLevel: 'full-access', confirmed: true },
    calls: 0, effects: 0, failures: validation },
  { name: 'an untrusted project cannot start a prompt', method: 'runtime.prompt', input: { text: parityText },
    setup: 'untrusted-project', calls: 0, effects: 0, failures: {
      ipc: { source: 'desktop', code: 'PROJECT_NOT_TRUSTED', retryable: false },
      http: { source: 'wire', code: 'PERMISSION_REQUIRED', execution: 'not-started' },
    } },
  { name: 'missing transport authority is denied (untrusted IPC sender / network observer)', method: 'runtime.prompt',
    input: { text: parityText }, setup: 'no-authority', calls: 0, effects: 0, failures: {
      ipc: { source: 'desktop', code: 'INVALID_REQUEST', retryable: false },
      http: { source: 'wire', code: 'CONTROL_REQUIRED', execution: 'not-started' },
    } },
  { name: 'revoked workspace membership cannot reach the runtime', method: 'runtime.prompt', input: { text: parityText },
    setup: 'no-membership', calls: 0, effects: 0, failures: {
      ipc: { source: 'desktop', code: 'INVALID_REQUEST', retryable: true },
      http: { source: 'wire', code: 'FORBIDDEN', execution: 'not-started' },
    } },
  { name: 'a replaced document / revoked event ticket cannot invoke a command', method: 'runtime.prompt', input: { text: parityText },
    setup: 'revoked-invocation', calls: 0, effects: 0, failures: {
      ipc: { source: 'desktop', code: 'INVALID_REQUEST', retryable: false },
      http: { source: 'fault', code: 'UNAUTHENTICATED' },
    } },
  { name: 'a changed captured workspace generation cannot retarget a prompt', method: 'runtime.prompt', input: { text: parityText },
    setup: 'changed-generation', calls: 0, effects: 0, failures: stale('STALE_WORKSPACE') },
  { name: 'a changed captured session cannot retarget a prompt', method: 'runtime.prompt', input: { text: parityText },
    setup: 'changed-selection', calls: 0, effects: 0, selectedSession: parityIds.nextSession, selectionRevision: 1,
    failures: stale('STALE_SESSION') },
  { name: 'A to B to A still invalidates the captured selection revision', method: 'runtime.prompt', input: { text: parityText },
    setup: 'selection-aba', calls: 0, effects: 0, selectionRevision: 2, failures: stale('STALE_SESSION') },
  { name: 'an abort exception is not success, not a retry and not proof of no execution', method: 'runtime.abort', input: {},
    setup: 'abort-throws', calls: 1, effects: 0, failures: {
      ipc: { source: 'native' }, http: { source: 'wire', code: 'OUTCOME_UNKNOWN', execution: 'unknown' },
    } },
  { name: 'invalid output after a real fixture write withholds success without undoing or repeating the write', method: 'runtime.prompt',
    input: { text: parityText }, setup: 'invalid-prompt-result', calls: 1, effects: 1, text: `applied:${parityText}\n`, failures: {
      ipc: { source: 'zod' }, http: { source: 'wire', code: 'OUTCOME_UNKNOWN', execution: 'unknown' },
    } },
  { name: 'an oversized result is withheld after one effect, never accepted or retried', method: 'runtime.prompt',
    input: { text: parityText }, setup: 'oversized-prompt-result', calls: 1, effects: 1, text: `applied:${parityText}\n`, failures: {
      ipc: { source: 'desktop', code: 'PI_RUNTIME_ERROR', retryable: false },
      http: { source: 'wire', code: 'OUTCOME_UNKNOWN', execution: 'unknown' },
    } },
  { name: 'invalid Monitor output is rejected rather than projected as healthy', method: 'workspace.monitor', input: parityMonitorQuery,
    setup: 'invalid-monitor-result', calls: 1, effects: 0, failures: {
      ipc: { source: 'zod' }, http: { source: 'wire', code: 'INTERNAL_ERROR', execution: 'not-started' },
    } },
  { name: 'Monitor withholds a result whose selection changed during the source read', method: 'workspace.monitor', input: parityMonitorQuery,
    setup: 'monitor-selection-race', calls: 1, effects: 0, selectedSession: parityIds.nextSession, selectionRevision: 1,
    failures: stale('STALE_SESSION') },
  { name: 'Monitor withholds a result from a replaced workspace handle', method: 'workspace.monitor', input: parityMonitorQuery,
    setup: 'monitor-generation-race', calls: 1, effects: 0, failures: stale('STALE_WORKSPACE') },
];
