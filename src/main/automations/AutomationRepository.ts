import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  AUTOMATION_LIST_LIMIT,
  automationCreateInputSchema,
  automationDefinitionSchema,
  automationLaunchOutcomeSchema,
  automationListSchema,
  automationUpdateInputSchema,
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationLaunchOutcome,
  type AutomationUpdateInput,
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

/** Project-scoped, atomic persistence for manually launched automation definitions. */
export class AutomationRepository {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly logs: LogSink,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.join(path.resolve(process.env.FATE_GUI_DATA_DIR), 'automations', 'v1')
      : path.join(os.homedir(), '.pi', 'fateGUI', 'automations', 'v1'),
    private readonly maxDocumentBytes = MAX_DOCUMENT_BYTES,
  ) {}

  async list(projectPath: string): Promise<AutomationDefinition[]> {
    const key = canonicalProjectPath(projectPath);
    await this.queues.get(key)?.catch(() => undefined);
    return this.sorted((await this.readDocument(projectPath)).automations);
  }

  create(projectPath: string, input: AutomationCreateInput): Promise<AutomationDefinition> {
    const parsed = automationCreateInputSchema.parse(input);
    return this.enqueue(projectPath, async () => {
      const document = await this.readDocument(projectPath);
      this.assertUniqueName(document.automations, parsed.name);
      if (document.automations.length >= AUTOMATION_LIST_LIMIT) throw new Error(`A project can store at most ${AUTOMATION_LIST_LIMIT} automations.`);
      const now = Date.now();
      const automation = automationDefinitionSchema.parse({
        id: randomUUID(),
        projectPath,
        ...parsed,
        createdAt: now,
        updatedAt: now,
        lastLaunchedAt: null,
        lastLaunchOutcome: null,
        launchCount: 0,
      });
      document.automations.push(automation);
      await this.writeDocument(document);
      return automation;
    });
  }

  update(projectPath: string, input: AutomationUpdateInput): Promise<AutomationDefinition> {
    const parsed = automationUpdateInputSchema.parse(input);
    return this.enqueue(projectPath, async () => {
      const document = await this.readDocument(projectPath);
      const index = document.automations.findIndex((automation) => automation.id === parsed.id);
      if (index < 0) throw new Error('That automation no longer exists.');
      this.assertUniqueName(document.automations, parsed.name, parsed.id);
      const current = document.automations[index]!;
      const automation = automationDefinitionSchema.parse({
        ...current,
        name: parsed.name,
        prompt: parsed.prompt,
        permissionLevel: parsed.permissionLevel,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      });
      document.automations[index] = automation;
      await this.writeDocument(document);
      return automation;
    });
  }

  remove(projectPath: string, id: string): Promise<void> {
    return this.enqueue(projectPath, async () => {
      const document = await this.readDocument(projectPath);
      const next = document.automations.filter((automation) => automation.id !== id);
      if (next.length === document.automations.length) throw new Error('That automation no longer exists.');
      document.automations = next;
      await this.writeDocument(document);
    });
  }

  recordLaunch(projectPath: string, id: string, outcome: AutomationLaunchOutcome): Promise<AutomationDefinition> {
    const parsedOutcome = automationLaunchOutcomeSchema.parse(outcome);
    return this.enqueue(projectPath, async () => {
      const document = await this.readDocument(projectPath);
      const index = document.automations.findIndex((automation) => automation.id === id);
      if (index < 0) throw new Error('That automation no longer exists.');
      const current = document.automations[index]!;
      const launchedAt = Math.max(Date.now(), current.updatedAt + 1);
      const automation = automationDefinitionSchema.parse({
        ...current,
        updatedAt: launchedAt,
        lastLaunchedAt: launchedAt,
        lastLaunchOutcome: parsedOutcome,
        launchCount: Math.min(1_000_000_000, current.launchCount + 1),
      });
      document.automations[index] = automation;
      await this.writeDocument(document);
      return automation;
    });
  }

  private enqueue<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const key = canonicalProjectPath(projectPath);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.finally(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }

  private async readDocument(projectPath: string): Promise<AutomationDocument> {
    const target = this.documentPath(projectPath);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxDocumentBytes) throw new Error('Saved automation data exceeds its size limit.');
      const document = automationDocumentSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      if (canonicalProjectPath(document.projectPath) !== canonicalProjectPath(projectPath)) {
        throw new Error('Saved automation data belongs to a different project.');
      }
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.emptyDocument(projectPath);
      this.logs.write('warn', 'automations', `Saved automations were ignored: ${error instanceof Error ? error.message : String(error)}`);
      return this.emptyDocument(projectPath);
    }
  }

  private async writeDocument(document: AutomationDocument): Promise<void> {
    const parsed = automationDocumentSchema.parse({ ...document, automations: this.sorted(document.automations) });
    const target = this.documentPath(parsed.projectPath);
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxDocumentBytes) {
      throw new Error('Saved automations exceed the project storage limit. Shorten prompts or remove unused automations.');
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporary, 'w', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emptyDocument(projectPath: string): AutomationDocument {
    return { version: AUTOMATION_DOCUMENT_VERSION, projectPath, automations: [] };
  }

  private documentPath(projectPath: string): string {
    const projectKey = createHash('sha256').update(canonicalProjectPath(projectPath)).digest('hex').slice(0, 32);
    return path.join(this.dataRoot, projectKey, 'automations.json');
  }

  private sorted(automations: readonly AutomationDefinition[]): AutomationDefinition[] {
    return [...automations].sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  }

  private assertUniqueName(automations: readonly AutomationDefinition[], name: string, excludedId?: string): void {
    const key = name.toLocaleLowerCase();
    if (automations.some((automation) => automation.id !== excludedId && automation.name.toLocaleLowerCase() === key)) {
      throw new Error(`An automation named “${name}” already exists in this project.`);
    }
  }
}

function canonicalProjectPath(projectPath: string): string {
  const normalized = path.normalize(path.resolve(projectPath)).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
