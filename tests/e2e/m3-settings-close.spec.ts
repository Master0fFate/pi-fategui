import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('M3 noncompact Settings close owns its visible pointer target and supports keyboard', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-m3-settings-'));
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  const project = path.join(directory, 'project');
  await mkdir(project);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
    appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false,
    skinId: 'm3-expressive', themeId: 'midnight', compactMode: false, compactSessions: false,
    skinAppearanceOverrides: { 'm3-expressive': { compactMode: false, compactSessions: false } },
  })));
  const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: {
    ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData,
    FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1',
  } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 720));
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'false');
    await page.getByRole('button', { name: 'Collapse inspector' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const close = dialog.getByRole('button', { name: 'Close settings' });
    await expect(close).toBeVisible();
    await page.waitForTimeout(300);
    const evidence = await close.evaluate((button) => {
      const describe = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, class: element.getAttribute('class'), box: box.toJSON(), position: style.position,
          zIndex: style.zIndex, pointerEvents: style.pointerEvents, appRegion: style.getPropertyValue('-webkit-app-region'), transform: style.transform };
      };
      const box = button.getBoundingClientRect();
      const icon = button.querySelector('svg')!;
      const visual = icon.getBoundingClientRect();
      const x = visual.x + visual.width / 2;
      const y = visual.y + visual.height / 2;
      const hit = document.elementFromPoint(x, y)!;
      return { button: describe(button), icon: describe(icon), hit: describe(hit),
        ancestors: [button.parentElement!, button.closest('[role="dialog"]')!].map(describe),
        dragLayers: [...document.querySelectorAll('*')].filter((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag').map(describe),
        visualContained: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
        ownsVisualCenter: button === hit || button.contains(hit), x, y };
    });
    // DOM hit testing alone misses Electron's native drag hit test. Keep the X
    // over the underlying M3 header so this exercises the original failure.
    expect(evidence.dragLayers.some(({ box }) => evidence.x >= box.left && evidence.x <= box.right
      && evidence.y >= box.top && evidence.y <= box.bottom)).toBe(true);
    expect(evidence.button.appRegion).toBe('no-drag');
    expect(evidence.button.pointerEvents).toBe('auto');
    await expect(page.locator('.dialog-overlay')).toHaveCSS('-webkit-app-region', 'no-drag');
    await mkdir('screenshots/m3-expressive', { recursive: true });
    await page.screenshot({ path: 'screenshots/m3-expressive/settings-noncompact-close.png' });
    expect(evidence.visualContained).toBe(true);
    expect(evidence.ownsVisualCenter).toBe(true);
    if (process.platform === 'win32') {
      // CDP mouse events bypass Windows' non-client drag handling. Exercise an
      // actual OS pointer too; no force clicks or direct event/handler dispatch.
      const point = await app.evaluate(({ BrowserWindow, screen }, center) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        win.focus();
        const bounds = win.getContentBounds();
        return screen.dipToScreenPoint({ x: Math.round(bounds.x + center.x), y: Math.round(bounds.y + center.y) });
      }, { x: evidence.x, y: evidence.y });
      execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); }'; [Mouse]::SetProcessDPIAware(); [Mouse]::SetCursorPos(${point.x}, ${point.y}); [Mouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Mouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`]);
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    await page.mouse.click(evidence.x, evidence.y);
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (let index = 0; index < 20 && !await close.evaluate((button) => button === document.activeElement); index += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();

    // Audit another header close sharing the modal backdrop construction.
    await page.keyboard.press('ControlOrMeta+k');
    const commandClose = page.getByRole('button', { name: 'Close command center' });
    await expect(commandClose).toBeVisible();
    const commandCenter = await commandClose.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, ownsCenter: hit === button || button.contains(hit) };
    });
    expect(commandCenter.ownsCenter).toBe(true);
    await page.mouse.click(commandCenter.x, commandCenter.y);
    await expect(commandClose).toBeHidden();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
