import { describe, expect, it } from 'vitest';
import { parseGoalMaxCommand } from './parseGoalMaxCommand';

describe('GoalMax command parser', () => {
  it('intercepts only an exact command at the beginning of the draft', () => {
    expect(parseGoalMaxCommand('/goalmax Build and verify the release')).toEqual({ kind: 'create', objective: 'Build and verify the release' });
    expect(parseGoalMaxCommand('/goalmax')).toEqual({ kind: 'invalid', message: 'Add an objective after /goalmax.' });
    expect(parseGoalMaxCommand(' /goalmax hidden')).toBeNull();
    expect(parseGoalMaxCommand('/goalmax-extra hidden')).toBeNull();
    expect(parseGoalMaxCommand('Explain /goalmax hidden')).toBeNull();
  });

  it('treats former subcommand words as objective text instead of hidden controls', () => {
    expect(parseGoalMaxCommand('/goalmax status')).toEqual({ kind: 'create', objective: 'status' });
    expect(parseGoalMaxCommand('/goalmax pause')).toEqual({ kind: 'create', objective: 'pause' });
    expect(parseGoalMaxCommand('/goalmax replace something')).toEqual({ kind: 'create', objective: 'replace something' });
  });
});
