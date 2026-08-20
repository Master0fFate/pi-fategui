import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CRASH_REPORT_STACK_LINES = 40;

export interface CrashReport {
  version: string;
  os: string;
  arch: string;
  stack: string;
  writtenAt: number;
}

export function sanitizeCrashStack(stack: string): string {
  const redacted = stack
    .replace(/(?:[A-Za-z]:)?[\\/]+Users[\\/]+[^\\/\s)]+/gu, '~')
    .replace(/[\\/]+home[\\/]+[^\\/\s)]+/gu, '~');
  return redacted.split(/\r?\n/u).slice(0, CRASH_REPORT_STACK_LINES).join('\n');
}

export function buildCrashReport(input: { version: string; os?: string; arch?: string; stack: string; now?: number }): CrashReport {
  return {
    version: input.version,
    os: input.os ?? `${os.platform()} ${os.release()}`,
    arch: input.arch ?? os.arch(),
    stack: sanitizeCrashStack(input.stack),
    writtenAt: input.now ?? Date.now(),
  };
}

export class CrashTelemetryService {
  constructor(
    private readonly directory: string,
    private readonly enabled: () => boolean,
    private readonly version: () => string,
    private readonly writeFile: (filePath: string, contents: string) => Promise<void> = (filePath, contents) => fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 }),
    private readonly ensureDir: (directory: string) => Promise<void> = (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined),
  ) {}

  async record(stack: string): Promise<string | null> {
    if (!this.enabled()) return null;
    const report = buildCrashReport({ version: this.version(), stack });
    await this.ensureDir(this.directory);
    const filePath = path.join(this.directory, `crash-${report.writtenAt}.json`);
    await this.writeFile(filePath, `${JSON.stringify(report)}\n`);
    return filePath;
  }
}
