import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('.');
const require = createRequire(path.join(root, 'package.json'));
const sdkRoot = realpathSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent'));
const yaml = createRequire(path.join(sdkRoot, 'package.json'))('yaml');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const parents = ['@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-select'];
function packageRoot(entry: string, name: string): string {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`Missing installed package: ${name}`);
}
const parentEntries = parents.map((name) => require.resolve(name));
const scrollEntry = createRequire(parentEntries[0]!).resolve('react-remove-scroll');
const scrollRoot = packageRoot(scrollEntry, 'react-remove-scroll');
const preserved = {
  es5: ['53911aff8b4c924dea38d224a77cb40ee6968c735ec790a17910c3dcc0f8a8b2', 'b8d9278ff014cde20975d9a3bd7609c4deea4a1fd26ef9300fdb3ee35c997357'],
  es2015: ['34aa87ebaa8612df28ebcbcd6a5b8e97eff71ca66e2fbdc18139d3365b44f421', 'b8d9278ff014cde20975d9a3bd7609c4deea4a1fd26ef9300fdb3ee35c997357'],
  es2019: ['53781199646e1f0bf6723dbd631c757a5a75cc4d247ab8882f3bda074e098fe6', '30e1c017516c3133caa22e6aafcfa90acc7c3cc49f618cb59c3aa65cb16eeca5'],
} as const;

describe('fixed-viewport scrollbar dependency closure', () => {
  it('removes the unresolved package from the exact lock graph through one scoped override', () => {
    const lock = yaml.parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
    const workspace = yaml.parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    expect(workspace.overrides['react-remove-scroll@2.7.2>react-remove-scroll-bar']).toBe('-');
    expect(workspace.patchedDependencies['react-remove-scroll@2.7.2']).toBe('patches/react-remove-scroll@2.7.2.patch');
    expect(Object.keys(lock.packages).some((name) => name.startsWith('react-remove-scroll-bar@'))).toBe(false);
    expect(Object.keys(lock.snapshots).some((name) => name.startsWith('react-remove-scroll-bar@'))).toBe(false);
    for (const snapshot of Object.values(lock.snapshots) as { dependencies?: Record<string, string> }[]) {
      expect(snapshot.dependencies ?? {}).not.toHaveProperty('react-remove-scroll-bar');
    }
    expect(() => createRequire(scrollEntry).resolve('react-remove-scroll-bar')).toThrow();
  });

  it('uses the same compatible focus and scroll owners in all three Radix consumers', () => {
    const focus = parentEntries.map((entry) => createRequire(entry).resolve('@radix-ui/react-focus-scope'));
    const scroll = parentEntries.map((entry) => createRequire(entry).resolve('react-remove-scroll'));
    expect(new Set(focus).size).toBe(1);
    expect(new Set(scroll).size).toBe(1);
    expect(JSON.parse(readFileSync(path.join(packageRoot(parentEntries[1]!, parents[1]!), 'package.json'), 'utf8')).version).toBe('1.1.23');
    expect(JSON.parse(readFileSync(path.join(packageRoot(focus[0]!, '@radix-ui/react-focus-scope'), 'package.json'), 'utf8')).version).toBe('1.1.16');
  });

  it.each(['es5', 'es2015', 'es2019'] as const)('preserves the exact published %s event-isolation implementation while removing its scrollbar imports', (level) => {
    const effect = readFileSync(path.join(scrollRoot, 'dist', level, 'SideEffect.js'), 'utf8');
    const ui = readFileSync(path.join(scrollRoot, 'dist', level, 'UI.js'), 'utf8');
    expect(effect).not.toContain('react-remove-scroll-bar');
    expect(ui).not.toContain('react-remove-scroll-bar');
    const start = effect.indexOf(level === 'es5' ? 'var react_style_singleton_1' : 'import { styleSingleton }');
    const end = effect.indexOf('    // Fate UI permanently locks');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // These SHA256 values come from the exact integrity-checked 2.7.2 tarball.
    expect(hash(effect.slice(start, end))).toBe(preserved[level][0]);
    expect(hash(effect.slice(effect.indexOf('function getOutermostShadowParent')))).toBe(preserved[level][1]);
  });

  it('preserves public class names and the exact full published licenses of retained packages', () => {
    const { RemoveScroll } = createRequire(scrollEntry)(scrollEntry);
    expect(RemoveScroll.classNames).toEqual({ fullWidth: 'width-before-scroll-bar', zeroRight: 'right-scroll-bar-position' });
    expect(hash(readFileSync(path.join(scrollRoot, 'LICENSE'), 'utf8'))).toBe('30f0cfddf483d1128e3610205020f2041a6c5e837aa999e0aa82e5576187d4a9');
    const popoverRoot = packageRoot(parentEntries[1]!, parents[1]!);
    expect(hash(readFileSync(path.join(popoverRoot, 'LICENSE'), 'utf8'))).toBe('0e80a2d229d2fd4fc7e8636142ec5d0ff0bc031f14c15b682e2ac01dfd5b5138');
  });
});
