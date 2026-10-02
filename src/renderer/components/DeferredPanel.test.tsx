import * as Tabs from '@radix-ui/react-tabs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { lazy, useEffect, useState, type ComponentType } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse, type Rule } from 'postcss';
import { describe, expect, it, vi } from 'vitest';
import { DeferredPanel } from './DeferredPanel';

const directory = dirname(fileURLToPath(import.meta.url));
const cases = [
  { file: '../features/shell/Sidebar.tsx', name: 'SidebarAgents', importPath: '../agents/SidebarAgents', value: 'agents', label: 'agents', className: 'empty-sessions', tabName: 'Agents', eager: 'Sessions' },
  { file: '../features/shell/Inspector.tsx', name: 'SubagentSessionsPanel', importPath: './SubagentSessionsPanel', value: 'sessions', label: 'agent sessions', className: 'inspector-empty', tabName: 'Subagent sessions', eager: 'Changes' },
] as const;

function deferredModule(label: string) {
  let finish!: (module: { default: ComponentType }) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<{ default: ComponentType }>((resolve, reject) => { finish = resolve; fail = reject; });
  const load = vi.fn(() => promise);
  const error = new Error('Panel chunk unavailable');
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Content() {
    useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
    return <p>{label} loaded</p>;
  }
  return {
    Panel: lazy(load), load, mounted, unmounted, error,
    resolve: () => act(async () => { finish({ default: Content }); await promise; }),
    reject: () => act(async () => { fail(error); await promise.catch(() => undefined); }),
  };
}

// Isolated presentation fixture: only Radix, React and the production boundary.
// Real panels, stores, bridges and runtime modules are never imported or mounted.
function Fixture({ target, Panel, initial = 'eager' }: { target: typeof cases[number]; Panel: ComponentType; initial?: string }) {
  const [active, setActive] = useState(initial);
  return <Tabs.Root value={active} onValueChange={setActive}>
    <Tabs.List aria-label="Panel navigation">
      <Tabs.Trigger value="eager">{target.eager}</Tabs.Trigger>
      <Tabs.Trigger value={target.value}>{target.tabName}</Tabs.Trigger>
      <Tabs.Trigger value="other">Other</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="eager">{target.eager} eager content</Tabs.Content>
    <Tabs.Content value={target.value}>
      <DeferredPanel label={target.label} className={target.className}><Panel /></DeferredPanel>
    </Tabs.Content>
    <Tabs.Content value="other">Other content</Tabs.Content>
  </Tabs.Root>;
}

function select(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

describe.each(cases)('$name deferred tab presentation', (target) => {
  it('keeps default content eager and defers the module until the tab is selected', async () => {
    const module = deferredModule(target.label);
    render(<Fixture target={target} Panel={module.Panel} />);
    expect(screen.getByRole('tabpanel', { name: target.eager })).toHaveTextContent(`${target.eager} eager content`);
    expect(module.load).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    select(target.tabName);
    const panel = screen.getByRole('tabpanel', { name: target.tabName });
    expect(within(panel).getByRole('status')).toHaveTextContent(`Loading ${target.label}…`);
    expect(screen.getByRole('tab', { name: target.tabName })).toHaveAttribute('aria-selected', 'true');
    expect(module.load).toHaveBeenCalledOnce();
    expect(module.mounted).not.toHaveBeenCalled();
    await module.resolve();
    expect(within(panel).getByText(`${target.label} loaded`)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(module.mounted).toHaveBeenCalledOnce();

    select(target.eager);
    expect(module.unmounted).toHaveBeenCalledOnce();
    select(target.tabName);
    expect(screen.getByText(`${target.label} loaded`)).toBeInTheDocument();
    expect(module.load).toHaveBeenCalledOnce();
    expect(module.mounted).toHaveBeenCalledTimes(2);
  });

  it('does not mount a delayed panel after newer navigation, and reuses the resolved module on return', async () => {
    const module = deferredModule(target.label);
    render(<Fixture target={target} Panel={module.Panel} />);
    select(target.tabName);
    select(target.tabName);
    select('Other');
    await module.resolve();
    expect(screen.getByRole('tabpanel', { name: 'Other' })).toHaveTextContent('Other content');
    expect(screen.queryByText(`${target.label} loaded`)).not.toBeInTheDocument();
    expect(module.mounted).not.toHaveBeenCalled();
    select(target.tabName);
    expect(screen.getByText(`${target.label} loaded`)).toBeInTheDocument();
    expect(module.load).toHaveBeenCalledOnce();
    expect(module.mounted).toHaveBeenCalledOnce();
  });

  it('keeps keyboard navigation available while an initially selected panel is pending', async () => {
    const module = deferredModule(target.label);
    render(<Fixture target={target} Panel={module.Panel} initial={target.value} />);
    expect(screen.getByRole('status')).toHaveTextContent(`Loading ${target.label}…`);
    const tab = screen.getByRole('tab', { name: target.tabName });
    tab.focus();
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Other' })).toHaveFocus());
    expect(screen.getByRole('tabpanel', { name: 'Other' })).toHaveTextContent('Other content');
    await module.resolve();
    expect(module.mounted).not.toHaveBeenCalled();
  });

  it('contains a rejected import, preserves navigation and does not promise that reopening retries it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const module = deferredModule(target.label);
    render(<Fixture target={target} Panel={module.Panel} initial={target.value} />);
    // React development mode also reports caught errors to jsdom's window.
    const onError = (event: ErrorEvent) => { if (event.error === module.error) event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      await module.reject();
      expect(screen.getByRole('alert')).toHaveTextContent(`Unable to load ${target.label}.`);
      expect(screen.getByRole('alert')).toHaveTextContent('Reload the app to try again.');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      select(target.eager);
      expect(screen.getByRole('tabpanel', { name: target.eager })).toHaveTextContent(`${target.eager} eager content`);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      select(target.tabName);
      expect(screen.getByRole('alert')).toHaveTextContent(`Unable to load ${target.label}.`);
      expect(module.load).toHaveBeenCalledOnce();
      expect(module.mounted).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});

function nodes<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return result;
}

function attribute(element: ts.JsxOpeningElement, name: string) {
  const attr = element.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === name);
  return attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined;
}

describe('production deferred panel source contracts (no runtime execution)', () => {
  it.each(cases)('keeps $name lazy within its existing tab content', (target) => {
    const text = readFileSync(resolve(directory, target.file), 'utf8');
    const source = ts.createSourceFile(target.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(nodes(source, ts.isImportDeclaration).some((node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === target.importPath)).toBe(false);
    const declaration = nodes(source, ts.isVariableDeclaration).find((node) => node.name.getText() === target.name)!;
    expect(declaration.initializer?.getText()).toMatch(/^lazy\(/u);
    const imports = nodes(declaration, ts.isCallExpression).filter((node) => node.expression.kind === ts.SyntaxKind.ImportKeyword);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.arguments[0]?.getText()).toBe(`'${target.importPath}'`);
    expect(declaration.getText()).toContain(`default: module.${target.name}`);

    const contents = nodes(source, ts.isJsxElement).filter((node) => node.openingElement.tagName.getText() === 'Tabs.Content');
    const content = contents.find((node) => attribute(node.openingElement, 'value') === target.value)!;
    const boundaries = nodes(content, ts.isJsxElement).filter((node) => node.openingElement.tagName.getText() === 'DeferredPanel');
    expect(boundaries).toHaveLength(1);
    expect(attribute(boundaries[0]!.openingElement, 'label')).toBe(target.label);
    expect(attribute(boundaries[0]!.openingElement, 'className')).toBe(target.className);
    const child = nodes(boundaries[0]!, ts.isJsxSelfClosingElement).find((node) => node.tagName.getText() === target.name);
    expect(child).toBeDefined();
    if (target.name === 'SubagentSessionsPanel') expect(child!.getText()).toContain('key={web ? confirmed?.header.snapshotId : undefined}');
  });

  it('preserves the default Sessions/Changes selection and eager Changes panel', () => {
    const ui = readFileSync(resolve(directory, '../stores/uiStore.ts'), 'utf8');
    expect(ui).toMatch(/sidebarTab:\s*'sessions'/u);
    expect(ui).toMatch(/inspectorTab:\s*'changes'/u);
    const inspector = readFileSync(resolve(directory, '../features/shell/Inspector.tsx'), 'utf8');
    expect(inspector).toContain("import { ChangesPanel } from '../diffs/ChangesPanel'");
    expect(inspector).toContain('<Tabs.Content value="changes" className="tab-content">{web ? <HostGitDetails /> : <ChangesPanel />}</Tabs.Content>');
  });

  it('keeps the global Agent run toast action styling available before the Agents chunk loads', () => {
    const global = parse(readFileSync(resolve(directory, '../styles/global.css'), 'utf8'));
    const agents = parse(readFileSync(resolve(directory, '../features/agents/agents.css'), 'utf8'));
    const rules: Rule[] = [];
    global.walkRules('.app-toast .agent-notice-action', (rule) => { rules.push(rule); });
    expect(rules).toHaveLength(1);
    const declarations: Record<string, string> = {};
    rules[0]!.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
    expect(declarations).toEqual({
      display: 'inline-flex', 'align-self': 'flex-start', width: 'auto', 'max-width': '100%', height: 'auto',
      margin: '0', padding: '0', 'border-radius': 'var(--surface-control-radius, 0)', color: 'var(--theme-accent)',
      font: 'inherit', 'font-size': 'var(--surface-font-size, .8em)', 'line-height': '1.5', 'text-decoration': 'underline',
    });
    agents.walkRules((rule) => { expect(rule.selector).not.toMatch(/\.app-toast|\.agent-notice-action/u); });
    expect(readFileSync(resolve(directory, './AppToast.tsx'), 'utf8')).toContain('className="agent-notice-action"');
    for (const entry of ['../main.tsx', '../web-entry.tsx']) {
      expect(readFileSync(resolve(directory, entry), 'utf8')).toContain("import './styles/global.css'");
    }
  });
});
