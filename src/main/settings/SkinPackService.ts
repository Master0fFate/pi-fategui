import { nativeImage } from 'electron';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ditherMask } from '../../shared/dither';
import {
  builtInSkins, MAX_SKIN_IMAGE_BYTES, MAX_SKIN_MANIFEST_BYTES, MAX_SKIN_V2_MANIFEST_BYTES, MAX_SKIN_MASK_BYTES, MAX_SKIN_PACKS,
  skinCatalogSchema, skinDefinitionSchema, skinPackFolderIdSchema, skinPackIdSchema, skinPackManifestSchema, skinPackThemeId,
  type SkinCatalog, type SkinDefinition, type SkinPackManifest,
} from '../../shared/skins';
import { MAX_SKIN_FONT_BYTES, packFontId } from '../../shared/skinFonts';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db']);
const allowedFiles = new Set(['skin.json', 'background.png', 'README.md', 'LICENSE']);
interface ReadPack { manifest: SkinPackManifest; files: Map<string, Buffer> }

async function directory(directoryPath: string): Promise<string> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a regular folder, not a symlink or junction.');
  return fs.realpath(directoryPath);
}

async function boundedFile(filePath: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error('Skin files must be regular files, not links.');
  if (before.size > limit) throw new Error(`${path.basename(filePath)} exceeds its ${Math.round(limit / 1024)} KB limit.`);
  const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('A skin file changed while being opened. Try again.');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== before.size) throw new Error('A skin file changed while being read. Try again.');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

function pngDimensions(bytes: Buffer, maximumPixels: number): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('background.png must contain a real PNG image. SVG and other formats are not supported in packs.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > maximumPixels) throw new Error('The pack background exceeds its pixel budget.');
  return { width, height };
}

export function preparePackBackground(bytes: Buffer): Buffer {
  const size = pngDimensions(bytes, 8_000_000);
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) throw new Error('The pack PNG could not be decoded.');
  const scale = Math.min(1, 640 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const bitmap = source.resize({ width, height, quality: 'good' }).toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error('The pack PNG has an unsupported bitmap format.');
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let index = 0; index < bitmap.length; index += 4) {
    rgba[index] = bitmap[index + 2]!;
    rgba[index + 1] = bitmap[index + 1]!;
    rgba[index + 2] = bitmap[index]!;
    rgba[index + 3] = bitmap[index + 3]!;
  }
  const mask = nativeImage.createFromBitmap(Buffer.from(ditherMask(rgba, width, height)), { width, height, scaleFactor: 1 }).toPNG();
  if (mask.length > MAX_SKIN_MASK_BYTES) throw new Error('The processed background is too large. Use a simpler or smaller image.');
  return mask;
}

export function validatePackFont(bytes: Buffer, filename: string): void {
  const woff2 = filename.endsWith('.woff2');
  if (bytes.length < (woff2 ? 48 : 44) || bytes.length > MAX_SKIN_FONT_BYTES || bytes.toString('ascii', 0, 4) !== (woff2 ? 'wOF2' : 'wOFF')) throw new Error('Skin fonts must be WOFF or WOFF2 files up to 256 KB.');
  if (bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt16BE(14) !== 0 || bytes.readUInt16BE(12) < 1 || bytes.readUInt16BE(12) > 128 || bytes.readUInt32BE(16) > 8 * 1024 * 1024) throw new Error('The font header is invalid or exceeds its expanded-size budget.');
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(bytes.readUInt32BE(4))) throw new Error('Use a single TrueType/OpenType WOFF font, not a font collection.');
}

export class SkinPackService {
  readonly storagePath: string;
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<string, { fingerprint: string; definition: SkinDefinition }>();

  constructor(dataRoot: string, private readonly prepareImage: (source: Buffer) => Buffer = preparePackBackground) {
    this.storagePath = path.resolve(dataRoot, 'skins');
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async root(): Promise<string> {
    await fs.mkdir(this.storagePath, { recursive: true });
    return directory(this.storagePath);
  }

  private async readPack(folder: string, managed = false): Promise<ReadPack> {
    const root = await directory(folder);
    const files = new Map<string, Buffer>();
    const json = await boundedFile(path.join(root, 'skin.json'), managed ? MAX_SKIN_MANIFEST_BYTES : MAX_SKIN_V2_MANIFEST_BYTES).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('This folder does not contain skin.json.');
      throw error;
    });
    let manifest: SkinPackManifest;
    try {
      const raw = JSON.parse(json.toString('utf8'));
      if (raw.schemaVersion !== 2 && json.length > MAX_SKIN_MANIFEST_BYTES) throw new Error('Version 1 manifest exceeds its size limit.');
      manifest = skinPackManifestSchema.parse(raw);
    } catch { throw new Error('Invalid skin.json or size limit exceeded. Use schemaVersion 1 or 2 and only documented properties.'); }
    const declaredFonts = new Map((manifest.fonts ?? []).map((font) => [font.file, font]));
    files.set('skin.json', json);
    const entries = await fs.opendir(root);
    let count = 0;
    for await (const entry of entries) {
      if (++count > 8) throw new Error('A skin folder contains too many files.');
      if (ignoredFiles.has(entry.name) || entry.name === 'skin.json') continue;
      if (!allowedFiles.has(entry.name) && !declaredFonts.has(entry.name)) throw new Error(`Unsupported skin file: ${entry.name.slice(0, 80)}. Packs cannot contain scripts, stylesheets, or subfolders.`);
      const limit = declaredFonts.has(entry.name) ? MAX_SKIN_FONT_BYTES : entry.name === 'background.png' ? managed ? MAX_SKIN_MASK_BYTES : MAX_SKIN_IMAGE_BYTES : MAX_SKIN_MANIFEST_BYTES;
      const content = await boundedFile(path.join(root, entry.name), limit);
      if (declaredFonts.has(entry.name)) validatePackFont(content, entry.name);
      files.set(entry.name, content);
    }
    for (const filename of declaredFonts.keys()) { if (!files.has(filename)) throw new Error(`Missing declared font: ${filename}`); }
    if (manifest.background && 'data' in manifest.background) {
      if (files.has('background.png')) throw new Error('Use either an embedded image or background.png, not both.');
      const image = Buffer.from(manifest.background.data, 'base64');
      if (image.length > MAX_SKIN_IMAGE_BYTES || image.toString('base64') !== manifest.background.data) throw new Error('The embedded image is invalid or too large.');
      files.set('background.png', image);
      manifest = { ...manifest, background: { file: 'background.png', opacity: manifest.background.opacity } };
    }
    if (Boolean(manifest.background) !== files.has('background.png')) throw new Error('Declare background.png in the manifest, or remove the unused image.');
    const image = files.get('background.png');
    if (image) pngDimensions(image, managed ? 640 * 640 : 8_000_000);
    return { manifest, files };
  }

  private definition(pack: ReadPack): SkinDefinition {
    const manifest = pack.manifest;
    const id = `pack:${manifest.id}`;
    const digest = createHash('sha256').update(JSON.stringify(manifest));
    const image = pack.files.get('background.png');
    if (image) digest.update(image);
    for (const font of manifest.fonts ?? []) digest.update(pack.files.get(font.file)!);
    const fingerprint = digest.digest('hex');
    const cached = this.cache.get(id);
    if (cached?.fingerprint === fingerprint) return cached.definition;
    const definition = skinDefinitionSchema.parse({
      id, base: manifest.base, origin: 'pack', name: manifest.name, description: manifest.description, version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.layout ? { layout: manifest.layout } : {}),
      ...(manifest.styles ? { styles: manifest.styles } : {}),
      ...(manifest.fonts ? { fonts: manifest.fonts.map((font) => ({ id: packFontId(manifest.id, font.id), name: font.name, monospace: font.monospace, format: font.file.endsWith('.woff2') ? 'woff2' : 'woff', data: pack.files.get(font.file)!.toString('base64') })) } : {}),
      ...(manifest.appearance ? { appearance: {
        ...manifest.appearance,
        ...(manifest.appearance.interfaceFont ? { interfaceFont: manifest.appearance.interfaceFont.startsWith('local:') ? packFontId(manifest.id, manifest.appearance.interfaceFont.slice(6)) : manifest.appearance.interfaceFont } : {}),
        ...(manifest.appearance.codeFont ? { codeFont: manifest.appearance.codeFont.startsWith('local:') ? packFontId(manifest.id, manifest.appearance.codeFont.slice(6)) : manifest.appearance.codeFont } : {}),
      } } : {}),
      ...(manifest.palette ? { palette: { id: skinPackThemeId(id), name: manifest.name, ...manifest.palette } } : {}),
      ...(manifest.background && image ? { background: { data: image.toString('base64'), opacity: manifest.background.opacity } } : {}),
    });
    if (this.cache.size >= MAX_SKIN_PACKS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { fingerprint, definition });
    return definition;
  }

  private async catalog(): Promise<SkinCatalog> {
    const root = await this.root();
    const skins = [...builtInSkins];
    const diagnostics: string[] = [];
    let count = 0;
    const entries = await fs.opendir(root);
    for await (const entry of entries) {
      if (!skinPackFolderIdSchema.safeParse(entry.name).success) continue;
      if (++count > MAX_SKIN_PACKS) { diagnostics.push(`Only the first ${MAX_SKIN_PACKS} pack folders are loaded. Remove unused folders to load others.`); break; }
      try {
        const pack = await this.readPack(path.join(root, entry.name), true);
        if (pack.manifest.id !== entry.name) throw new Error('The folder name must match the manifest ID. Reimport this pack.');
        skins.push(this.definition(pack));
      } catch (error) {
        diagnostics.push(`${entry.name}: ${error instanceof Error ? error.message : 'This pack could not load.'}`.slice(0, 500));
      }
    }
    return skinCatalogSchema.parse({ skins: [...skins.slice(0, 2), ...skins.slice(2).sort((a, b) => a.name.localeCompare(b.name))], diagnostics, storagePath: this.storagePath });
  }

  list(): Promise<SkinCatalog> { return this.run(() => this.catalog()); }

  private async writePack(parent: string, pack: ReadPack): Promise<string> {
    const target = path.join(await directory(parent), pack.manifest.id);
    try { await fs.mkdir(target, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A folder with this skin ID already exists. Remove the old pack or choose a different ID.');
      throw error;
    }
    try {
      for (const [name, content] of pack.files) {
        if (name !== 'skin.json') await fs.writeFile(path.join(target, name), content, { flag: 'wx', mode: 0o600 });
      }
      // Publishing the manifest last keeps partially copied folders unselectable.
      await fs.writeFile(path.join(target, 'skin.json'), `${JSON.stringify(pack.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return target;
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  importFolder(source: string): Promise<{ catalog: SkinCatalog; importedId: string }> {
    return this.run(async () => {
      const current = await this.catalog();
      if (current.skins.length - 2 + current.diagnostics.length >= MAX_SKIN_PACKS) throw new Error(`At most ${MAX_SKIN_PACKS} skin packs can be installed.`);
      const pack = await this.readPack(source);
      const image = pack.files.get('background.png');
      if (image) pack.files.set('background.png', this.prepareImage(image));
      this.definition(pack);
      await this.writePack(await this.root(), pack);
      return { catalog: await this.catalog(), importedId: `pack:${pack.manifest.id}` };
    });
  }

  remove(id: string): Promise<SkinCatalog> {
    return this.run(async () => {
      const folderId = skinPackIdSchema.parse(id).slice(5);
      const root = await this.root();
      const target = path.join(root, folderId);
      const pack = await this.readPack(target, true);
      if (pack.manifest.id !== folderId) throw new Error('This folder is not the requested skin pack.');
      const tombstone = path.join(root, `.removed-${randomUUID()}`);
      await fs.rename(target, tombstone);
      await fs.rm(tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.cache.delete(id);
      return this.catalog();
    });
  }

  exportFolder(id: string, destination: string): Promise<string> {
    return this.run(async () => {
      const folderId = skinPackIdSchema.parse(id).slice(5);
      const pack = await this.readPack(path.join(await this.root(), folderId), true);
      if (pack.manifest.id !== folderId) throw new Error('This folder is not the requested skin pack.');
      return this.writePack(destination, pack);
    });
  }
}
