import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type Root, type Rule } from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const globalCss = parse(readFileSync(resolve(directory, 'global.css'), 'utf8'));
const styledCss = parse(readFileSync(resolve(directory, 'skins/angelcore-surfaces.css'), 'utf8'));
const styledFocusSelector = ':root[data-skin][data-skin-styled] body :is(button, input, textarea, select, [tabindex]):focus-visible';
const searches = [
  ['sidebar-search', 'Search sessions'],
  ['file-search', 'Search project files'],
] as const;

function ruleFor(root: Root, selector: string): Rule {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.parent === root && rule.selectors.includes(selector)) rules.push(rule);
  });
  expect(rules, `unconditional rule for ${selector}`).toHaveLength(1);
  return rules[0]!;
}

function declarations(rule: Rule): Record<string, string> {
  const result: Record<string, string> = {};
  rule.walkDecls((decl) => {
    expect(decl.important, `${decl.prop} must remain overridable by skins`).toBeFalsy();
    result[decl.prop] = decl.value;
  });
  return result;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-skin');
  document.documentElement.removeAttribute('data-skin-styled');
});

describe('search focus CSS contract (not browser paint)', () => {
  it.each(searches)('gives .%s focus more specificity than its later input reset', (className) => {
    // Class + :focus-visible + input beats the later class + input reset.
    // The generic input:focus-visible alone ties that reset and loses by order.
    const focused = ruleFor(globalCss, `.${className} input:focus-visible`);
    const reset = ruleFor(globalCss, `.${className} input`);
    expect(focused).toBe(ruleFor(globalCss, 'input:focus-visible'));
    expect(declarations(focused)).toEqual({
      outline: '2px solid var(--theme-accent)',
      'outline-offset': '2px',
    });
    expect(declarations(reset)).toMatchObject({ outline: '0', border: '0', background: 'transparent' });
  });

  it('retains the stronger shared skin focus rule and unrelated global focus targets', () => {
    expect(declarations(ruleFor(styledCss, styledFocusSelector))).toEqual({
      outline: '1px solid var(--theme-accent)',
      'outline-offset': '2px',
    });
    const focused = ruleFor(globalCss, 'input:focus-visible');
    for (const selector of ['button:focus-visible', 'textarea:focus-visible', '[tabindex]:focus-visible']) {
      expect(ruleFor(globalCss, selector)).toBe(focused);
    }
  });
});

describe.each(['default', 'dreamcore', 'm3-expressive'] as const)('%s search keyboard presentation', (skin) => {
  it.each(searches)('matches focus styling only while .%s is focused, including reverse and repeated tabbing', async (className, name) => {
    document.documentElement.dataset.skin = skin;
    if (skin !== 'default') document.documentElement.dataset.skinStyled = 'true';
    const user = userEvent.setup();
    // Presentation-only markup: no feature components, stores, bridge or runtime.
    render(<>
      <label className={className}>
        <svg aria-hidden="true" />
        <input aria-label={name} placeholder={name} />
      </label>
      <button type="button">Next control</button>
    </>);
    const input = screen.getByRole('textbox', { name });
    const focusedSelector = `.${className} input:focus-visible`;
    const resetSelector = `.${className} input`;
    expect(input.matches(resetSelector)).toBe(true);
    expect(input.matches(focusedSelector)).toBe(false);

    for (let pass = 0; pass < 2; pass += 1) {
      await user.tab(pass === 0 ? undefined : { shift: true });
      expect(input).toHaveFocus();
      expect(input.matches(focusedSelector)).toBe(true);
      expect(input.matches(styledFocusSelector)).toBe(skin !== 'default');
      await user.keyboard('{End}query');
      expect(input).toHaveValue('query'.repeat(pass + 1));
      await user.tab();
      expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
      expect(input.matches(focusedSelector)).toBe(false);
      expect(input.matches(styledFocusSelector)).toBe(false);
      expect(input.matches(resetSelector)).toBe(true);
    }
  });
});
