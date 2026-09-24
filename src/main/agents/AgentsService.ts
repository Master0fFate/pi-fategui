import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  agentRunSchema, savedAgentSessionSchema,
  type AgentDefinition, type AgentLibrary, type AgentRun, type AgentSave, type AgentApprovalInput, type LegacyImportItem, type RoutineDefinition, type RoutineSave, type SavedAgentSession, type TaskTemplate, type TaskTemplateSave,
} from '../../shared/contracts/agents';
import type { AgentWorkspacePolicy } from '../../shared/contracts/multiAgent';
import type { LegacyAutomations } from '../automations/LegacyAutomations';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import { projectSessionDirectory } from '../pi/PiSessionRepository';
import { isModelDisabled } from '../../shared/modelVisibility';
import { AgentRepository, type AgentProject } from './AgentRepository';
import { ApprovalGate } from './ApprovalGate';
import { createAgentExecution, type AgentExecutionInput, type AgentExecutionHandle } from './AgentExecutor';
import { previewAutomationCopy, restoreAutomationCopy } from './AutomationCopy';
import { HomeOwnership } from './HomeOwnership';
import { RoutineLedger } from './RoutineLedger';
import { effectivePermission, effectiveWorkspace } from './RoutinePolicy';

export interface AgentChange { projectPath: string; runId?: string; status?: AgentRun['status']; message?: string }
export interface AgentsHost {
  runtime: Pick<PiRuntimeService, 'getState' | 'agentAuthority' | 'agentModelRuntime' | 'agentResources' | 'openAgentSavedSession' | 'createAgentForegroundExecution'>;
  workspacePolicy: () => AgentWorkspacePolicy;
  disabledModels: () => readonly string[];
  notify?: (change: AgentChange, os: boolean) => void;
  sessionsRoot?: string;
}
interface ActiveRun {
  project: AgentProject; ledgerId: string; run: AgentRun; gate: ApprovalGate; session: AgentExecutionHandle | null;
  originSessionId: string; cancelled: boolean; agentDigest: string; taskDigest: string; routineDigest: string | null;
  timer: ReturnType<typeof setTimeout> | null; heartbeat: ReturnType<typeof setInterval> | null;
  completion: Promise<void> | null;
}
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 8000);

export class AgentsService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly initialized = new Set<string>();
  private readonly opening = new Map<string, Promise<{ sessionId: string; appliedRevision: number }>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopping = false;
  private changed: (change: AgentChange) => void = () => undefined;
  private readonly processId = randomUUID();

  constructor(
    private readonly host: AgentsHost,
    readonly repository = new AgentRepository(),
    private readonly legacy?: Pick<LegacyAutomations, 'list'>,
    private readonly execute: (input: AgentExecutionInput) => Promise<AgentExecutionHandle> = createAgentExecution,
  ) {}
  setChangeSink(sink: (change: AgentChange) => void): void { this.changed = sink; }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 5000);
    this.timer.unref?.();
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const active = [...this.active.values()];
    await Promise.allSettled(active.map(async (run) => { run.cancelled = true; if (run.heartbeat) clearInterval(run.heartbeat); run.heartbeat = null; await run.session?.abort(); }));
    await Promise.allSettled([...this.queues.values(), ...this.opening.values(), ...active.flatMap((run) => run.completion ? [run.completion] : [])]);
  }
  private project(): AgentProject {
    if (this.stopping) throw new Error('Agents are shutting down.');
    const state = this.host.runtime.getState(false);
    if (!state.project?.trusted) throw new Error('Open and trust a project before using Agents.');
    return { path: state.project.path, trusted: true };
  }
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }
  private ledger(projectPath: string): RoutineLedger { return new RoutineLedger(this.repository.ledgerJournal(projectPath)); }
  private async initialize(project: AgentProject): Promise<void> {
    await this.serialize(project.path, async () => {
      if (this.initialized.has(project.path)) return;
      const journal = this.repository.ledgerJournal(project.path);
      const ledger = this.ledger(project.path);
      for (const id of await journal.ids(501)) await ledger.recover(id, Date.now(), true, this.processId);
      if (!await journal.read('manual')) await ledger.create('manual', { anchor: Date.now(), intervalMs: 60_000, timeZone: 'UTC' });
      this.initialized.add(project.path);
    });
  }

  async list(routineId?: string): Promise<AgentLibrary> {
    const project = this.project();
    const library = await this.repository.list(project);
    try { await this.initialize(project); }
    catch (error) { library.diagnostics.push(`Run recovery: ${failure(error)}`); }
    for (const id of await this.repository.ledgerJournal(project.path).ids(501)) {
      try {
        const { state } = await this.ledger(project.path).read(id);
        library.nextDue[id] = state.nextDue;
        const definition = library.routines.find((routine) => routine.id === id);
        if (definition && state.definitionRevision === definition.revision && (state.schedule.intervalMs !== definition.intervalMinutes * 60_000 || state.schedule.timeZone !== definition.timeZone || state.definitionDigest !== null && state.definitionDigest !== library.revisions[`routine:${id}`]?.digest)) library.diagnostics.push(`Routine ${definition.name} changed outside its versioned editor. Save the reviewed definition before scheduling.`);
        if (!routineId || id === routineId) library.runs.push(...state.runs.flatMap((run) => run.payload ? [run.payload] : []));
      } catch (error) { library.diagnostics.push(`Run history ${id}: ${failure(error)}`); }
    }
    library.runs.sort((a, b) => b.scheduledFor - a.scheduledFor);
    if (library.runs.length > 1000) {
      library.runs = library.runs.slice(0, 1000);
      library.diagnostics.push('Showing the latest 1,000 runs. Select a Routine to inspect its retained history.');
    }
    return library;
  }

  async saveAgent(input: AgentSave): Promise<AgentDefinition> {
    const project = this.project();
    const result = await this.repository.saveAgent(project, input);
    await this.cancelMatching((active) => active.run.agentId === result.id);
    this.changed({ projectPath: project.path });
    return result;
  }
  async saveTask(input: TaskTemplateSave): Promise<TaskTemplate> {
    const project = this.project();
    const result = await this.repository.saveTask(project, input);
    await this.cancelMatching((active) => active.run.taskTemplateId === result.id);
    this.changed({ projectPath: project.path });
    return result;
  }
  async saveRoutine(input: RoutineSave): Promise<RoutineDefinition> {
    const project = this.project();
    const result = await this.repository.saveRoutine(project, input);
    await this.initialize(project);
    const digest = (await this.repository.get(project, 'routine', result.id)).snapshot.digest;
    await this.serialize(project.path, () => this.ledger(project.path).configure(result.id, { anchor: Date.now() + result.intervalMinutes * 60_000, intervalMs: result.intervalMinutes * 60_000, timeZone: result.timeZone }, result.revision, digest));
    await this.cancelMatching((active) => active.run.routineId === result.id);
    this.changed({ projectPath: project.path });
    return result;
  }
  async remove(input: { kind: 'agent' | 'task' | 'routine'; id: string; expected: { revision: number; digest: string } }): Promise<void> {
    const project = this.project();
    if (input.kind !== 'routine') {
      const library = await this.repository.list(project);
      for (const routine of library.routines.filter((item) => item.enabled && (input.kind === 'agent' ? item.agentId === input.id : item.taskTemplateId === input.id))) {
        const { name, agentId, taskTemplateId, intervalMinutes, timeZone, permissionCeiling, notify, osNotify } = routine;
        await this.saveRoutine({ id: routine.id, expected: library.revisions[`routine:${routine.id}`]!, value: { name, agentId, taskTemplateId, intervalMinutes, timeZone, permissionCeiling, notify, osNotify, enabled: false } });
      }
    }
    await this.repository.remove(project, input.kind, input.id, input.expected);
    await this.cancelMatching((active) => input.kind === 'agent' ? active.run.agentId === input.id : input.kind === 'task' ? active.run.taskTemplateId === input.id : active.run.routineId === input.id);
    this.changed({ projectPath: project.path });
  }
  private async cancelMatching(predicate: (active: ActiveRun) => boolean): Promise<void> {
    await Promise.all([...this.active.values()].filter(predicate).map(async (active) => { active.cancelled = true; await active.session?.abort(); }));
  }

  private async preset(agent: AgentDefinition, project: AgentProject, background: boolean, runId: string | null, permission: 'read-only' | 'edit'): Promise<SavedAgentSession> {
    const state = this.host.runtime.getState(false);
    const selected = agent.defaults.model ?? (state.model ? { provider: state.model.provider, id: state.model.id } : null);
    if (!selected || isModelDisabled(this.host.disabledModels(), selected.provider, selected.id)) throw new Error('Choose an available enabled model for this Agent.');
    const modelRuntime = await this.host.runtime.agentModelRuntime();
    if (!(await modelRuntime.getAvailable()).some((model) => model.provider === selected.provider && model.id === selected.id)) throw new Error('Agent model is unavailable or unauthenticated; no fallback was used.');
    const workspace = effectiveWorkspace(this.host.workspacePolicy(), agent.defaults.workspace);
    if (workspace !== 'shared') throw new Error('Saved Agent root conversations and local Routines currently require an explicitly permitted shared workspace. Use Agent Teams for isolated worktrees; no shared fallback was used.');
    return savedAgentSessionSchema.parse({ schemaVersion: 1, agentId: agent.id, revision: agent.revision, name: agent.name, instructions: agent.instructions,
      skillRefs: agent.skillRefs, defaults: { ...agent.defaults, model: selected, permission }, background, runId, projectPath: project.path });
  }

  async open(agentId: string, mode: 'home' | 'new'): Promise<{ sessionId: string; appliedRevision: number }> {
    const project = this.project();
    const key = `${project.path}:${agentId}:${mode}`;
    const existing = this.opening.get(key);
    if (existing) return existing;
    const open = async () => {
      const { item: agent } = await this.repository.get(project, 'agent', agentId);
      if (!agent.enabled) throw new Error('Enable this Agent before opening or running it.');
      const state = await this.repository.state(agentId);
      if (mode === 'home' && state?.homeProjectPath && state.homeProjectPath !== project.path) throw new Error(`This Agent home belongs to ${state.homeProjectPath}. Open that project to retain conversation ownership.`);
      const retained = mode === 'home' && Boolean(state?.homeSessionId);
      const preset = retained ? undefined : await this.preset(agent, project, false, null, effectivePermission(this.host.runtime.getState(false).permissionLevel ?? 'read-only', agent.defaults.permission));
      const home = await new HomeOwnership(projectSessionDirectory(project.path, this.host.sessionsRoot)).open({ agentId, revision: agent.revision, instructions: agent.instructions, projectPath: project.path, ...(preset ? { preset } : {}) }, { enabled: agent.enabled, deleted: agent.deleted, ...(retained ? { requireExisting: true, requirePreset: true } : {}) }, mode === 'home' ? agentId : randomUUID());
      if (retained && home.sessionId !== state?.homeSessionId) throw new Error('Home ownership conflicts with the retained state. Restore the original mapping before opening.');
      if (mode === 'home') await this.repository.updateState(agentId, (current) => ({ ...current, homeSessionId: home.sessionId, homeProjectPath: project.path, appliedRevision: home.appliedRevision, lastOpenedAt: Date.now() }));
      await this.host.runtime.openAgentSavedSession(home.sessionId);
      this.changed({ projectPath: project.path });
      return { sessionId: home.sessionId, appliedRevision: home.appliedRevision };
    };
    const operation = mode === 'home' ? this.repository.withHomeLock(agentId, open) : open();
    this.opening.set(key, operation);
    try { return await operation; } finally { if (this.opening.get(key) === operation) this.opening.delete(key); }
  }

  private runRecord(id: string, agent: AgentDefinition, task: TaskTemplate, routine: RoutineDefinition | null, projectPath: string, scheduledFor: number, status: 'queued' | 'skipped'): AgentRun {
    return agentRunSchema.parse({ schemaVersion: 1, id, agentId: agent.id, agentRevision: agent.revision, taskTemplateId: task.id, taskTemplateRevision: task.revision,
      routineId: routine?.id ?? null, routineRevision: routine?.revision ?? null, projectPath, scheduledFor, startedAt: null, finishedAt: status === 'skipped' ? Date.now() : null,
      status, sessionId: null, resultSummary: '', error: status === 'skipped' ? 'Missed occurrence or an earlier run is unresolved; not replayed.' : null, inputs: {},
      permission: effectivePermission(this.host.runtime.getState(false).permissionLevel ?? 'read-only', agent.defaults.permission, task.permissionCeiling, routine?.permissionCeiling ?? 'edit'), approvals: [] });
  }
  async run(input: { agentId: string; taskTemplateId: string; routineId?: string | undefined }): Promise<AgentRun> {
    const project = this.project();
    const [{ item: agent }, { item: task }] = await Promise.all([this.repository.get(project, 'agent', input.agentId), this.repository.get(project, 'task', input.taskTemplateId)]);
    const routineRecord = input.routineId ? await this.repository.get(project, 'routine', input.routineId) : null;
    const routine = routineRecord?.item ?? null;
    if (routine && (routine.agentId !== agent.id || routine.taskTemplateId !== task.id)) throw new Error('Routine binding changed. Refresh before running.');
    if (!agent.enabled || !task.enabled || (routine && !routine.enabled)) throw new Error('Enable the Agent, TaskTemplate and Routine before running.');
    await this.initialize(project);
    const ledgerId = routine?.id ?? 'manual';
    if (routine) await this.serialize(project.path, () => this.ledger(project.path).configure(ledgerId, { anchor: Date.now() + routine.intervalMinutes * 60_000, intervalMs: routine.intervalMinutes * 60_000, timeZone: routine.timeZone }, routine.revision, routineRecord?.snapshot.digest ?? null));
    const run = this.runRecord(`${ledgerId}:${randomUUID()}`, agent, task, routine, project.path, Date.now(), 'queued');
    await this.serialize(project.path, () => this.ledger(project.path).admit(ledgerId, run));
    await this.launch(project, ledgerId, run, Boolean(routine));
    return (await this.findRun(project, run.id)).run;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const project = this.project();
      await this.initialize(project);
      const ledger = this.ledger(project.path);
      for (const id of await this.repository.ledgerJournal(project.path).ids(501)) {
        await this.serialize(project.path, () => ledger.recover(id, now, false, this.processId));
      }
      const library = await this.repository.list(project);
      if (library.diagnostics.length) return;
      for (const routine of library.routines.filter((item) => item.enabled)) {
        const agent = library.agents.find((item) => item.id === routine.agentId);
        const task = library.tasks.find((item) => item.id === routine.taskTemplateId);
        // A Routine may outlive a later Agent/TaskTemplate disable. Do not
        // admit a new occurrence that can only fail at execution time.
        if (!agent?.enabled || !task?.enabled) continue;
        await this.serialize(project.path, () => this.ledger(project.path).configure(routine.id, { anchor: routine.createdAt + routine.intervalMinutes * 60_000, intervalMs: routine.intervalMinutes * 60_000, timeZone: routine.timeZone }, routine.revision, library.revisions[`routine:${routine.id}`]!.digest));
        const admitted = await this.serialize(project.path, () => this.ledger(project.path).tick(routine.id, now, (id, scheduledFor, status) => this.runRecord(id, agent, task, routine, project.path, scheduledFor, status)));
        if (!admitted?.payload) continue;
        if (admitted.status === 'queued') await this.launch(project, routine.id, admitted.payload, true);
        else this.changed({ projectPath: project.path, runId: admitted.id, status: 'skipped', message: admitted.reason ?? 'Run skipped.' });
      }
    } finally { this.ticking = false; }
  }

  private launch(project: AgentProject, ledgerId: string, run: AgentRun, background: boolean): Promise<void> {
    return this.serialize('launch', () => this.startExecution(project, ledgerId, run, background));
  }
  private async startExecution(project: AgentProject, ledgerId: string, run: AgentRun, background: boolean): Promise<void> {
    try {
      if (this.active.size >= 4) throw new Error('Four Agent runs are already active. Run again after one settles.');
      const state = this.host.runtime.getState(false);
      if (state.project?.path !== project.path || !state.project.trusted || !state.sessionId) throw new Error('The original project needs a live trusted session.');
      const [{ item: agent, snapshot: agentSnapshot }, { item: task, snapshot: taskSnapshot }] = await Promise.all([this.repository.get(project, 'agent', run.agentId), this.repository.get(project, 'task', run.taskTemplateId)]);
      const routine = run.routineId ? await this.repository.get(project, 'routine', run.routineId) : null;
      if (!agent.enabled || !task.enabled || agent.revision !== run.agentRevision || task.revision !== run.taskTemplateRevision || (routine && routine.item.revision !== run.routineRevision)) throw new Error('The admitted definition changed or was disabled before execution.');
      const preset = await this.preset(agent, project, background, run.id, run.permission);
      await this.serialize(project.path, () => this.ledger(project.path).claim(ledgerId, run.id, this.processId, Date.now()));
      const currentContext = () => {
        const current = this.host.runtime.getState(false);
        const active = this.active.get(run.id);
        const live = this.host.runtime.agentAuthority(active?.originSessionId ?? state.sessionId!);
        return { trusted: Boolean(!this.stopping && !active?.cancelled && current.project?.trusted && current.project.path === project.path && live),
          permission: effectivePermission(live?.level ?? 'read-only', run.permission),
          binding: { runId: run.id, projectPath: project.path, definitionRevision: run.agentRevision, taskRevision: run.taskTemplateRevision, permissionRevision: live?.revision ?? -1 } };
      };
      const gate = new ApprovalGate(this.repository.approvalJournal(project.path), currentContext, async (id, snapshot) => {
        await this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, status: 'needs-attention', approvals: [...current.approvals, { id, revision: snapshot.revision, digest: snapshot.digest, action: snapshot.body, expiresAt: Number(snapshot.metadata.expiresAt), status: 'pending' }] }));
        this.announce(project.path, run.id, 'needs-attention', 'Review the exact proposed action before it can run.', routine?.item);
      }, Date.now, async (id, decision) => {
        const active = this.active.get(run.id);
        if (active) active.cancelled = true;
        await this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, error: `Approval ${decision}; no effect was executed.`, approvals: current.approvals.map((approval) => approval.id === id ? { ...approval, status: decision } : approval) }));
      });
      const active: ActiveRun = { project, ledgerId, run, gate, session: null, originSessionId: state.sessionId, cancelled: false, agentDigest: agentSnapshot.digest, taskDigest: taskSnapshot.digest, routineDigest: routine?.snapshot.digest ?? null, timer: null, heartbeat: null, completion: null };
      this.active.set(run.id, active);
      active.heartbeat = setInterval(() => {
        if (this.active.get(run.id) !== active || active.cancelled) return;
        void this.serialize(project.path, () => this.ledger(project.path).heartbeat(ledgerId, run.id, this.processId, Date.now())).catch((error: unknown) => {
          if (this.active.get(run.id) !== active || active.cancelled) return;
          active.cancelled = true;
          this.changed({ projectPath: project.path, runId: run.id, status: 'needs-attention', message: `Routine lease was lost; execution stopped without replay: ${failure(error)}` });
          void active.session?.abort();
        });
      }, 20_000);
      active.heartbeat.unref?.();
      const home = await new HomeOwnership(projectSessionDirectory(project.path, this.host.sessionsRoot)).open({ agentId: agent.id, revision: agent.revision, instructions: agent.instructions, projectPath: project.path, preset }, { enabled: true, deleted: false, requirePreset: true }, randomUUID());
      const resources = background ? await this.host.runtime.agentResources(preset.skillRefs) : { skills: [], contextPrompts: [] };
      const session = background ? await this.execute({ preset, sessionFile: home.file, modelRuntime: await this.host.runtime.agentModelRuntime(), context: currentContext, approvals: gate, approvedSkills: resources.skills, contextPrompts: resources.contextPrompts,
        validate: async () => {
          if (!currentContext().trusted || active.cancelled) throw new Error('The owning live project/session is unavailable.');
          if (effectiveWorkspace(this.host.workspacePolicy(), preset.defaults.workspace) !== 'shared') throw new Error('The live workspace policy no longer permits this shared run.');
          const [currentAgent, currentTask] = await Promise.all([this.repository.get(project, 'agent', agent.id), this.repository.get(project, 'task', task.id)]);
          if (currentAgent.snapshot.digest !== active.agentDigest || currentTask.snapshot.digest !== active.taskDigest
            || routine && (await this.repository.get(project, 'routine', routine.item.id)).snapshot.digest !== active.routineDigest) throw new Error('A run definition changed. Cancel and review before running again.');
          if (preset.defaults.model && isModelDisabled(this.host.disabledModels(), preset.defaults.model.provider, preset.defaults.model.id)) throw new Error('This Agent model was disabled during the run.');
        },
      }) : await this.host.runtime.createAgentForegroundExecution(home.sessionId);
      active.session = session;
      if (!background) active.originSessionId = session.sessionId;
      if (!currentContext().trusted || active.cancelled) throw new Error('Agent launch was cancelled or its project changed.');
      await this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, status: 'running', sessionId: session.sessionId }));
      await this.repository.updateState(agent.id, (current) => ({ ...current, lastRunAt: Date.now() }));
      active.timer = setTimeout(() => { active.cancelled = true; void session.abort(); }, 30 * 60_000);
      active.timer.unref?.();
      this.changed({ projectPath: project.path, runId: run.id, status: 'running' });
      active.completion = session.prompt(task.prompt, { expandPromptTemplates: false }).then(async () => {
        const last = [...session.messages].reverse().find((message) => message.role === 'assistant');
        const summary = last?.role === 'assistant' ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').slice(0, 4000) : '';
        const failed = active.cancelled || last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted');
        await this.finish(active, failed ? 'failed' : 'succeeded', summary, failed ? 'Run stopped, was denied, or failed. Inspect its retained session before explicitly running again.' : null, routine?.item);
      }, async (error: unknown) => { await this.finish(active, 'failed', '', failure(error), routine?.item); }).catch((error: unknown) => {
        this.changed({ projectPath: project.path, runId: run.id, status: 'needs-attention', message: `Run finalization requires recovery: ${failure(error)}` });
      });
    } catch (error) {
      const active = this.active.get(run.id);
      active?.session?.dispose();
      if (active?.timer) clearTimeout(active.timer);
      if (active?.heartbeat) clearInterval(active.heartbeat);
      if (active) active.heartbeat = null;
      this.active.delete(run.id);
      await this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, status: 'failed', finishedAt: Date.now(), error: failure(error) }));
      const notificationPolicy = run.routineId ? await this.repository.get(project, 'routine', run.routineId).then((record) => record.item).catch(() => undefined) : undefined;
      this.announce(project.path, run.id, 'failed', failure(error), notificationPolicy);
    }
  }

  private async finish(active: ActiveRun, status: 'failed' | 'succeeded', resultSummary: string, error: string | null, routine?: RoutineDefinition): Promise<void> {
    if (active.timer) clearTimeout(active.timer);
    if (active.heartbeat) clearInterval(active.heartbeat);
    active.heartbeat = null;
    try {
      await this.changeRun(active.project, active.ledgerId, active.run.id, (current) => ({ ...current, status, resultSummary, error, finishedAt: Date.now(), approvals: current.approvals.map((approval) => approval.status === 'pending' ? { ...approval, status: 'expired' } : approval) }));
      this.announce(active.project.path, active.run.id, status, status === 'succeeded' ? 'Agent run completed.' : error ?? 'Agent run failed.', routine);
    } finally { active.session?.dispose(); this.active.delete(active.run.id); }
  }
  private announce(projectPath: string, runId: string, status: AgentRun['status'], message: string, routine?: RoutineDefinition): void {
    const change = { projectPath, runId, status, message };
    this.changed(routine?.notify === false ? { projectPath, runId, status } : change);
    this.host.notify?.(change, routine?.osNotify ?? false);
  }
  private async changeRun(project: AgentProject, ledgerId: string, runId: string, change: (run: AgentRun) => AgentRun): Promise<AgentRun> {
    return this.serialize(project.path, () => this.ledger(project.path).update(ledgerId, runId, change));
  }
  private async findRun(project: AgentProject, id: string): Promise<{ run: AgentRun; ledgerId: string }> {
    const ledgerId = id.split(':')[0]!;
    if (ledgerId !== 'manual') z.string().uuid().parse(ledgerId);
    const { state } = await this.ledger(project.path).read(ledgerId);
    const run = state.runs.find((entry) => entry.id === id)?.payload;
    if (!run || run.projectPath !== project.path) throw new Error('Run is no longer retained in this project.');
    return { run, ledgerId };
  }
  async approve(input: AgentApprovalInput): Promise<void> {
    const project = this.project();
    const { run, ledgerId } = await this.findRun(project, input.runId);
    const active = this.active.get(run.id);
    const approval = run.approvals.find((item) => item.id === input.approvalId);
    if (!active || !approval || approval.status !== 'pending') throw new Error('This action is no longer suspended. Interrupted actions cannot be replayed.');
    const [{ snapshot: agent }, { snapshot: task }] = await Promise.all([this.repository.get(project, 'agent', run.agentId), this.repository.get(project, 'task', run.taskTemplateId)]);
    if (agent.digest !== active.agentDigest || task.digest !== active.taskDigest || run.routineId && (await this.repository.get(project, 'routine', run.routineId)).snapshot.digest !== active.routineDigest) throw new Error('Definition changed since the action was proposed. Cancel this run and review the changes.');
    const snapshot = await this.repository.approvalJournal(project.path).read(input.approvalId);
    if (!snapshot || snapshot.revision !== input.expected.revision || snapshot.digest !== input.expected.digest) throw new Error('Approval preview changed. Reload before deciding.');
    const record = () => this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, status: input.approved ? 'running' : current.status, approvals: current.approvals.map((item) => item.id === input.approvalId ? { ...item, status: input.approved ? 'approved' : 'denied' } : item) })).then(() => undefined);
    if (input.approved) await active.gate.approve(input.approvalId, snapshot, record);
    else { active.cancelled = true; await record(); await active.gate.deny(input.approvalId); await active.session?.abort(); }
    this.changed({ projectPath: project.path, runId: run.id });
  }
  async cancel(runId: string): Promise<void> {
    const project = this.project();
    const { run, ledgerId } = await this.findRun(project, runId);
    const active = this.active.get(run.id);
    if (active) { active.cancelled = true; await active.session?.abort(); }
    else await this.changeRun(project, ledgerId, run.id, (current) => ({ ...current, status: 'failed', finishedAt: Date.now(), error: 'Uncertain run dismissed without replaying any action.' }));
    this.changed({ projectPath: project.path, runId });
  }
  async openRun(runId: string): Promise<void> {
    const { run } = await this.findRun(this.project(), runId);
    if (!run.sessionId) throw new Error('This run did not create a session.');
    if (this.active.has(run.id)) throw new Error('Wait for this Agent run to settle before opening its saved session.');
    await this.host.runtime.openAgentSavedSession(run.sessionId);
  }

  /** Read-only listing of retired Automation documents for the Legacy Import view. */
  async listLegacy(): Promise<LegacyImportItem[]> {
    const project = this.project();
    const sources = (await this.legacy?.list(project.path)) ?? [];
    const copied = await Promise.all(sources.map(async (source) => {
      try { return await this.previewCopy(source.id); }
      catch (error) { return { sourceId: source.id, sourceDigest: '', name: source.name, prompt: source.prompt, permissionCeiling: source.permissionLevel, archivedFields: [], existingTaskId: null, error: failure(error) };
      }
    }));
    return copied;
  }

  async previewCopy(automationId: string) {
    const project = this.project();
    const source = (await this.legacy?.list(project.path))?.find((item) => item.id === automationId);
    if (!source) throw new Error('Legacy automation is unavailable in this project.');
    const copy = previewAutomationCopy(JSON.stringify(source));
    const library = await this.repository.list(project);
    return { sourceId: source.id, sourceDigest: copy.sourceDigest, name: source.name, prompt: source.prompt, permissionCeiling: source.permissionLevel,
      archivedFields: [...copy.archivedFields], existingTaskId: library.tasks.find((task) => task.automationSource?.sourceId === source.id)?.id ?? null };
  }
  async copyAutomation(automationId: string, sourceDigest: string): Promise<TaskTemplate> {
    const project = this.project();
    return this.serialize(`copy:${project.path}`, async () => {
      const preview = await this.previewCopy(automationId);
      if (preview.sourceDigest !== sourceDigest) throw new Error('Legacy automation changed after preview. Review it again before copying.');
      if (preview.existingTaskId) return (await this.repository.get(project, 'task', preview.existingTaskId)).item;
      const source = (await this.legacy!.list(project.path)).find((item) => item.id === automationId)!;
      const copy = previewAutomationCopy(JSON.stringify(source));
      if (copy.sourceDigest !== sourceDigest) throw new Error('Legacy automation changed during migration. Original data was preserved.');
      const task = await this.repository.saveTask(project, { expected: null, value: { scope: 'project', name: source.name, prompt: source.prompt, permissionCeiling: source.permissionLevel, enabled: true } }, { sourceId: source.id, source: copy.source, sourceDigest });
      this.changed({ projectPath: project.path });
      return task;
    });
  }
  async rollbackCopy(taskId: string, expected: { revision: number; digest: string }): Promise<void> {
    const project = this.project();
    const { item } = await this.repository.get(project, 'task', taskId);
    if (!item.automationSource) throw new Error('This TaskTemplate was not copied from an Automation.');
    restoreAutomationCopy(item.automationSource);
    await this.remove({ kind: 'task', id: taskId, expected });
  }
}
