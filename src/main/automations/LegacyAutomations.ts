import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  automationListSchema,
  type AutomationDefinition,
} from '../../shared/contracts/automations';
import type { AppLogService } from '../logging/AppLogService';

const AUTOMATION_DOCUMENT_VERSION = 1;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

const automationDocumentSchema = z.object({
  version: z.literal(AUTOMATION_DOCUMENT_VERSION),
  projectPath: z.string().min(1).max(32_000),
  automations: automationListSchema,
}).strict();

type AutomationDocument = z.infer<typeof automationDocumentSchema>;
type LogSink = Pick<AppLogService, 'write'>;

/** Canonical path of the retired Automation store's per-project document. */
export function legacyDocumentPath(projectPath: string, dataRoot: string): string {
  const normalized = path.normalize(path.resolve(projectPath)).normalize('NFC');
  const canonical = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  const projectKey = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return path.join(dataRoot, projectKey, 'automations.json');
}

/**
 * Read-only access to the retired Automations store. The Automations tab was
 * merged into the Agents library; legacy documents remain in place so the
 * Agents "Legacy Import" view can copy them into TaskTemplates. Nothing here
 * writes: the archived source is preserved byte-for-byte for rollback proofs.
 */
export class LegacyAutomations {
  constructor(
    private readonly logs: LogSink,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.join(path.resolve(process.env.FATE_GUI_DATA_DIR), 'automations', 'v1')
      : path.join(os.homedir(), '.pi', 'fateGUI', 'automations', 'v1'),
    private readonly maxDocumentBytes = MAX_DOCUMENT_BYTES,
  ) {}

  async list(projectPath: string): Promise<AutomationDefinition[]> {
    const document = await this.readDocument(projectPath);
    return document.automations;
  }

  private async readDocument(projectPath: string): Promise<AutomationDocument> {
    const target = legacyDocumentPath(projectPath, this.dataRoot);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxDocumentBytes) throw new Error('Saved automation data exceeds its size limit.');
      const document = automationDocumentSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      const canonical = (value: string) => {
        const normalized = path.normalize(path.resolve(value)).normalize('NFC');
        return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
      };
      if (canonical(document.projectPath) !== canonical(projectPath)) {
        throw new Error('Saved automation data belongs to a different project.');
      }
      return { ...document, automations: [...document.automations].sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: AUTOMATION_DOCUMENT_VERSION, projectPath, automations: [] };
      this.logs.write('warn', 'automations', `Saved automations were ignored: ${error instanceof Error ? error.message : String(error)}`);
      return { version: AUTOMATION_DOCUMENT_VERSION, projectPath, automations: [] };
    }
  }
}
