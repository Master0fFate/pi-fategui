import { describe, expect, it } from 'vitest';
import { fileTagContext, fileTagText, findFileTags } from './fileTags';

describe('file tags', () => {
  it('finds a # token without interpreting @ agent mentions', () => {
    expect(fileTagContext('Ask @worker about #src/vi', 25)).toEqual({ query: 'src/vi', start: 18, end: 25 });
    expect(fileTagContext('Ask @worker', 11)).toBeNull();
  });

  it('serializes portable relative paths and keeps server-ranked nested results', () => {
    expect(fileTagText('src/nested/view.tsx')).toBe('#src/nested/view.tsx');
    expect(fileTagText('docs/read me.md')).toBe('#"docs/read me.md"');
    expect(fileTagText('archive/src#old.ts')).toBe('#"archive/src#old.ts"');
    expect(findFileTags([
      { path: 'src/nested/ConversationTimeline.tsx', name: 'ConversationTimeline.tsx', kind: 'file', symlink: false },
      { path: 'linked.ts', name: 'linked.ts', kind: 'file', symlink: true },
      { path: 'native\\only.ts', name: 'native\\only.ts', kind: 'file', symlink: false },
    ])).toMatchObject([{ path: 'src/nested/ConversationTimeline.tsx' }]);
  });
});
