import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PermissionLevel } from '../../shared/contracts/ipc';
import { rasterImageMimeType } from '../files/FilesystemService';
import { PiDesktopError } from './errors';
import { createConfiguredImageGenerator, createGenerateImageTool, type ImageGenerationSettingsResolver } from './PiImageTool';
import {
  MAX_PRE_HASH_BYTES,
  type AttestationContext,
  type AttestationRecordInput,
  type AttestationSink,
} from './provenance/attestationRecord';

const MAX_PI_READ_BYTES = 8 * 1024 * 1024;

const toolsByPermissionLevel: Record<PermissionLevel, readonly string[]> = {
  'read-only': ['read', 'generate_image'],
  edit: ['read', 'write', 'edit', 'generate_image'],
  'full-access': ['read', 'write', 'edit', 'bash', 'generate_image'],
};
const permissionControlledTools = new Set(['read', 'write', 'edit', 'bash', 'generate_image']);

/** Minimum child permission that grants each ordinary tool. */
const toolMinimumPermission: Record<string, PermissionLevel> = {
  read: 'read-only',
  grep: 'read-only',
  find: 'read-only',
  ls: 'read-only',
  generate_image: 'read-only',
  write: 'edit',
  edit: 'edit',
  bash: 'full-access',
};

export function requiredPermissionForTool(tool: string): PermissionLevel | undefined {
  return toolMinimumPermission[tool];
}

export function activeToolsForPermission(activeTools: readonly string[], level: PermissionLevel): string[] {
  const allowed = new Set(toolsByPermissionLevel[level]);
  const selected = activeTools.filter((name) => !permissionControlledTools.has(name) || allowed.has(name));
  for (const name of toolsByPermissionLevel[level]) if (!selected.includes(name)) selected.push(name);
  return selected;
}

export function toolNamesForPermission(level: PermissionLevel): string[] {
  return [...toolsByPermissionLevel[level]];
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export interface ProjectToolAccess {
  fullAccess: boolean;
}

type ReadableRoots = readonly string[] | (() => readonly string[]);

export class ProjectPathPolicy {
  private constructor(
    private readonly root: string,
    private readonly access: ProjectToolAccess,
    private readonly readableRoots: ReadableRoots,
  ) {}

  static async create(
    root: string,
    access: ProjectToolAccess = { fullAccess: false },
    readableRoots: ReadableRoots = [],
  ): Promise<ProjectPathPolicy> {
    return new ProjectPathPolicy(path.normalize(await fs.realpath(root)), access, readableRoots);
  }

  async readable(input: string): Promise<string> {
    const target = this.resolveInput(input);
    const canonical = path.normalize(await fs.realpath(target));
    if (this.access.fullAccess || isContained(this.root, canonical)) return canonical;
    const configuredRoots = typeof this.readableRoots === 'function' ? this.readableRoots() : this.readableRoots;
    for (const configuredRoot of new Set(configuredRoots)) {
      try {
        const approvedRoot = path.normalize(await fs.realpath(configuredRoot));
        if (isContained(approvedRoot, canonical)) return canonical;
      } catch {
        // A resource removed during reload is no longer readable.
      }
    }
    throw this.denied('Pi can read only the active project and currently loaded skill resources.');
  }

  async existing(input: string): Promise<string> {
    const target = this.lexical(input);
    const canonical = path.normalize(await fs.realpath(target));
    if (!this.access.fullAccess) this.assertContained(canonical);
    return canonical;
  }

  async writable(input: string): Promise<string> {
    const target = this.lexical(input);
    if (this.access.fullAccess) return target;
    try {
      const canonical = path.normalize(await fs.realpath(target));
      this.assertContained(canonical);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let ancestor = path.dirname(target);
    while (true) {
      try {
        const canonicalAncestor = path.normalize(await fs.realpath(ancestor));
        this.assertContained(canonicalAncestor);
        const canonicalTarget = path.resolve(canonicalAncestor, path.relative(ancestor, target));
        this.assertContained(canonicalTarget);
        return canonicalTarget;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  private resolveInput(input: string): string {
    if (!input.trim()) throw this.denied();
    return path.resolve(this.root, input);
  }

  private lexical(input: string): string {
    const target = this.resolveInput(input);
    if (!this.access.fullAccess) this.assertContained(target);
    return target;
  }

  private assertContained(candidate: string): void {
    if (!isContained(this.root, candidate)) throw this.denied();
  }

  private denied(message = 'Pi file tools can access only the active project directory.'): PiDesktopError {
    return new PiDesktopError({
      code: 'INVALID_PROJECT',
      message,
      retryable: false,
    });
  }
}

/** Minimal handle surface for a seek-safe positioned write loop. */
export interface PositionedFileHandle {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
}

/**
 * Seek-safe positioned write loop. Never assumes a single `handle.write` writes
 * all bytes: it advances the offset and position until the whole buffer is
 * flushed. Exposed so partial-write behavior can be unit-tested directly.
 */
export async function writeAllPositioned(handle: PositionedFileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, written);
    if (bytesWritten <= 0) throw new Error('Unable to write the complete file content.');
    written += bytesWritten;
  }
}

export interface SecureWriteDeps {
  policy: ProjectPathPolicy;
  access: ProjectToolAccess;
  canonicalCwd: string;
  /** When provided, successful controlled write/edit operations are attested. */
  attestations?: AttestationSink;
  /** Maximum prior-state bytes hashed in memory before recording oversize. */
  maxPreHashBytes?: number;
}

/**
 * Builds the controlled write function used by the write and edit tools. On
 * success it attests the exact hash transition; on refusal it throws and emits
 * nothing. Full-access writes outside the active project are written but not
 * attested (a project-relative path cannot truthfully represent them).
 */
export function createSecureWriteFile(deps: SecureWriteDeps): (filePath: string, content: string, operation: 'write' | 'edit') => Promise<void> {
  const { policy, access, canonicalCwd } = deps;
  const attestations = deps.attestations;
  const maxPreHashBytes = deps.maxPreHashBytes ?? MAX_PRE_HASH_BYTES;

  // Emits an attestation only for project-confined paths. Full-access writes
  // outside the active project are skipped: a project-relative path cannot
  // truthfully represent them.
  const attest = (operation: 'write' | 'edit', target: string, content: string, preHash: string | null, preState: 'missing' | 'hashed' | 'oversize'): void => {
    if (!attestations) return;
    const context: AttestationContext | null = attestations.resolveContext();
    if (!context) return;
    const input: AttestationRecordInput = {
      operation,
      projectRoot: canonicalCwd,
      targetPath: target,
      content,
      preHash,
      preState,
      actor: context.actor,
      sessionId: context.sessionId,
      permissionLevel: context.permissionLevel,
    };
    attestations.record(input);
  };

  // For full-access writes, follow symlinks and require the REAL path inside the
  // project. A symlink that lives inside the project but escapes it must not be
  // attested, because its project-relative path would be untruthful.
  const resolveProjectTarget = async (target: string): Promise<string | null> => {
    try {
      const real = path.normalize(await fs.realpath(target));
      return isContained(canonicalCwd, real) ? real : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // New target: the nearest existing ancestor must resolve inside the project.
    let ancestor = path.dirname(target);
    while (true) {
      try {
        const realAncestor = path.normalize(await fs.realpath(ancestor));
        if (!isContained(canonicalCwd, realAncestor)) return null;
        const resolved = path.normalize(path.resolve(realAncestor, path.relative(ancestor, target)));
        return isContained(canonicalCwd, resolved) ? resolved : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
      }
    }
  };

  // Original controlled write with no attestation: O_WRONLY, no prior-state read.
  // Preserved exactly so write-only project files do not regress when no sink is wired.
  const writeWithoutAttestation = async (target: string, content: string): Promise<void> => {
    let create = false;
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      create = true;
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const flags = constants.O_WRONLY | noFollow | (create ? constants.O_CREAT | constants.O_EXCL : 0);
    const handle = await fs.open(target, flags, 0o600);
    try {
      const [stat, verifiedTarget] = await Promise.all([handle.stat(), policy.existing(target)]);
      if (!stat.isFile() || stat.nlink > 1 || path.relative(target, verifiedTarget) !== '') {
        throw new PiDesktopError({
          code: 'INVALID_PROJECT',
          message: 'Pi refused to write a linked or concurrently replaced project file.',
          retryable: true,
        });
      }
      await handle.truncate(0);
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  };

  // Attested controlled write. O_RDWR lets the same handle that truncates also
  // hash the prior state, eliminating the window between hashing and truncating.
  // After the write, the path is re-stated and compared by dev/ino: if the inode
  // was replaced, the attestation is skipped so no false row is recorded.
  //
  // When the attested write cannot proceed safely, it falls back to the original
  // write without emitting an attestation: a write-only file that rejects O_RDWR
  // (EACCES/EPERM), or — in full-access mode only — a linked/replaced in-project
  // file the old flow wrote plainly. Project-confined mode keeps refusing those.
  const writeWithAttestation = async (args: {
    target: string;
    content: string;
    operation: 'write' | 'edit';
    attestTarget: string;
    enforceContainment: boolean;
    /** Original (non-attesting) write used when the attested write cannot proceed safely. */
    fallback: () => Promise<void>;
  }): Promise<void> => {
    const { target, content, operation, attestTarget, enforceContainment, fallback } = args;
    let create = false;
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      create = true;
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const flags = constants.O_RDWR | noFollow | (create ? constants.O_CREAT | constants.O_EXCL : 0);
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(target, flags, 0o600);
    } catch (error) {
      // A write-only file cannot be opened read-write. If the original write can
      // still succeed, preserve that behavior without emitting an attestation.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        await fallback();
        return;
      }
      throw error;
    }
    let fallbackInstead = false;
    try {
      const [stat, verifiedTarget] = await Promise.all([
        handle.stat(),
        enforceContainment ? policy.existing(target) : Promise.resolve(target),
      ]);
      if (!stat.isFile() || stat.nlink > 1 || (enforceContainment && path.relative(target, verifiedTarget) !== '')) {
        if (enforceContainment) {
          throw new PiDesktopError({
            code: 'INVALID_PROJECT',
            message: 'Pi refused to write a linked or concurrently replaced project file.',
            retryable: true,
          });
        }
        // Full-access: the original flow wrote linked/replaced in-project files
        // plainly. Defer to the plain write (after this handle closes) and emit
        // no attestation, preserving the previously allowed operation.
        fallbackInstead = true;
      }
      if (!fallbackInstead) {
        let preHash: string | null = null;
        let preState: 'missing' | 'hashed' | 'oversize' = 'missing';
        if (!create) {
          if (stat.size > maxPreHashBytes) {
            preState = 'oversize';
          } else {
            preHash = createHash('sha256').update(await handle.readFile()).digest('hex');
            preState = 'hashed';
          }
        }
        await handle.truncate(0);
        // Seek-safe positioned write loop: do not assume one handle.write writes
        // all bytes, and do not depend on the cursor advanced by readFile.
        await writeAllPositioned(handle, Buffer.from(content, 'utf8'));
        // Confirm the path still resolves to the inode we wrote; otherwise skip the row.
        const afterStat = await fs.stat(target).catch(() => null);
        if (afterStat && afterStat.dev === stat.dev && afterStat.ino === stat.ino) {
          attest(operation, attestTarget, content, preHash, preState);
        }
      }
    } finally {
      await handle.close();
    }
    if (fallbackInstead) await fallback();
  };

  return async (filePath: string, content: string, operation: 'write' | 'edit'): Promise<void> => {
    const target = await policy.writable(filePath);
    if (access.fullAccess) {
      // No sink, or a target whose real path is outside the project: plain write, no attestation.
      if (!attestations) {
        await fs.writeFile(target, content);
        return;
      }
      const projectTarget = await resolveProjectTarget(target);
      if (!projectTarget) {
        await fs.writeFile(target, content);
        return;
      }
      // Same-handle attested write against the resolved inside-project path.
      await writeWithAttestation({ target: projectTarget, content, operation, attestTarget: projectTarget, enforceContainment: false, fallback: () => fs.writeFile(projectTarget, content) });
      return;
    }
    if (!attestations) {
      await writeWithoutAttestation(target, content);
      return;
    }
    await writeWithAttestation({ target, content, operation, attestTarget: target, enforceContainment: true, fallback: () => writeWithoutAttestation(target, content) });
  };
}

export interface ProjectConfinedToolsOptions {
  searchTools?: boolean;
  getImageGenerationSettings?: ImageGenerationSettingsResolver;
  /** When provided, successful controlled write/edit operations are attested. */
  attestations?: AttestationSink;
  /** Maximum prior-state bytes hashed in memory before recording oversize. */
  maxPreHashBytes?: number;
}

export async function createProjectConfinedTools(
  cwd: string,
  access: ProjectToolAccess = { fullAccess: false },
  readableRoots: ReadableRoots = [],
  options: ProjectConfinedToolsOptions = {},
) {
  const canonicalCwd = path.normalize(await fs.realpath(cwd));
  const { attestations, maxPreHashBytes = MAX_PRE_HASH_BYTES } = options;
  const policy = await ProjectPathPolicy.create(canonicalCwd, access, readableRoots);
  const withReadable = async (filePath: string, read: boolean, maxBytes?: number): Promise<Buffer | undefined> => {
    const target = await policy.readable(filePath);
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PI_READ_BYTES) {
        throw new PiDesktopError({
          code: 'INVALID_PROJECT',
          message: `Pi reads are limited to regular project files smaller than ${MAX_PI_READ_BYTES / 1024 / 1024} MiB.`,
          retryable: false,
        });
      }
      const verifiedTarget = await policy.readable(target);
      if (path.relative(target, verifiedTarget) !== '') throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'Pi refused a concurrently replaced project or skill file.', retryable: true });
      if (!read) return undefined;
      if (maxBytes === undefined) return handle.readFile();
      const sample = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      return sample.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  const readOperations = {
    readFile: async (filePath: string) => (await withReadable(filePath, true))!,
    access: async (filePath: string) => { await withReadable(filePath, false); },
    detectImageMimeType: async (filePath: string) => rasterImageMimeType((await withReadable(filePath, true, 4_100))!),
  };
  const secureWriteFile = createSecureWriteFile({
    policy,
    access,
    canonicalCwd,
    ...(attestations ? { attestations } : {}),
    maxPreHashBytes,
  });
  const writeOperations = {
    mkdir: async (directoryPath: string) => { await fs.mkdir(await policy.writable(directoryPath), { recursive: true }); },
    writeFile: (filePath: string, content: string) => secureWriteFile(filePath, content, 'write'),
  };
  const searchTools = options.searchTools ? [
    createGrepToolDefinition(canonicalCwd, {
      operations: {
        isDirectory: async (target) => (await fs.stat(await policy.readable(target))).isDirectory(),
        readFile: async (target) => (await withReadable(target, true))!.toString('utf8'),
      },
    }),
    createFindToolDefinition(canonicalCwd, {
      operations: {
        exists: async (target) => {
          try { await policy.readable(target); return true; } catch { return false; }
        },
        glob: async (pattern, directory, globOptions) => {
          if (path.isAbsolute(pattern) || pattern.includes('..')) {
            throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'Pi find patterns must stay inside the approved search directory.', retryable: false });
          }
          const canonicalDirectory = await policy.readable(directory);
          const results: string[] = [];
          for await (const match of fs.glob(pattern, { cwd: canonicalDirectory, exclude: globOptions.ignore })) {
            const candidate = path.resolve(canonicalDirectory, String(match));
            try {
              await policy.readable(candidate);
              results.push(String(match));
            } catch {
              // A glob that escapes the approved roots is omitted.
            }
            if (results.length >= globOptions.limit) break;
          }
          return results;
        },
      },
    }),
    createLsToolDefinition(canonicalCwd, {
      operations: {
        exists: async (target) => {
          try { await policy.readable(target); return true; } catch { return false; }
        },
        stat: async (target) => fs.stat(await policy.readable(target)),
        readdir: async (target) => fs.readdir(await policy.readable(target)),
      },
    }),
  ] : [];
  return [
    createBashToolDefinition(canonicalCwd),
    createReadToolDefinition(canonicalCwd, { operations: readOperations }),
    createWriteToolDefinition(canonicalCwd, { operations: writeOperations }),
    createEditToolDefinition(canonicalCwd, { operations: { ...readOperations, writeFile: (filePath: string, content: string) => secureWriteFile(filePath, content, 'edit') } }),
    createGenerateImageTool(createConfiguredImageGenerator(options.getImageGenerationSettings)),
    ...searchTools,
  ];
}
