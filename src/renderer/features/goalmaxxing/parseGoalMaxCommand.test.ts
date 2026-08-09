import { describe, expect, it } from 'vitest';
import { parseGoalMaxCommand } from './parseGoalMaxCommand';

describe('GoalMax command parser', () => {
  it('intercepts only an exact command at the beginning of the draft', () => {
    expect(parseGoalMaxCommand('/goalmax Build and verify the release')).toEqual({ kind: 'create', objective: 'Build and verify the release' });
    expect(parseGoalMaxCommand('/goalmax')).toEqual({ kind: 'view' });
    expect(parseGoalMaxCommand(' /goalmax hidden')).toBeNull();
    expect(parseGoalMaxCommand('/goalmax-extra hidden')).toBeNull();
    expect(parseGoalMaxCommand('Explain /goalmax hidden')).toBeNull();
  });

  it('routes the thread-scoped lifecycle commands without sending them to Pi', () => {
    expect(parseGoalMaxCommand('/goalmax status')).toEqual({ kind: 'view' });
    expect(parseGoalMaxCommand('/goalmax pause')).toEqual({ kind: 'pause' });
    expect(parseGoalMaxCommand('/goalmax RESUME')).toEqual({ kind: 'resume' });
    expect(parseGoalMaxCommand('/goalmax clear')).toEqual({ kind: 'clear' });
    expect(parseGoalMaxCommand('/goalmax replace something')).toEqual({ kind: 'create', objective: 'replace something' });
  });
});
