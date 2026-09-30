import type { FakeInvocation } from './fakePi';
import type { RuntimeState } from '../../../src/shared/contracts/ipc';
import type { GoalMaxState } from '../../../src/shared/contracts/goalmaxxing';
import type { TaskList } from '../../../src/shared/contracts/tasks';
import type { MonitorDashboard } from '../../../src/shared/contracts/monitorDashboard';
import type { RecoveryResult } from '../../../src/core/recovery/RecoveryCoordinator';

/** Test-process IPC only. None of these actions exists on the production HTTP API. */
export type WebFixtureAction =
  | { type: 'code' }
  | { type: 'inspect'; workspace?: 'a' | 'b'; section?: 'overview' | 'tasks' | 'runs'; offset?: number }
  | { type: 'barrier'; operation: 'hold' | 'release' | 'reached'; name: 'accept' | 'emit' | 'settle' | 'acknowledge' }
  | { type: 'planEdit'; after: string; text?: string }
  | { type: 'seedTasks'; count: number }
  | { type: 'taskStatus'; id: string; status: 'todo' | 'in-progress' | 'done' | 'blocked' }
  | { type: 'monitorSource'; state: 'ready' | 'partial' | 'failure' }
  | { type: 'goal'; operation: 'create' | 'pause'; objective?: string }
  | { type: 'checkpoint' }
  | { type: 'shutdown' };
export interface WebFixtureReady {
  type: 'ready'; pid: number; serverEpoch: string; port: number; lockRoots: string[];
  workspaces: { a: { path: string; sessionId: string; workspaceId: string; workspaceGeneration: number };
    b: { path: string; sessionId: string; workspaceId: string; workspaceGeneration: number } };
  recovered: RecoveryResult;
}
export interface WebFixtureInspection {
  runtime: RuntimeState; goal: GoalMaxState | null; tasks: TaskList | null; monitor: MonitorDashboard;
  invocations: FakeInvocation[]; head: string; sentinel: string; status: string; diff: string;
  recovered: RecoveryResult;
}
export interface WebFixtureMessage { type: 'request'; id: string; action: WebFixtureAction }
export type WebFixtureReply = { type: 'reply'; id: string; ok: true; result: unknown }
  | { type: 'reply'; id: string; ok: false; error: string };
