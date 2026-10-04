import { test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Generated evidence belongs to this test/retry, never the tracked screenshots.
export async function evidenceOutputPath(...segments: string[]): Promise<string> {
  const filePath = test.info().outputPath(...segments);
  await mkdir(path.dirname(filePath), { recursive: true });
  return filePath;
}
