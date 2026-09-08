import { describe, expect, it, vi } from 'vitest';
import type { TaskList } from '../../../shared/contracts/tasks';
import { InMemoryTaskRepository } from './TaskRepository';
import { TaskService } from './TaskService';
import { createTaskTools, TASK_TOOL_NAMES } from './TaskTools';

function fixture(repository = new InMemoryTaskRepository()) {
  const emit = vi.fn();
  const tasks = new TaskService({ emit }, repository);
  let current = true;
  const tools = createTaskTools(tasks, (sessionId) => {
    if (!['root-1', 'root-2'].includes(sessionId)) throw new Error('Not a live root session.');
    return { projectPath: '/project', sessionId, isCurrent: () => current };
  });
  const call = (name: typeof TASK_TOOL_NAMES[number], params = {}, sessionId = 'root-1', signal?: AbortSignal) =>
    tools.find((tool) => tool.name === name)!.execute('call', params, signal, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    } as never);
  return { tasks, tools, call, emit, invalidate: () => { current = false; } };
}

describe('session task tools', () => {
  it('lists, creates, updates details/status, and deletes canonical ordinary tasks without GoalMax', async () => {
    const { tasks, tools, call, emit } = fixture();
    expect(tools.map((tool) => tool.name)).toEqual(TASK_TOOL_NAMES);
    await expect(call('list_tasks')).resolves.toMatchObject({ details: { list: null } });
    await call('create_task', { title: 'Write tests', detail: 'Cover the ordinary prompt flow.' });
    const created = tasks.get('/project', 'root-1')!;
    expect(created.tasks[0]).toMatchObject({ title: 'Write tests', detail: 'Cover the ordinary prompt flow.', status: 'todo', source: 'user', required: false });
    const id = created.tasks[0]!.id;
    await call('update_task', { id, title: 'Test task tools', detail: 'All CRUD paths covered.', status: 'in-progress' });
    await call('update_task', { id, status: 'done' });
    await expect(call('list_tasks')).resolves.toMatchObject({ details: { list: { tasks: [expect.objectContaining({ id, status: 'done', detail: 'All CRUD paths covered.' })], currentTaskId: null } } });
    await call('delete_task', { id });
    expect(tasks.get('/project', 'root-1')!.tasks).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('restores persisted tasks before mutating and keeps caller sessions isolated', async () => {
    const repository = new InMemoryTaskRepository();
    await new TaskService({ emit: () => undefined }, repository).create('/project', 'root-1', { title: 'Saved task' });
    const { tasks, call } = fixture(repository);
    await call('create_task', { title: 'New task' });
    await call('create_task', { title: 'Other root' }, 'root-2');
    expect(tasks.get('/project', 'root-1')!.tasks.map((task) => task.title)).toEqual(['Saved task', 'New task']);
    expect(tasks.get('/project', 'root-2')!.tasks.map((task) => task.title)).toEqual(['Other root']);
    const otherId = tasks.get('/project', 'root-2')!.tasks[0]!.id;
    await expect(call('update_task', { id: otherId, status: 'done' })).rejects.toThrow(/no longer exists/);
    await expect(call('delete_task', { id: otherId })).rejects.toThrow(/no longer exists/);
    await expect(call('create_task', { title: 'Child write' }, 'child-1')).rejects.toThrow(/live root/);
  });

  it('rejects unsupported verification, requirement, source, identity, and malformed inputs', async () => {
    const { tasks, call } = fixture();
    for (const extra of [{ verified: true }, { required: true }, { source: 'goalmax' }, { sessionId: 'root-2' }]) {
      await expect(call('create_task', { title: 'No', ...extra })).rejects.toThrow();
    }
    await expect(call('create_task', { title: '   ' })).rejects.toThrow();
    await expect(call('create_task', { title: 'x'.repeat(241) })).rejects.toThrow();
    await expect(call('create_task', { title: 'No', detail: 'x'.repeat(2001) })).rejects.toThrow();
    await expect(call('create_task', { title: 'No', status: 'verified' })).rejects.toThrow();
    await call('create_task', { title: 'Real task' });
    const id = tasks.get('/project', 'root-1')!.tasks[0]!.id;
    await expect(call('update_task', { id })).rejects.toThrow(/field must change/);
    for (const extra of [{ verified: true }, { required: false }, { goalId: 'goal-1' }]) {
      await expect(call('update_task', { id, status: 'done', ...extra })).rejects.toThrow();
    }
    expect(tasks.get('/project', 'root-1')!.revision).toBe(1);
  });

  it('refuses managed task changes and cannot self-verify a required ordinary task', async () => {
    const repository = new InMemoryTaskRepository();
    const seed = new TaskService({ emit: () => undefined }, repository);
    await seed.create('/project', 'root-1', { title: 'Managed criterion', required: true });
    const list = await seed.create('/project', 'root-1', { title: 'Required ordinary task', required: true });
    const managedId = list.tasks[0]!.id;
    const ordinaryId = list.tasks[1]!.id;
    await repository.save({
      ...list,
      revision: list.revision + 1,
      goalId: 'goal-1',
      tasks: list.tasks.map((task) => task.id === managedId
        ? { ...task, source: 'goalmax', goalId: 'goal-1', goalCriterionId: 'criterion-1' }
        : task),
    }, list.revision);
    const { tasks, call } = fixture(repository);
    await expect(call('update_task', { id: managedId, status: 'done' })).rejects.toThrow(/managed by the active goal/);
    await expect(call('delete_task', { id: managedId })).rejects.toThrow(/managed by the active goal/);
    await call('update_task', { id: ordinaryId, status: 'done' });
    expect(tasks.get('/project', 'root-1')!.tasks).toEqual([
      expect.objectContaining({ id: managedId, status: 'todo', verified: false, required: true }),
      expect.objectContaining({ id: ordinaryId, status: 'done', verified: false, required: true }),
    ]);
  });

  it('does not mutate when loading outlives its root session or is aborted', async () => {
    const repository = new InMemoryTaskRepository();
    let finish!: (list: TaskList | null) => void;
    vi.spyOn(repository, 'load').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { tasks, call, invalidate } = fixture(repository);
    const pending = call('create_task', { title: 'Stale task' });
    invalidate();
    finish(null);
    await expect(pending).rejects.toThrow(/root session changed/);
    expect(tasks.get('/project', 'root-1')).toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(call('create_task', { title: 'Cancelled task' }, 'root-1', controller.signal)).rejects.toThrow();
  });

  it('shares initial loading and serializes simultaneous task creations', async () => {
    const repository = new InMemoryTaskRepository();
    const load = vi.spyOn(repository, 'load');
    const { tasks, call } = fixture(repository);
    await Promise.all([call('create_task', { title: 'One' }), call('create_task', { title: 'Two' })]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(tasks.get('/project', 'root-1')).toMatchObject({ revision: 2, tasks: [expect.objectContaining({ title: 'One' }), expect.objectContaining({ title: 'Two' })] });
  });
});
