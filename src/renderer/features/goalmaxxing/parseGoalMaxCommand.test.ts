import { describe, expect, it } from 'vitest';
import { parseGoalMaxCommand } from './parseGoalMaxCommand';

describe('GoalMax command parser', () => {
  it('intercepts only an exact command at the beginning of the draft', () => {
    expect(parseGoalMaxCommand('/goalmaxxing Build and verify the release')).toEqual({ kind: 'create', objective: 'Build and verify the release' });
    expect(parseGoalMaxCommand('/goalmaxxing')).toEqual({ kind: 'invalid', message: 'Add an objective after /goalmaxxing.' });
    expect(parseGoalMaxCommand(' /goalmaxxing hidden')).toBeNull();
    expect(parseGoalMaxCommand('/goalmaxxing-extra hidden')).toBeNull();
    expect(parseGoalMaxCommand('Explain /goalmaxxing hidden')).toBeNull();
  });

  it('treats former subcommand words as objective text instead of hidden controls', () => {
    expect(parseGoalMaxCommand('/goalmaxxing status')).toEqual({ kind: 'create', objective: 'status' });
    expect(parseGoalMaxCommand('/goalmaxxing pause')).toEqual({ kind: 'create', objective: 'pause' });
    expect(parseGoalMaxCommand('/goalmaxxing replace something')).toEqual({ kind: 'create', objective: 'replace something' });
  });
});
