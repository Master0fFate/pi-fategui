import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSessionEntries, SessionManager, type AgentSession, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { LEARNING_LIMITS, type LearningBinding, type LearningEvidence, type PreviewEvidenceInput, utf8Bytes } from '../../shared/contracts/learning';
import { FilesystemService } from '../files/FilesystemService';
import { executeGitInWorktree } from '../git/GitService';
import { redactSecretLikeText } from '../pi/BrowserAnnotationContext';
import { learningDigest, learningError, readLearningFile } from './LearningRepository';

export interface LearningOrigin {
  root: string; binding: LearningBinding; session: AgentSession | null; valid: () => boolean;
}
export function visibleLearningText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part: unknown) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n');
}
export function boundedLearningText(text: string, bytes: number): string {
  if (utf8Bytes(text) <= bytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
}
export const redactLearningText = (text: string): string => redactSecretLikeText(text).replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}/giu, '[credential redacted]');
export async function learningCodeState(root: string): Promise<{ commit: string | null; dirty: boolean | null; branch: string | null }> {
  try {
    const results = await Promise.allSettled([
      executeGitInWorktree(root, ['rev-parse', '--verify', 'HEAD'], 4096),
      executeGitInWorktree(root, ['status', '--porcelain', '--untracked-files=normal'], 64 * 1024),
      executeGitInWorktree(root, ['symbolic-ref', '--short', '-q', 'HEAD'], 4096).catch(() => ''),
    ]);
    const [commit, status, branch] = results;
    return { commit: commit.status === 'fulfilled' ? commit.value.toString('utf8').trim() : null, dirty: status.status === 'fulfilled' ? status.value.toString('utf8').trim().length > 0 : null, branch: branch.status === 'fulfilled' ? branch.value.toString().trim() || null : null };
  } catch { return { commit: null, dirty: null, branch: null }; }
}
export async function readLearningProjectFile(root: string, relative: string, signal?: AbortSignal): Promise<Buffer> {
  const files = new FilesystemService();
  await files.setRoot(root);
  const canonical = await files.resolvePath(relative);
  const data = await readLearningFile(canonical, LEARNING_LIMITS.sourceFileBytes, signal);
  if (await files.resolvePath(relative) !== canonical) learningError('Evidence path changed during reading.');
  return data;
}

async function selectedEntries(origin: LearningOrigin, leafId: string, signal: AbortSignal | undefined, cache: { manager?: SessionManager }): Promise<SessionEntry[]> {
  const session = origin.session;
  if (!session) learningError('Exact session evidence is unavailable. Use manual text (user-asserted).');
  if (!session.sessionFile) {
    if (typeof session.sessionManager.getBranch !== 'function') learningError('Durable entry identities are unavailable. Use manual text.');
    const branch = session.sessionManager.getBranch();
    const index = branch.findIndex((entry) => entry.id === leafId);
    if (index < 0) learningError('Selected branch is unavailable.');
    return branch.slice(0, index + 1);
  }
  if (cache.manager) {
    if (!cache.manager.getEntry(leafId)) learningError('Unknown selected branch.');
    return cache.manager.getBranch(leafId);
  }
  const bytes = await readLearningFile(session.sessionFile, LEARNING_LIMITS.sessionBytes, signal);
  if (!origin.valid()) learningError('The originating session changed.');
  const data = parseSessionEntries(bytes.toString('utf8'));
  const header = data[0];
  if (!header || header.type !== 'session' || header.id !== origin.binding.sessionId || path.normalize(header.cwd) !== path.normalize(origin.root)) learningError('Session evidence identity mismatch.');
  const entries = data.filter((entry): entry is SessionEntry => entry.type !== 'session');
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  if (map.size !== entries.length || entries.length > 100_000) learningError('Damaged or unusually large session. Use manual evidence.');
  const checked = new Set<string>();
  for (const candidate of entries) {
    const visiting = new Set<string>();
    let current: SessionEntry | undefined = candidate;
    while (current && !checked.has(current.id)) {
      if (visiting.has(current.id)) learningError('Cyclic session evidence. Use manual evidence.');
      visiting.add(current.id);
      if (current.parentId && !map.has(current.parentId)) learningError('Session evidence has a missing parent.');
      current = current.parentId ? map.get(current.parentId) : undefined;
    }
    for (const item of visiting) checked.add(item);
  }
  if (!map.has(leafId)) learningError('Unknown selected branch.');
  const manager = SessionManager.inMemory(origin.root, undefined, data);
  cache.manager = manager;
  return manager.getBranch(leafId);
}

export async function captureLearningEvidence(origin: LearningOrigin, sources: PreviewEvidenceInput['sources'], signal?: AbortSignal): Promise<LearningEvidence[]> {
  const code = await learningCodeState(origin.root);
  const evidence: LearningEvidence[] = [];
  const sessionCache: { manager?: SessionManager } = {};
  let remaining: number = LEARNING_LIMITS.evidenceBytes;
  for (const source of sources) {
    signal?.throwIfAborted();
    if (!origin.valid()) learningError('Capture cancelled because its originating binding changed.');
    let raw = '';
    let basis: LearningEvidence['basis'] = 'user-asserted';
    let verification: LearningEvidence['verification'] = null;
    const metadata: LearningEvidence['source'] = { kind: source.kind, sessionId: null, entryId: null, leafId: null, path: null, fileDigest: null, toolCallId: null };
    if (source.kind === 'manual') raw = source.text;
    if (source.kind === 'file') {
      if (source.endLine < source.startLine || source.endLine - source.startLine > 1000) learningError('Select at most 1,001 consecutive source lines.');
      const bytes = await readLearningProjectFile(origin.root, source.path, signal);
      const text = bytes.toString('utf8');
      if (text.includes('\0')) learningError('Binary files cannot be evidence.');
      const lines = text.split('\n');
      if (source.startLine > lines.length) learningError('Selected lines no longer exist.');
      raw = lines.slice(source.startLine - 1, source.endLine).join('\n');
      metadata.path = source.path;
      metadata.fileDigest = learningDigest(bytes.toString('utf8'));
      basis = 'runtime-observed';
    }
    if (source.kind === 'entry') {
      const entry = (await selectedEntries(origin, source.leafId, signal, sessionCache)).find((candidate) => candidate.id === source.entryId);
      if (!entry || entry.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(entry.message.role)) learningError('Select an exact visible user, assistant, or tool-result entry.');
      raw = visibleLearningText(entry.message);
      metadata.sessionId = origin.binding.sessionId;
      metadata.entryId = source.entryId;
      metadata.leafId = source.leafId;
      if (entry.message.role === 'toolResult') {
        basis = 'runtime-observed';
        metadata.toolCallId = entry.message.toolCallId;
        // Tool success does not establish a command's exit status or its code state.
        verification = null;
      }
    }
    const redacted = redactLearningText(raw);
    const text = boundedLearningText(redacted, remaining);
    if (!text.trim()) learningError('Evidence is empty or the capture byte budget is exhausted. Remove a source and try again.');
    const data = { id: randomUUID(), projectKey: origin.binding.projectKey, createdAt: Date.now(), schemaVersion: 1 as const, source: metadata, codeState: { commit: code.commit, dirty: code.dirty }, text, omitted: text !== redacted || source.kind === 'file', redacted: redacted !== raw, basis, verification };
    evidence.push({ ...data, digest: learningDigest(data) });
    remaining -= utf8Bytes(text);
  }
  return evidence;
}
