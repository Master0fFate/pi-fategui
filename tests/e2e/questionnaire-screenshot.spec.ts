import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';
import { evidenceOutputPath } from './evidenceOutputPath';

const skins = [
  { id: 'default', theme: 'midnight', name: 'Default' },
  { id: 'dreamcore', theme: 'monochrome', name: 'Angelcore' },
  { id: 'm3-expressive', theme: 'm3-expressive', name: 'M3 Expressive' },
] as const;

async function openQuestionnaire(skin: typeof skins[number], long = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-questionnaire-'));
  const project = path.join(root, 'Questionnaire Preview');
  const userData = path.join(root, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(project, 'README.md'), '# Questionnaire preview\n');
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
    appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
    terminalShell: null, reduceMotion: false, skinId: skin.id, themeId: skin.theme,
  })));
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: {
      ...process.env,
      PI_DESKTOP_E2E_PROJECT: project,
      PI_DESKTOP_E2E_USER_DATA: userData,
      PI_DESKTOP_E2E_QUESTIONNAIRE: '1',
      ...(long ? { PI_DESKTOP_E2E_QUESTIONNAIRE_LONG: '1' } : {}),
      FATE_GUI_DATA_DIR: dataRoot,
      PI_OFFLINE: '1',
    },
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Open project/u }).first().click();
  return { root, application, page };
}

async function captureQuestionDetail(page: Page, filePath: string) {
  const question = await page.locator('.question-card').boundingBox();
  const composer = await page.locator('.composer').boundingBox();
  if (!question || !composer) throw new Error('Question or composer is not visible for screenshot.');
  const x = Math.floor(Math.min(question.x, composer.x));
  const y = Math.floor(Math.min(question.y, composer.y));
  const right = Math.ceil(Math.max(question.x + question.width, composer.x + composer.width));
  const bottom = Math.ceil(Math.max(question.y + question.height, composer.y + composer.height));
  await page.screenshot({ path: filePath, clip: { x, y, width: right - x, height: bottom - y } });
}

async function assertQuestionnaire(page: Page, skin: typeof skins[number]) {
  const card = page.locator('.question-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('Question 1 / 3')).toBeVisible();
  await expect(card.locator('.question-card-option')).toHaveCount(3);
  await expect(card.getByPlaceholder('Write your own answer...')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin.id);
  const cardBox = await card.boundingBox();
  const composerBox = await page.locator('.composer').boundingBox();
  expect(cardBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
  await card.evaluate((node: HTMLElement) => { node.style.display = 'none'; });
  const withoutQuestion = await page.locator('.composer').boundingBox();
  await card.evaluate((node: HTMLElement) => { node.style.removeProperty('display'); });
  expect(withoutQuestion).not.toBeNull();
  expect(Math.abs(composerBox!.y - withoutQuestion!.y)).toBeLessThanOrEqual(1);
  const choiceCenterOffsets = await card.locator('.question-card-option').evaluateAll((buttons) => buttons.map((button) => {
    const label = button.querySelector('span')!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const row = button.getBoundingClientRect();
    return (text.top + text.height / 2) - (row.top + row.height / 2);
  }));
  for (const offset of choiceCenterOffsets) expect(Math.abs(offset), 'Choice label must sit at the row center').toBeLessThanOrEqual(2);
}

for (const skin of skins) {
  test(`questionnaire uses the ${skin.name} skin above the composer`, async () => {
    const { root, application, page } = await openQuestionnaire(skin);
    try {
      await assertQuestionnaire(page, skin);
      await expect(page.locator('.question-card-option')).toHaveText(['Overview', 'Recent work', 'Last view']);
      if (process.env.FATE_CAPTURE_QUESTIONNAIRE) {
        await page.screenshot({ path: await evidenceOutputPath('questionnaire', `${skin.id}.png`) });
        await captureQuestionDetail(page, await evidenceOutputPath('questionnaire', `${skin.id}-detail.png`));
      }
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const skin of skins) {
  test(`long questions and options wrap without clipping in ${skin.name}`, async () => {
    const { root, application, page } = await openQuestionnaire(skin, true);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await assertQuestionnaire(page, skin);
      const heading = page.locator('.question-card-question');
      const longOption = page.locator('.question-card-option').nth(1);
      await expect(heading).toContainText('Keep the choice clear');
      await expect(longOption).toContainText('you can resume work');
      const layout = await page.locator('.question-card').evaluate((card) => {
        const heading = card.querySelector<HTMLElement>('.question-card-question')!;
        const option = card.querySelector<HTMLElement>('.question-card-option:nth-child(2)')!;
        const optionLabel = option.querySelector<HTMLElement>('span')!;
        return {
          headingLines: heading.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(heading).lineHeight),
          optionLines: optionLabel.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(optionLabel).lineHeight),
          cardOverflow: card.scrollWidth > card.clientWidth,
          headingOverflow: heading.scrollWidth > heading.clientWidth,
          optionOverflow: option.scrollWidth > option.clientWidth,
        };
      });
      expect(layout.headingLines).toBeGreaterThan(1.8);
      expect(layout.optionLines).toBeGreaterThan(1.8);
      expect(layout.cardOverflow || layout.headingOverflow || layout.optionOverflow).toBe(false);
      if (process.env.FATE_CAPTURE_QUESTIONNAIRE) {
        await captureQuestionDetail(page, await evidenceOutputPath('questionnaire', `${skin.id}-long-detail.png`));
      }
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
