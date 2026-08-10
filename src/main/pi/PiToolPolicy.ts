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
import { PiDesktopError } from './errors';
import { createConfiguredImageGenerator, createGenerateImageTool, type ImageGenerationSettingsResolver } from './PiImageTool';

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

export async function createProjectConfinedTools(
  cwd: string,
  access: ProjectToolAccess = { fullAccess: false },
  readableRoots: ReadableRoots = [],
  options: { searchTools?: boolean; getImageGenerationSettings?: ImageGenerationSettingsResolver } = {},
) {
  const canonicalCwd = path.normalize(await fs.realpath(cwd));
  const policy = await ProjectPathPolicy.create(canonicalCwd, access, readableRoots);
  const withReadable = async (filePath: string, read: boolean): Promise<Buffer | undefined> => {
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
      return read ? await handle.readFile() : undefined;
    } finally {
      await handle.close();
    }
  };
  const readOperations = {
    readFile: async (filePath: string) => (await withReadable(filePath, true))!,
    access: async (filePath: string) => { await withReadable(filePath, false); },
  };
  const secureWriteFile = async (filePath: string, content: string) => {
    const target = await policy.writable(filePath);
    if (access.fullAccess) {
      await fs.writeFile(target, content);
      return;
    }

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
  const writeOperations = {
    mkdir: async (directoryPath: string) => { await fs.mkdir(await policy.writable(directoryPath), { recursive: true }); },
    writeFile: secureWriteFile,
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
    createEditToolDefinition(canonicalCwd, { operations: { ...readOperations, writeFile: writeOperations.writeFile } }),
    createGenerateImageTool(createConfiguredImageGenerator(options.getImageGenerationSettings)),
    ...searchTools,
  ];
}
