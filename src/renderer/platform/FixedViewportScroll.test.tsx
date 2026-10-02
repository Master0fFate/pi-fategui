import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Select from '@radix-ui/react-select';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sourceRoot = path.resolve('src/renderer');
const css = readFileSync(path.join(sourceRoot, 'styles/global.css'), 'utf8');
const viewportRule = /html,\s*body,\s*#root\s*\{([^}]+)\}/u.exec(css)?.[0];
let style: HTMLStyleElement;
let background: HTMLDivElement;

function scrollable(element: HTMLElement) {
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 100 },
  });
  element.scrollTop = 100;
}
function wheel(element: HTMLElement) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 });
  fireEvent(element, event);
  return event.defaultPrevented;
}
function touch(element: HTMLElement, type: string, y: number, count = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = Array.from({ length: count }, (_, index) => ({ clientX: index * 10, clientY: y, target: element }));
  Object.defineProperties(event, { touches: { value: points }, changedTouches: { value: points } });
  fireEvent(element, event);
  return event.defaultPrevented;
}
function NestedControls({ kind }: { kind: 'select' | 'popover' }) {
  if (kind === 'popover') return <Popover.Root modal>
    <Popover.Trigger>Open nested popover</Popover.Trigger>
    <Popover.Portal><Popover.Content aria-label="Nested popover" data-testid="nested-scroll">
      <button>Popover action</button><Popover.Close>Close nested popover</Popover.Close>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
  return <Select.Root defaultValue="a">
    <Select.Trigger aria-label="Nested selection"><Select.Value /></Select.Trigger>
    <Select.Portal><Select.Content position="popper"><Select.Viewport data-testid="nested-scroll">
      <Select.Item value="a"><Select.ItemText>Option A</Select.ItemText></Select.Item>
      <Select.Item value="b"><Select.ItemText>Option B</Select.ItemText></Select.Item>
    </Select.Viewport></Select.Content></Select.Portal>
  </Select.Root>;
}
function Fixture({ kind = 'select' }: { kind?: 'select' | 'popover' }) {
  const [open, setOpen] = useState(false);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger>Open test dialog</Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay data-testid="dialog-overlay" />
      <Dialog.Content aria-describedby={undefined}>
        <Dialog.Title>Scroll isolation fixture</Dialog.Title>
        <div data-testid="dialog-scroll"><button>Dialog action</button><NestedControls kind={kind} /></div>
        <Dialog.Close>Close test dialog</Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
beforeEach(() => {
  style = document.createElement('style');
  style.textContent = viewportRule ?? '';
  document.head.append(style);
  background = document.createElement('div');
  background.textContent = 'Outside scrolling pane';
  document.body.append(background);
  scrollable(background);
});
afterEach(() => {
  cleanup();
  style.remove();
  background.remove();
});

describe('Fate fixed-viewport Radix scroll policy', () => {
  it('keeps the same permanent non-scrolling body invariant in both renderer entries', () => {
    expect(viewportRule).toBeDefined();
    for (const declaration of ['width: 100%', 'height: 100%', 'margin: 0', 'overflow: hidden']) expect(viewportRule).toContain(declaration);
    for (const entry of ['main.tsx', 'web-entry.tsx']) {
      expect(readFileSync(path.join(sourceRoot, entry), 'utf8')).toContain("import './styles/global.css'");
    }
    expect(getComputedStyle(document.body).overflow).toBe('hidden');
    expect(getComputedStyle(document.documentElement).overflow).toBe('hidden');
  });

  it.each(['select', 'popover'] as const)('preserves nested %s scroll isolation, Escape and focus restoration without body scrollbar mutation', async (kind) => {
    const user = userEvent.setup();
    const mutations: string[] = [];
    const observer = new MutationObserver((records) => records.forEach((record) => { if (record.attributeName === 'data-scroll-locked') mutations.push(record.attributeName); }));
    observer.observe(document.body, { attributes: true });
    const original = ['overflow', 'margin-right', 'padding-right', 'position', 'width'].map((name) => document.body.style.getPropertyValue(name));
    const view = render(<Fixture kind={kind} />);
    try {
      const opener = screen.getByRole('button', { name: 'Open test dialog' });
      await user.click(opener);
      const pane = await screen.findByTestId('dialog-scroll');
      scrollable(pane);
      expect(wheel(background)).toBe(true);
      expect(wheel(pane)).toBe(false); // Dialog's content shard remains scrollable outside its overlay.
      touch(background, 'touchstart', 50);
      expect(touch(background, 'touchmove', 30)).toBe(true);
      touch(pane, 'touchstart', 50);
      expect(touch(pane, 'touchmove', 30)).toBe(false);
      expect(touch(pane, 'touchmove', 20, 2)).toBe(false); // Radix allowPinchZoom remains effective.
      const nestedTrigger = kind === 'select' ? screen.getByRole('combobox', { name: 'Nested selection' })
        : screen.getByRole('button', { name: 'Open nested popover' });
      await user.click(nestedTrigger);
      const nested = await screen.findByTestId('nested-scroll');
      scrollable(nested);
      expect(wheel(background)).toBe(true);
      expect(wheel(pane)).toBe(true);
      expect(wheel(nested)).toBe(false);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('nested-scroll')).toBeNull());
      expect(nestedTrigger).toHaveFocus();
      expect(wheel(pane)).toBe(false);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(opener).toHaveFocus();
      expect(wheel(background)).toBe(false);
      await act(async () => {});
      expect(mutations).toEqual([]);
      expect(document.body).not.toHaveAttribute('data-scroll-locked');
      expect(['overflow', 'margin-right', 'padding-right', 'position', 'width'].map((name) => document.body.style.getPropertyValue(name))).toEqual(original);
    } finally { observer.disconnect(); view.unmount(); }
  });

  it('cleans isolation after repeated reopening and unmount while a modal is open', async () => {
    const user = userEvent.setup();
    const view = render(<Fixture />);
    for (let index = 0; index < 3; index++) {
      await user.click(screen.getByRole('button', { name: 'Open test dialog' }));
      await screen.findByRole('dialog');
      expect(wheel(background)).toBe(true);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(wheel(background)).toBe(false);
    }
    await user.click(screen.getByRole('button', { name: 'Open test dialog' }));
    await screen.findByRole('dialog');
    view.unmount();
    expect(wheel(background)).toBe(false);
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
  });
});
