import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FilesystemService } from '../../main/files/FilesystemService';
import {
  fileListInputSchema, fileListSchema, filePathInputSchema, filePreviewSchema,
  fileSearchInputSchema, fileSearchResultSchema, type FileEntry,
} from '../../shared/contracts/ipc';
import { methodCatalog } from '../../shared/protocol/methods';
import { z } from 'zod';
import { assertScopedRead } from './agentHandlers';
import type { AdmissionAuthority } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';

/** Existing desktop DTOs. Never install local shell actions in a network handle. */
export function createFileHandlers(files: FilesystemService) {
  return {
    async list(input: unknown) { return fileListSchema.parse(await files.list(fileListInputSchema.parse(input).path)); },
    async search(input: unknown) {
      const { query, limit } = fileSearchInputSchema.parse(input);
      return fileSearchResultSchema.parse(await files.search(query, limit));
    },
    async read(input: unknown) { return filePreviewSchema.parse(await files.read(filePathInputSchema.parse(input).path)); },
  };
}

const label = z.string().min(1).max(128).regex(/^[^\\/:\u0000-\u001f\u007f]+$/u);
type Resource = { readonly path: string; readonly kind: FileEntry['kind'] };

/** A resource ID belongs to exactly one captured host workspace. Never accept a client path in a resource call. */
export function createScopedFileHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority) {
  const desktop = createFileHandlers(handle.files);
  const resources = new Map<string, Resource>();
  const check = async () => {
    assertScopedRead(handle, authorize);
    if (handle.files.getRoot() !== handle.root) throw new Error('File workspace root changed.');
    await handle.files.assertBoundRootIdentity();
    assertScopedRead(handle, authorize);
  };
  const resolve = (id: string, kind: Resource['kind']): string => {
    const resource = resources.get(id);
    if (!resource || resource.kind !== kind) throw new Error('Unknown workspace file resource. Refresh the file tree.');
    return resource.path;
  };
  const readDesktop = async (input: unknown) => {
    await check();
    const result = await desktop.read(input);
    await check();
    return result;
  };
  return {
    async list(input: unknown) {
      await check();
      const result = await desktop.list(input);
      await check();
      return result;
    },
    async search(input: unknown) {
      await check();
      const result = await desktop.search(input);
      // A search index can outlive a directory swap. Recheck each candidate on
      // the host before presenting its relative name to a remote client.
      const entries: FileEntry[] = [];
      for (const entry of result.entries) {
        await check();
        try {
          const canonical = await handle.files.resolvePath(entry.path);
          const stat = await fs.stat(canonical);
          if ((entry.kind === 'file' && stat.isFile()) || (entry.kind === 'directory' && stat.isDirectory())) entries.push(entry);
        } catch { /* A removed or escaping search hit is invisible. */ }
      }
      await check();
      return fileSearchResultSchema.parse({ entries, truncated: result.truncated || entries.length !== result.entries.length });
    },
    /** Native IPC may preview images; the portable resource API below remains text-only. */
    readDesktop,
    async read(input: unknown) {
      const result = await readDesktop(input);
      if (result.state === 'image') throw new Error('Image previews are not supported for remote project files.');
      return result;
    },
    async listResource(input: unknown) {
      const parsed = methodCatalog['file.list'].inputSchema.parse(input);
      await check();
      const directory = parsed.directoryId === null ? '' : resolve(parsed.directoryId, 'directory');
      const listing = await desktop.list({ path: directory });
      await check();
      const visible = listing.entries.filter((entry) => label.safeParse(entry.name).success);
      const entries = visible.slice(0, parsed.limit).map((entry) => {
        const resourceId = randomUUID();
        resources.set(resourceId, { path: entry.path, kind: entry.kind });
        return { resourceId, name: entry.name, kind: entry.kind };
      });
      // Per-handler IDs are only a short-lived tree view, not persistent paths or bearer grants.
      if (resources.size > 2_000) {
        for (const key of resources.keys()) {
          if (resources.size <= 2_000) break;
          resources.delete(key);
        }
      }
      return methodCatalog['file.list'].domainResultSchema.parse({ directoryId: parsed.directoryId, entries,
        truncated: listing.truncated || visible.length > parsed.limit || visible.length !== listing.entries.length });
    },
    async previewTextResource(input: unknown) {
      const parsed = methodCatalog['file.previewText'].inputSchema.parse(input);
      await check();
      const relativePath = resolve(parsed.fileId, 'file');
      const result = await desktop.read({ path: relativePath });
      await check();
      if (result.state !== 'text' || result.content === undefined) throw new Error('Only bounded text previews are supported.');
      const original = Buffer.from(result.content, 'utf8');
      const truncated = original.length > parsed.maxBytes;
      const prefix = original.subarray(0, parsed.maxBytes);
      // Decode via TextDecoder: a partial UTF-8 code point is replaced, never an invalid JSON byte.
      const content = new TextDecoder('utf-8', { fatal: false }).decode(prefix);
      return methodCatalog['file.previewText'].domainResultSchema.parse({ fileId: parsed.fileId, content, truncated });
    },
  };
}
