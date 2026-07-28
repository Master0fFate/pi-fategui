import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLaunchProjectPath, projectPathFromAdditionalData } from './launchProject';

describe('Fate UI launch project arguments', () => {
  it('resolves an explicit project relative to the invoking terminal', () => {
    expect(parseLaunchProjectPath(['fate-ui', '--project', 'workspace'], path.resolve('/terminal')))
      .toBe(path.resolve('/terminal/workspace'));
  });

  it('supports the equals form and keeps the last explicit project request', () => {
    expect(parseLaunchProjectPath(['--project=first', '--project', 'second'], path.resolve('/terminal')))
      .toBe(path.resolve('/terminal/second'));
  });

  it('ignores unrelated Electron arguments instead of treating them as paths', () => {
    expect(parseLaunchProjectPath(['fate-ui', '--enable-logging', '/unrelated'], path.resolve('/terminal'))).toBeNull();
  });

  it('rejects missing, empty, or unsafe project values', () => {
    expect(() => parseLaunchProjectPath(['--project'], '/terminal')).toThrow('--project requires');
    expect(() => parseLaunchProjectPath(['--project='], '/terminal')).toThrow('--project requires');
    expect(() => parseLaunchProjectPath(['--project', 'bad\0path'], '/terminal')).toThrow('--project requires');
  });

  it('accepts only bounded absolute paths from single-instance additional data', () => {
    const absolute = path.resolve('/terminal/project');
    expect(projectPathFromAdditionalData({ projectPath: absolute })).toBe(path.normalize(absolute));
    expect(projectPathFromAdditionalData({ projectPath: 'relative/project' })).toBeNull();
    expect(projectPathFromAdditionalData({ projectPath: `/${'x'.repeat(32_768)}` })).toBeNull();
    expect(projectPathFromAdditionalData(null)).toBeNull();
  });
});
