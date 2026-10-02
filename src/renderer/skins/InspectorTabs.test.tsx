import * as Tabs from '@radix-ui/react-tabs';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, type Container } from 'postcss';
import { AppTooltip } from '../components/AppTooltip';
import { defaultComponents } from './default';
import { dreamcoreComponents } from './dreamcore';
import { m3ExpressiveComponents } from './m3Expressive';
import type { SkinComponents } from './types';

const groups = [
  ['Changes', 'Files'],
  ['Monitor', 'Goal', 'Agents', 'Tools', 'Activity'],
  ['Context', 'Resources'],
  ['Monitor', 'Goal', 'Agents / Tasks'],
];
const runLabels = groups[1]!;
const accessibleName = (label: string) => label === 'Agents' ? 'Subagent sessions, 2 active' : label;

// Presentation-only fixture: no Inspector feature, stores, bridge, or runtime.
function Fixture({ components, labels = runLabels }: { components: SkinComponents; labels?: string[] }) {
  const { TabContent } = components;
  const [active, setActive] = useState(labels[0]!);
  return <aside className="inspector"><Tabs.Root value={active} onValueChange={setActive}>
    <Tabs.List aria-label="Run views" className="inspector-secondary-tabs">
      {labels.map((label) => <AppTooltip key={label} content={label} delayDuration={0} wrapTrigger triggerClassName="inspector-secondary-tooltip">
        <Tabs.Trigger value={label} className="inspector-secondary-trigger" aria-label={accessibleName(label)}>
          <TabContent label={label} active={active === label} labelClassName="inspector-secondary-label" icon={<svg aria-hidden="true" data-testid={`icon-${label}`} />} />
        </Tabs.Trigger>
      </AppTooltip>)}
    </Tabs.List>
    {labels.map((label) => <Tabs.Content key={label} value={label}>{label} panel</Tabs.Content>)}
  </Tabs.Root></aside>;
}

describe('narrow inspector tab presentation', () => {
  it.each(groups.map((labels) => [labels]))('keeps distinct, nonempty Dreamcore short labels for %j', (labels) => {
    const { container } = render(<Fixture components={dreamcoreComponents} labels={labels} />);
    const shortLabels = [...container.querySelectorAll('.terminal-tab-short')];
    expect(shortLabels).toHaveLength(labels.length);
    expect(new Set(shortLabels.map((label) => label.textContent)).size).toBe(labels.length);
    shortLabels.forEach((short, index) => {
      expect(short.textContent).toHaveLength(2);
      expect(short).toHaveAttribute('aria-hidden', 'true');
      const tab = screen.getByRole('tab', { name: accessibleName(labels[index]!) });
      expect(tab.querySelector('.inspector-secondary-label')).toHaveTextContent(labels[index]!);
    });
  });

  it.each([
    ['default', defaultComponents], ['dreamcore', dreamcoreComponents], ['m3-expressive', m3ExpressiveComponents],
  ] as const)('preserves selection, keyboard navigation and full tooltip names in %s', async (_skin, components) => {
    render(<Fixture components={components} />);
    for (const label of [...runLabels, 'Monitor', 'Activity']) {
      const tab = screen.getByRole('tab', { name: accessibleName(label) });
      fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
      expect(tab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel')).toHaveTextContent(`${label} panel`);
    }
    const activity = screen.getByRole('tab', { name: 'Activity' });
    activity.focus();
    fireEvent.keyDown(activity, { key: 'ArrowLeft' });
    const tools = screen.getByRole('tab', { name: 'Tools' });
    await screen.findByText('Tools panel');
    expect(tools).toHaveFocus();
    expect(tools).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Tools');
    if (components !== dreamcoreComponents) {
      runLabels.forEach((label) => expect(screen.getByTestId(`icon-${label}`)).toBeInTheDocument());
    }
  });
});

const directory = dirname(fileURLToPath(import.meta.url));
const globalCss = parse(readFileSync(resolve(directory, '../styles/global.css'), 'utf8'));
const terminalCss = parse(readFileSync(resolve(directory, '../styles/skins/dreamcore-terminal.css'), 'utf8'));
function declarations(root: Container, selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  root.walkRules(selector, (rule) => { rule.walkDecls((decl) => { result[decl.prop] = decl.value; }); });
  return result;
}
function narrowContainer(root: Container): Container {
  let result: Container | undefined;
  root.walkAtRules('container', (rule) => { if (rule.params === '(max-width: 259px)') result = rule; });
  expect(result).toBeDefined();
  return result!;
}

describe('narrow inspector CSS contract (not browser geometry)', () => {
  it('lets five compact targets shrink without changing their 38px maximum or wide layout', () => {
    const narrow = narrowContainer(globalCss);
    expect(declarations(narrow, '.inspector-secondary-tooltip').flex).toBe('0 1 38px');
    expect(declarations(narrow, '.inspector-secondary-trigger').width).toBe('100%');
    expect(declarations(narrow, '.inspector-secondary-tabs').gap).toBe('8px');
    expect(declarations(narrow, '.inspector-secondary-label').display).toBe('none');
  });

  it('reveals only the Dreamcore inspector short counterpart at the label-hiding breakpoint', () => {
    expect(declarations(terminalCss, '.terminal-tab-short').display).toBe('none');
    const narrow = narrowContainer(terminalCss);
    expect(declarations(narrow, ':root[data-skin="dreamcore"] .inspector-secondary-trigger .terminal-tab-short').display).toBe('inline');
    expect(declarations(narrow, ':root[data-skin="dreamcore"] .inspector-secondary-trigger .terminal-tab').gap).toBe('2px');
  });
});
