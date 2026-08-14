import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mutationAttestationSchema,
  type AttestationQueryInput,
  type AttestationQueryResult,
  type MutationAttestation,
} from '../../../shared/contracts/mutationAttestation';
import type { AppLogService } from '../../logging/AppLogService';
import { pruneAttestations, projectPathHash } from './attestationRecord';

const DEFAULT_MAX_RECORDS = 4_096;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Age sweeps also run on this cadence, independent of count/byte triggers. */
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface MutationAttestationLedgerOptions {
  maxRecords?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  sweepIntervalMs?: number;
  /**
   * Electron instance/profile slot isolating concurrent --new-instance ledgers.
   * Slot 1 (the default) keeps the unsuffixed file for migration compatibility;
   * slots > 1 use a safe `.slot-N` suffix so concurrent processes never share one
   * per-project file (concurrent append+compaction would otherwise lose rows).
   */
  instanceSlot?: number;
}

/**
 * Per-project, logically append-only JSONL ledger of mutation attestations.
 * Bounded independently by records, bytes, and age with atomic compaction.
 * Corrupt lines are skipped with a warning, never throwing. File mode 0600 /
 * dir 0700 on POSIX. Stores only validated attestations (hashes + project-
 * relative paths + actor context); never content, diffs, commands, absolute
 * paths, or credentials.
 */
export class MutationAttestationLedger {
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly counts = new Map<string, number>();
  private readonly lastSweep = new Map<string, number>();
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly instanceSlot: number;

  constructor(
    private readonly logs: AppLogService,
    private readonly dataRoot: string = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
    options: MutationAttestationLedgerOptions = {},
  ) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.instanceSlot !== undefined && (!Number.isSafeInteger(options.instanceSlot) || options.instanceSlot < 1)) {
      throw new Error('The attestation ledger instance slot must be a positive safe integer.');
    }
    this.instanceSlot = options.instanceSlot ?? 1;
  }

  /** Append a validated attestation, then compact if any bound or sweep is due. */
  record(attestation: MutationAttestation): Promise<void> {
    const parsed = mutationAttestationSchema.safeParse(attestation);
    if (!parsed.success) {
      this.logs.write('warn', 'attestations', 'Rejected an invalid mutation attestation.');
      return Promise.resolve();
    }
    const row = parsed.data;
    if (this.disposed) {
      this.logs.write('warn', 'attestations', 'Rejected an attestation recorded after disposal.');
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const hash = row.projectPathHash;
      const file = this.filePath(hash);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
      await this.enforceMode(path.dirname(file), DIR_MODE);
      // Establish the true count on first record for this project so count
      // enforcement survives restart without waiting for a byte-trigger.
      if (this.counts.get(hash) === undefined) {
        this.counts.set(hash, (await this.readAll(hash)).length);
      }
      await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: FILE_MODE });
      await this.enforceMode(file, FILE_MODE);
      this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1);
      await this.maybeCompact(hash);
    });
  }

  /** Read, validate, filter, and bound. Returns the most recent window in chronological order. */
  async query(input: AttestationQueryInput): Promise<AttestationQueryResult> {
    await this.writeQueue;
    const hash = projectPathHash(input.projectPath);
    const rows = await this.readAll(hash);
    // Enforce logical age on read too, so old rows do not reappear when no write
    // has triggered a sweep (for example after restart or read-only use).
    const cutoff = Date.now() - this.maxAgeMs;
    const fresh = rows.filter((row) => row.recordedAt >= cutoff);
    const prefix = input.pathPrefix ? input.pathPrefix.replace(/\/+$/, '') : '';
    const matching = prefix ? fresh.filter((row) => row.path === prefix || row.path.startsWith(`${prefix}/`)) : fresh;
    const truncated = matching.length > input.limit;
    const window = truncated ? matching.slice(matching.length - input.limit) : matching;
    return { rows: window, truncated };
  }

  /** Resolve all queued writes. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  dispose(): void {
    this.disposed = true;
  }

  private filePath(hash: string): string {
    // Slot 1 keeps the unsuffixed file (migration compatibility); slots > 1 use
    // a safe `.slot-N` suffix so concurrent --new-instance processes isolate.
    const suffix = this.instanceSlot > 1 ? `.slot-${this.instanceSlot}` : '';
    return path.join(this.dataRoot, 'attestations', `${hash}${suffix}.jsonl`);
  }

  private async readAll(hash: string): Promise<MutationAttestation[]> {
    const file = this.filePath(hash);
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: MutationAttestation[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch {
        this.logs.write('warn', 'attestations', 'Skipped a corrupt mutation attestation line.');
        continue;
      }
      const parsed = mutationAttestationSchema.safeParse(json);
      if (parsed.success) rows.push(parsed.data);
      else this.logs.write('warn', 'attestations', 'Skipped an invalid mutation attestation line.');
    }
    return rows;
  }

  private async maybeCompact(hash: string): Promise<void> {
    const file = this.filePath(hash);
    let sizeOver = false;
    try {
      if ((await fs.stat(file)).size > this.maxBytes) sizeOver = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const countOver = (this.counts.get(hash) ?? 0) > this.maxRecords;
    const sweepDue = Date.now() - (this.lastSweep.get(hash) ?? 0) > this.sweepIntervalMs;
    if (!countOver && !sizeOver && !sweepDue) return;
    const rows = await this.readAll(hash);
    const kept = pruneAttestations(rows, Date.now(), {
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      maxAgeMs: this.maxAgeMs,
    });
    await this.writeAtomic(hash, kept);
    this.counts.set(hash, kept.length);
    this.lastSweep.set(hash, Date.now());
  }

  private async writeAtomic(hash: string, rows: readonly MutationAttestation[]): Promise<void> {
    const file = this.filePath(hash);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const data = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
    await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
    try {
      await fs.writeFile(temp, data, { mode: FILE_MODE });
      await fs.rename(temp, file);
      await this.enforceMode(file, FILE_MODE);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The `mode` option only affects creation; tighten an existing permissive file/dir on POSIX. */
  private async enforceMode(target: string, mode: number): Promise<void> {
    if (process.platform === 'win32') return; // Mode bits are not meaningful on Windows.
    await fs.chmod(target, mode);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(async () => operation());
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }
}
