import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openOwnedDurableStorage, type OwnedDurableStorageOptions } from '../../../core/durable/OwnedDurableStorage';
import { failWithNativeCleanup } from './NativeExecutionFence';
import { NativeDurableExecution, type NativeDurableExecutionOptions } from './NativeDurableExecution';

export type NativeSessionSource =
  | { readonly kind: 'new-native'; readonly sessionId: string }
  | { readonly kind: 'resume-native'; readonly sessionId: string };
export type OwnedNativeExecutionOptions = Omit<NativeDurableExecutionOptions, 'storage' | 'assertOwnership'>
  & Pick<OwnedDurableStorageOptions, 'dataRoot' | 'profileOwner'>
  & { readonly source: NativeSessionSource };

/** Production construction: one native Harness, one verified WAL/FULL store, one profile owner. */
export async function openOwnedNativeExecution(options: OwnedNativeExecutionOptions): Promise<NativeDurableExecution> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.source.sessionId)) throw new Error('Native sessions require a host-issued stable identity.');
  const hash = createHash('sha256').update(options.source.sessionId).digest('hex');
  const owned = await openOwnedDurableStorage({ dataRoot: options.dataRoot, profileOwner: options.profileOwner, filename: `execution-${hash}.sqlite` });
  try {
    const exists = (await owned.storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0;
    if (options.source.kind === 'new-native' && exists) throw new Error('A new native session must not reuse an existing session identity.');
    if (options.source.kind === 'resume-native' && !exists) throw new Error('The selected native session does not exist; no replacement session was created.');
    return await NativeDurableExecution.open({ ...options, storage: owned.storage, assertOwnership: owned.assertOwnership });
  } catch (error) {
    return failWithNativeCleanup(error, () => owned.storage.close(BACKGROUND_CONTEXT));
  }
}

export type ComposedExecutionChoice<TLegacy> =
  | { readonly backend: 'legacy-sdk'; readonly open: () => Promise<TLegacy> }
  | { readonly backend: 'native-durable'; readonly options: OwnedNativeExecutionOptions };

/**
 * Explicit composition seam for the host's session-type branch. No dependency-based
 * auto-selection and no catch-and-fallback: a fenced native session stays fenced.
 * JSONL history and SDK sessions retain their actual SDK object and existing path.
 */
export async function openComposedPiExecution<TLegacy>(choice: ComposedExecutionChoice<TLegacy>) {
  if (choice.backend === 'legacy-sdk') return { backend: 'legacy-sdk' as const, runtime: await choice.open() };
  return { backend: 'native-durable' as const, runtime: await openOwnedNativeExecution(choice.options) };
}
