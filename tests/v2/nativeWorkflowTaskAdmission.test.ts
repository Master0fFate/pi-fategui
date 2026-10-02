import { describe, expect, it } from 'vitest';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { TaskService } from '../../src/main/pi/tasks/TaskService';
import { InMemoryTaskRepository } from '../../src/main/pi/tasks/TaskRepository';
import { createTaskTools } from '../../src/main/pi/tasks/TaskTools';
import type { TaskList } from '../../src/shared/contracts/tasks';

function held() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('model-held task mutation admission', () => {
  it('rechecks the host guard inside the serialized mutation after awaited prior work', async () => {
    const release = held();
    let fenced = false;
    let saves = 0;
    class DelayedRepository extends InMemoryTaskRepository {
      override async save(state: TaskList, revision: number | null): Promise<void> {
        saves++;
        if (saves === 1) await release.promise;
        await super.save(state, revision);
      }
    }
    const tasks = new TaskService({ emit: () => {} }, new DelayedRepository());
    let creates = 0;
    const create = tasks.create.bind(tasks);
    tasks.create = (...args) => { creates++; return create(...args); };
    const tool = createTaskTools(tasks, () => ({ projectPath: '/project', sessionId: 'root', isCurrent: () => !fenced })).find((candidate) => candidate.name === 'create_task')!;
    const context = { sessionManager: { getSessionId: () => 'root' } } as ExtensionToolContext;
    const first = tool.execute('first', { title: 'Already admitted' }, undefined, undefined, context);
    await expect.poll(() => saves).toBe(1);
    const second = tool.execute('second', { title: 'Queued before fence' }, undefined, undefined, context);
    const rejected = expect(second).rejects.toThrow(/root session/);
    await expect.poll(() => creates).toBe(2);
    fenced = true;
    release.resolve();
    await first;
    await rejected;
    expect(saves).toBe(1);
    expect(tasks.get('/project', 'root')?.tasks.map((task) => task.title)).toEqual(['Already admitted']);
  });
});
