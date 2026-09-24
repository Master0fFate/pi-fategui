import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  agentDefinitionSchema, agentSaveSchema, agentStateSchema, routineDefinitionSchema, routineSaveSchema, taskTemplateSchema, taskTemplateSaveSchema,
  type AgentDefinition, type AgentLibrary, type AgentSave, type AgentState, type RoutineDefinition, type RoutineSave, type TaskTemplate, type TaskTemplateSave,
} from '../../shared/contracts/agents';
import { fateDataRoot } from '../pi/FateProviderStorage';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';

export interface AgentProject { path: string; trusted: boolean }
type Kind = 'agent' | 'task' | 'routine';
type Definition = AgentDefinition | TaskTemplate | RoutineDefinition;
type Expected = { revision: number; digest: string } | null;
const schemas = { agent: agentDefinitionSchema, task: taskTemplateSchema, routine: routineDefinitionSchema };
const key = (value: string) => createHash('sha256').update(value).digest('hex');

export class AgentRepository {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly root = path.join(fateDataRoot(), 'agents', 'v1')) {}

  async canonical(project: AgentProject): Promise<string> {
    if (!project.trusted) throw new Error('Trust this project before accessing Agents.');
    const canonical = await fs.realpath(project.path);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Agent project is unavailable.');
    return canonical;
  }

  journal(projectPath: string, scope: 'user' | 'project', kind: Kind): DefinitionJournal {
    return new DefinitionJournal(path.join(this.root, 'definitions', scope === 'user' ? 'user' : key(projectPath), kind), undefined, this.root);
  }
  stateJournal(): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'states'), 2, this.root); }
  ledgerJournal(projectPath: string): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'schedules', key(projectPath)), 2, this.root); }
  approvalJournal(projectPath: string): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'approvals', key(projectPath)), 2, this.root); }

  private decode(kind: Kind, snapshot: DefinitionSnapshot, scope: 'user' | 'project', projectPath: string, id: string): Definition {
    const result = schemas[kind].parse({ ...snapshot.metadata, ...(kind === 'agent' ? { instructions: snapshot.body } : kind === 'task' ? { prompt: snapshot.body } : {}) });
    if (result.id !== id || result.revision !== snapshot.revision || result.projectPath !== (scope === 'user' ? null : projectPath)
      || (kind !== 'routine' && result.scope !== scope)) throw new Error('Definition identity, revision or project scope mismatch.');
    return result;
  }

  async list(project: AgentProject): Promise<AgentLibrary> {
    const projectPath = await this.canonical(project);
    const library: AgentLibrary = { agents: [], tasks: [], routines: [], runs: [], states: [], diagnostics: [], revisions: {}, nextDue: {} };
    for (const kind of ['agent', 'task', 'routine'] as const) {
      for (const scope of (kind === 'routine' ? ['project'] : ['user', 'project']) as Array<'user' | 'project'>) {
        const journal = this.journal(projectPath, scope, kind);
        let ids: string[];
        try { ids = await journal.ids(1000); }
        catch (error) { library.diagnostics.push(`${scope} ${kind}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        for (const id of ids) {
          try {
            const snapshot = await journal.read(id);
            if (!snapshot) throw new Error('Interrupted definition creation; recovery required.');
            const item = this.decode(kind, snapshot, scope, projectPath, id);
            if (item.deleted) continue;
            library.revisions[`${kind}:${id}`] = { revision: snapshot.revision, digest: snapshot.digest };
            if (kind === 'agent') library.agents.push(item as AgentDefinition);
            else if (kind === 'task') library.tasks.push(item as TaskTemplate);
            else library.routines.push(item as RoutineDefinition);
          } catch (error) { library.diagnostics.push(`${scope} ${kind} ${id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
    }
    for (const [label, items] of [['Agents', library.agents], ['TaskTemplates', library.tasks], ['Routines', library.routines]] as const) {
      if (new Set(items.map((item) => item.id)).size !== items.length) library.diagnostics.push(`${label} have duplicated stable identities across scopes. Resolve the conflict before saving or running.`);
    }
    for (const agent of library.agents) {
      try { const state = await this.state(agent.id); if (state) library.states.push(state); }
      catch (error) { library.diagnostics.push(`Agent state ${agent.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return library;
  }

  async get(project: AgentProject, kind: 'agent', id: string): Promise<{ item: AgentDefinition; snapshot: DefinitionSnapshot }>;
  async get(project: AgentProject, kind: 'task', id: string): Promise<{ item: TaskTemplate; snapshot: DefinitionSnapshot }>;
  async get(project: AgentProject, kind: 'routine', id: string): Promise<{ item: RoutineDefinition; snapshot: DefinitionSnapshot }>;
  async get(project: AgentProject, kind: Kind, id: string): Promise<{ item: Definition; snapshot: DefinitionSnapshot }>;
  async get(project: AgentProject, kind: Kind, id: string): Promise<{ item: Definition; snapshot: DefinitionSnapshot }> {
    z.string().uuid().parse(id);
    const projectPath = await this.canonical(project);
    for (const scope of (kind === 'routine' ? ['project'] : ['project', 'user']) as Array<'user' | 'project'>) {
      const snapshot = await this.journal(projectPath, scope, kind).read(id);
      if (!snapshot) continue;
      const item = this.decode(kind, snapshot, scope, projectPath, id);
      if (item.deleted) throw new Error('This definition was deleted. Conversations and audit records are retained.');
      return { item, snapshot };
    }
    throw new Error('Definition no longer exists in this project.');
  }

  private serialize<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(identity) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(identity, settled);
    void settled.then(() => { if (this.queues.get(identity) === settled) this.queues.delete(identity); });
    return result;
  }

  async saveAgent(project: AgentProject, input: AgentSave): Promise<AgentDefinition> {
    const parsed = agentSaveSchema.parse(input);
    return await this.save(project, 'agent', parsed.value, parsed.id, parsed.expected) as AgentDefinition;
  }
  async saveTask(project: AgentProject, input: TaskTemplateSave, source: TaskTemplate['automationSource'] = null): Promise<TaskTemplate> {
    const parsed = taskTemplateSaveSchema.parse(input);
    return await this.save(project, 'task', { ...parsed.value, ...(parsed.id ? {} : { automationSource: source }) }, parsed.id, parsed.expected) as TaskTemplate;
  }
  async saveRoutine(project: AgentProject, input: RoutineSave): Promise<RoutineDefinition> {
    const parsed = routineSaveSchema.parse(input);
    if (parsed.value.enabled) {
      const [{ item: agent }, { item: task }] = await Promise.all([this.get(project, 'agent', parsed.value.agentId), this.get(project, 'task', parsed.value.taskTemplateId)]);
      if (!agent.enabled || !task.enabled) throw new Error('Enable the Agent and TaskTemplate before enabling this Routine.');
    }
    return await this.save(project, 'routine', parsed.value, parsed.id, parsed.expected) as RoutineDefinition;
  }

  private async save(project: AgentProject, kind: Kind, draft: Record<string, unknown>, id: string | undefined, expected: Expected): Promise<Definition> {
    const projectPath = await this.canonical(project);
    const scope = kind === 'routine' ? 'project' : draft.scope as 'user' | 'project';
    const catalog = new DefinitionJournal(path.join(this.root, 'catalog-locks'), undefined, this.root);
    const catalogKey = key(`${scope === 'user' ? 'user' : projectPath}:${kind}`);
    return this.serialize(catalogKey, () => catalog.withLock(catalogKey, async () => {
      const journal = this.journal(projectPath, scope, kind);
      const importedId = kind === 'task' && draft.automationSource ? (draft.automationSource as TaskTemplate['automationSource'])?.sourceId : null;
      const identifier = id ?? importedId ?? randomUUID();
      if (Boolean(id) !== Boolean(expected)) throw new Error('Updates require the exact revision and digest; creations cannot replace an existing definition.');
      const current = id ? await this.get(project, kind, id) : null;
      if (current && (current.item.scope ?? 'project') !== scope) throw new Error('Scope is immutable. Create a copy instead.');
      const library = await this.list(project);
      if (library.diagnostics.length) throw new Error('Resolve library diagnostics before saving; original records are preserved.');
      const items = kind === 'agent' ? library.agents : kind === 'task' ? library.tasks : library.routines;
      if (!id && items.length >= 500) throw new Error('The library supports 500 definitions of each kind.');
      if (items.some((item) => item.id !== identifier && item.name.toLocaleLowerCase() === String(draft.name).trim().toLocaleLowerCase() && (item.scope ?? 'project') === scope)) throw new Error('A definition with that name already exists in this scope.');
      const now = Date.now();
      const value = schemas[kind].parse({ ...current?.item, ...draft, schemaVersion: 1, id: identifier, projectPath: scope === 'user' ? null : projectPath,
        revision: (current?.item.revision ?? 0) + 1, createdAt: current?.item.createdAt ?? now, updatedAt: now, deleted: false });
      const metadata = { ...value };
      const body = kind === 'agent' ? String(metadata.instructions) : kind === 'task' ? String(metadata.prompt) : '';
      delete metadata.instructions;
      delete metadata.prompt;
      await journal.save(identifier, expected, { metadata, body });
      return value;
    }, { recoverDeadWriter: true }));
  }

  async remove(project: AgentProject, kind: Kind, id: string, expected: NonNullable<Expected>): Promise<void> {
    const projectPath = await this.canonical(project);
    const { item, snapshot } = await this.get(project, kind, id);
    const scope = (item.scope ?? 'project') as 'user' | 'project';
    await this.journal(projectPath, scope, kind).save(id, expected, { metadata: { ...snapshot.metadata, deleted: true, enabled: false, revision: item.revision + 1, updatedAt: Date.now() }, body: snapshot.body });
  }

  async withHomeLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    z.string().uuid().parse(agentId);
    // A crashed app may leave this cross-process ownership lock behind. Only
    // recover a same-host lock after exact byte re-read and proven-dead PID;
    // unknown/malformed records remain manual-recovery failures.
    return new DefinitionJournal(path.join(this.root, 'home-locks'), undefined, this.root).withLock(agentId, operation, { recoverDeadWriter: true });
  }

  async state(agentId: string): Promise<AgentState | null> {
    z.string().uuid().parse(agentId);
    const saved = await this.stateJournal().read(agentId);
    if (!saved) return null;
    const state = agentStateSchema.parse(saved.metadata);
    if (state.agentId !== agentId || state.revision !== saved.revision) throw new Error('Agent state ownership conflict.');
    return state;
  }

  async updateState(agentId: string, change: (state: AgentState) => AgentState): Promise<AgentState> {
    return this.serialize(`state:${agentId}`, async () => {
      const journal = this.stateJournal();
      const snapshot = await journal.read(agentId);
      const state = snapshot ? agentStateSchema.parse(snapshot.metadata) : { schemaVersion: 1 as const, agentId, revision: 0, homeSessionId: null, homeProjectPath: null, appliedRevision: 0, lastOpenedAt: null, lastRunAt: null };
      const next = agentStateSchema.parse({ ...change(state), revision: state.revision + 1 });
      if (next.agentId !== agentId || state.homeSessionId && (next.homeSessionId !== state.homeSessionId || next.homeProjectPath !== state.homeProjectPath)) throw new Error('Agent state owner cannot change.');
      await journal.save(agentId, snapshot, { metadata: next, body: '' });
      return next;
    });
  }
}
