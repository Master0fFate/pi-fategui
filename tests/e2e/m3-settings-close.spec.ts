import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

const execFileAsync = promisify(execFile);

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
      const nativeTarget = await app.evaluate(({ BrowserWindow, screen }, center) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        win.focus();
        const content = win.getContentBounds();
        const display = screen.getDisplayMatching(content);
        return {
          reportedPoint: screen.dipToScreenPoint({ x: Math.round(content.x + center.x), y: Math.round(content.y + center.y) }),
          content, bounds: win.getBounds(), scaleFactor: display.scaleFactor, displayBounds: display.bounds,
          focused: win.isFocused(), pid: process.pid, hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(),
        };
      }, { x: evidence.x, y: evidence.y });
      await page.evaluate(() => {
        const events: Array<{ type: string; trusted: boolean; insideClose: boolean; target: string; at: { x: number; y: number }; hit: string }> = [];
        (window as Window & { __t20NativeEvents?: typeof events }).__t20NativeEvents = events;
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          document.addEventListener(type, (event) => {
            const pointer = event as PointerEvent;
            const describe = (element: Element | null) => element?.getAttribute('aria-label') ?? element?.tagName ?? 'none';
            events.push({ type, trusted: event.isTrusted, insideClose: Boolean(document.querySelector('[aria-label="Close settings"]')?.contains(event.target as Node)), target: describe(event.target instanceof Element ? event.target : null),
              at: { x: pointer.clientX, y: pointer.clientY }, hit: describe(document.elementFromPoint(pointer.clientX, pointer.clientY)) });
          }, true);
        }
      });
      console.log('[T20 native before]', JSON.stringify(nativeTarget), 'DOM center', JSON.stringify({ x: evidence.x, y: evidence.y }));
      // A host window can sit above the Electron test window even when Electron
      // reports it focused. Put the test window at the top for this real OS click.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        win.setAlwaysOnTop(true, 'screen-saver');
        win.moveTop();
        win.focus();
      });
      try {
        // Sample DOM client coordinates AFTER raising the window. Absolute
        // Electron bounds above are diagnostic only: the helper maps this CSS
        // viewport to the current owned HWND's actual physical client rect.
        const activation = await dialog.getByRole('heading', { name: 'Settings', exact: true }).evaluate((heading) => {
          const box = heading.getBoundingClientRect();
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, ownsCenter: hit === heading || heading.contains(hit), width: window.innerWidth, height: window.innerHeight };
        });
        const nativeDom = await close.evaluate((button) => {
          const visual = button.querySelector('svg')!.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          const x = visual.x + visual.width / 2;
          const y = visual.y + visual.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
            visualContained: x >= box.left && x < box.right && y >= box.top && y < box.bottom,
            ownsCenter: hit === button || button.contains(hit) };
        });
        expect(activation.ownsCenter).toBe(true);
        expect(nativeDom.visualContained).toBe(true);
        expect(nativeDom.ownsCenter).toBe(true);
        expect({ width: activation.width, height: activation.height }).toEqual({ width: nativeDom.width, height: nativeDom.height });
        for (const point of [nativeDom, activation]) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThan(nativeDom.width);
          expect(point.y).toBeLessThan(nativeDom.height);
        }
        console.log('[T20 native DOM client]', JSON.stringify({ close: nativeDom, activation }));
        let pointerResult: string;
        try {
          // Keep the Playwright driver and Electron inspector/event transports
          // live while Windows performs activation and delivers native input.
          const result = await execFileAsync('powershell', [
            '-NoProfile', '-File', path.resolve('tests/e2e/m3-native-pointer.ps1'),
            '-TargetHwnd', nativeTarget.hwnd, '-ExpectedPid', String(nativeTarget.pid),
            '-ClientX', String(nativeDom.x), '-ClientY', String(nativeDom.y),
            '-ActivationClientX', String(activation.x), '-ActivationClientY', String(activation.y),
            '-ViewportWidth', String(nativeDom.width), '-ViewportHeight', String(nativeDom.height),
          ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
          pointerResult = result.stdout;
        } catch (error) {
          // execFile captures stdout on failure; keep exact native rect/DPI/
          // cloak/desktop/hit diagnostics visible when safety rejects a click.
          const failure = error as Error & { stdout?: string; stderr?: string };
          console.error('[T20 native refused]', failure.stdout ?? '', failure.stderr ?? '');
          // A mouse_event call has no insertion/delivery result. Preserve the
          // owned renderer receipt on refusal too, without any replacement click.
          try {
            console.error('[T20 native refusal renderer receipt]', JSON.stringify({
              events: await page.evaluate(() => (window as Window & { __t20NativeEvents?: Array<{ type: string; trusted: boolean; insideClose: boolean }> }).__t20NativeEvents ?? []),
              dialogVisible: await dialog.isVisible(),
              focused: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
            }));
          } catch (receiptError) {
            console.error('[T20 native refusal renderer unavailable]', String(receiptError));
          }
          throw error;
        }
        // Native input is queued by Windows. Require its observable completion
        // before reading the captured trusted event; no synthetic click follows.
        await expect(dialog).toBeHidden();
        const events = await page.evaluate(() => (window as Window & { __t20NativeEvents?: Array<{ type: string; trusted: boolean; insideClose: boolean }> }).__t20NativeEvents ?? []);
        console.log('[T20 native after]', pointerResult.trim(), 'events', JSON.stringify(events), 'focused', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()));
        expect(events.some((event) => event.type === 'click' && event.trusted && event.insideClose)).toBe(true);
      } finally {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setAlwaysOnTop(false));
      }
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
