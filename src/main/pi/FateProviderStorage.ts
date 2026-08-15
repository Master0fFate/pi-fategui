import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const MAX_LEGACY_FILE_BYTES = 4 * 1024 * 1024;
const providerFiles = ['auth.json', 'models.json'] as const;

export interface FateProviderStoragePaths {
  dataRoot: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
}

export interface FateProviderStorageMigration {
  paths: FateProviderStoragePaths;
  firstRun: boolean;
  imported: readonly (typeof providerFiles)[number][];
}

export interface PrepareFateProviderStorageOptions {
  dataRoot?: string;
  piAgentDir?: string;
}

export function fateDataRoot(): string {
  const configured = process.env.FATE_GUI_DATA_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.pi', 'fateGUI');
}

export function fateProviderStoragePaths(dataRoot = fateDataRoot()): FateProviderStoragePaths {
  const root = path.resolve(dataRoot);
  return {
    dataRoot: root,
    authPath: path.join(root, 'auth.json'),
    modelsPath: path.join(root, 'models.json'),
    // ModelRuntime uses this local catalog cache beside models.json. It is
    // Fate-owned too; Pi's shared agent directory remains untouched.
    modelsStorePath: path.join(root, 'models-store.json'),
  };
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.lstat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function requirePrivateRegularFile(filePath: string): Promise<void> {
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Fate UI provider storage must use a regular file: ${filePath}`);
    }
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function importLegacyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    const metadata = await fs.lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_LEGACY_FILE_BYTES) return false;
    const content = await fs.readFile(sourcePath);
    await fs.writeFile(destinationPath, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    // A concurrent first launch can create the destination first. Keep the
    // existing Fate-owned file rather than overwriting it with Pi state.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // Missing, unreadable, malformed, or too-large legacy files must not stop
    // the clean SDK login path. ModelRuntime validates any imported JSON later.
    return false;
  }
}

/**
 * Initialize Fate-owned provider files exactly once.
 *
 * Sessions, settings, skills, extensions, and MCP configuration continue to
 * use Pi's shared agent directory. Only provider credentials and model config
 * are copied from Pi on a brand-new Fate UI data root.
 */
export async function prepareFateProviderStorage(options: PrepareFateProviderStorageOptions = {}): Promise<FateProviderStorageMigration> {
  const paths = fateProviderStoragePaths(options.dataRoot);
  await fs.mkdir(path.dirname(paths.dataRoot), { recursive: true, mode: 0o700 });

  let firstRun = false;
  try {
    await fs.mkdir(paths.dataRoot, { mode: 0o700 });
    firstRun = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!await isDirectory(paths.dataRoot)) {
      throw new Error(`Fate UI provider storage path is not a directory: ${paths.dataRoot}`);
    }
  }

  if (process.platform !== 'win32') await fs.chmod(paths.dataRoot, 0o700);
  if (!firstRun) {
    await Promise.all(providerFiles.map(async (file) => requirePrivateRegularFile(path.join(paths.dataRoot, file))));
    return { paths, firstRun: false, imported: [] };
  }

  const legacyRoot = path.resolve(options.piAgentDir ?? getAgentDir());
  const imported = (await Promise.all(providerFiles.map(async (file) => (
    await importLegacyFile(path.join(legacyRoot, file), path.join(paths.dataRoot, file)) ? file : null
  )))).filter((file): file is (typeof providerFiles)[number] => file !== null);
  await Promise.all(providerFiles.map(async (file) => requirePrivateRegularFile(path.join(paths.dataRoot, file))));

  return { paths, firstRun: true, imported };
}
