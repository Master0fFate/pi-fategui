import { randomUUID } from 'node:crypto';
import {
  LEARNING_LIMITS, captureSchema, lessonContentSchema, type GenerateDraftInput, type LearningBinding, type LearningCapture, type LearningManifest,
  type LearningMutation, type LearningRecoveryInput, type LearningSnapshot, type LearningState, type LearningTurn,
  type MemoryLearningSettings, type PreviewEvidenceInput, type PreviewSelectionInput, type ReviewCaptureInput,
} from '../../shared/contracts/learning';
import { boundedLearningText, captureLearningEvidence, learningCodeState, redactLearningText, visibleLearningText, type LearningOrigin } from './LearningEvidence';
import { generateLearningDraft, type LearningProvider, type LearningUsage } from './LearningGenerator';
import { emptyLearningSnapshot, learningDigest, learningError, learningIdentity, LearningRepository } from './LearningRepository';
import { selectLearning } from './LearningSelection';
import { isCoreMemory, memoryScopeError, mergeProfileAdditions } from '../../shared/learningMemory';

interface CaptureOwner { origin: LearningOrigin; capture: LearningCapture }
export class LearningService {
  private readonly captures = new Map<string, CaptureOwner>();
  private readonly requests = new Map<string, { controller: AbortController; binding: LearningBinding }>();
  private readonly listeners = new Set<(event: { projectKey: string; scope: LearningBinding['scope']; revision: number }) => void>();
  constructor(readonly repository: LearningRepository, private readonly settings: () => MemoryLearningSettings) {}
  onChanged(listener: (event: { projectKey: string; scope: LearningBinding['scope']; revision: number }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(snapshot: LearningSnapshot): void { for (const listener of this.listeners) listener({ projectKey: snapshot.projectKey, scope: snapshot.scope, revision: snapshot.revision }); }
  layers(): { global: boolean; project: boolean } {
    const settings = this.settings();
    return { global: settings.enabled && settings.global, project: settings.enabled && settings.project };
  }
  enabled(origin: LearningOrigin): boolean { return this.layers()[origin.binding.scope] && origin.valid(); }
  active(origin: LearningOrigin): boolean { return this.settings().enabled && origin.valid(); }
  assertBinding(origin: LearningOrigin, binding: LearningBinding, acrossScopes = false): void {
    if (!origin.valid() || binding.projectKey !== origin.binding.projectKey || binding.sessionId !== origin.binding.sessionId || binding.runtimeGeneration !== origin.binding.runtimeGeneration || (!acrossScopes && binding.scope !== origin.binding.scope)) learningError('Project, session, or scope changed. Refresh this view.');
  }
  private async requireCaptureEnabled(origin: LearningOrigin): Promise<LearningSnapshot> {
    if (!this.enabled(origin)) learningError('Learning is off, the project is untrusted, or the originating session changed.');
    const state = await this.repository.read(learningIdentity(origin.root, origin.binding.scope));
    if (state.mode === 'off' || !this.enabled(origin)) learningError('Learning is off for this scope.');
    return state;
  }
  async state(origin: LearningOrigin, provider: LearningProvider | null): Promise<LearningState> {
    const identity = learningIdentity(origin.root, origin.binding.scope);
    let snapshot: LearningSnapshot | null = null;
    let diagnostic: string | null = null;
    let recoveryDigest: string | null = null;
    try { snapshot = await this.repository.read(identity); }
    catch { diagnostic = 'Store unavailable: corrupt, unsafe, oversized, or unsupported version. Original bytes are preserved. Reset only after reviewing the data-loss warning.'; recoveryDigest = await this.repository.recoveryDigest(identity); }
    const lockDigest = await this.repository.lockDigest(identity);
    if (lockDigest) { diagnostic = 'Store locked. Retry after the writer finishes, or recover only when its process has stopped.'; recoveryDigest = lockDigest; }
    const otherScope = origin.binding.scope === 'global' ? 'project' : 'global';
    const other = await this.repository.read(learningIdentity(origin.root, otherScope)).catch(() => null);
    const snapshots = [snapshot, other].filter((item): item is LearningSnapshot => item !== null);
    const contextModes = { global: snapshots.find((item) => item.scope === 'global')?.mode ?? null, project: snapshots.find((item) => item.scope === 'project')?.mode ?? null };
    const recentUse = snapshots.flatMap((item) => item.manifests).filter((item) => item.projectKey === origin.binding.projectKey).sort((a, b) => a.createdAt - b.createdAt).slice(-LEARNING_LIMITS.manifests);
    const branch = origin.session?.sessionManager.getBranch?.() ?? [];
    const leafId = origin.session?.sessionManager.getLeafId?.();
    const sources: LearningState['sources'] = leafId ? branch.slice(-200).flatMap((entry) => entry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(entry.message.role)
      ? [{ entryId: entry.id, leafId, role: entry.message.role as 'user' | 'assistant' | 'toolResult', preview: boundedLearningText(redactLearningText(visibleLearningText(entry.message)), 300) }] : []).slice(-100) : [];
    return { binding: origin.binding, projectName: origin.root.split(/[\\/]/u).at(-1) || origin.root, enabled: this.enabled(origin), snapshot, recentUse, contextModes, diagnostic, recoveryDigest, provider: provider ? { provider: provider.model.provider, model: provider.model.id } : null, sources };
  }
  async previewEvidence(origin: LearningOrigin, input: PreviewEvidenceInput): Promise<LearningCapture> {
    this.assertBinding(origin, input.binding);
    await this.requireCaptureEnabled(origin);
    for (const [id, owner] of this.captures) if (owner.capture.createdAt < Date.now() - 30 * 60_000 || !owner.origin.valid()) this.captures.delete(id);
    if (this.captures.size >= 16) learningError('Too many open captures. Cancel one before creating another.');
    const id = input.requestId ?? randomUUID();
    if (this.requests.size >= 4 || this.requests.has(id)) learningError('Another capture or generation is already active.');
    const controller = new AbortController();
    this.requests.set(id, { controller, binding: origin.binding });
    const timeout = setTimeout(() => controller.abort(), LEARNING_LIMITS.sourceTimeoutMs);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Evidence capture cancelled or exceeded its five-second deadline. Use manual text.')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    try {
      const evidence = await Promise.race([captureLearningEvidence(origin, input.sources, controller.signal), cancelled]);
      await this.requireCaptureEnabled(origin);
      controller.signal.throwIfAborted();
      const capture = captureSchema.parse({ id: randomUUID(), evidence, digest: learningDigest(evidence), createdAt: Date.now() });
      this.captures.set(capture.id, { origin, capture });
      return structuredClone(capture);
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); this.requests.delete(id); }
  }
  private capture(origin: LearningOrigin, id: string): LearningCapture {
    const owner = this.captures.get(id);
    if (!owner || owner.capture.createdAt < Date.now() - 30 * 60_000) learningError('Capture expired or was deleted. Preview the source again.');
    this.assertBinding(origin, owner.origin.binding);
    return owner.capture;
  }
  async reviewCapture(origin: LearningOrigin, input: ReviewCaptureInput): Promise<LearningCapture> {
    this.assertBinding(origin, input.binding);
    await this.requireCaptureEnabled(origin);
    const current = this.capture(origin, input.captureId);
    if (new Set(input.excerpts.map((item) => item.id)).size !== input.excerpts.length) learningError('Duplicate evidence IDs.');
    const evidence = input.excerpts.map((excerpt) => {
      const previous = current.evidence.find((item) => item.id === excerpt.id);
      if (!previous) learningError('Unknown evidence identity.');
      const text = redactLearningText(excerpt.text);
      const { digest: _oldDigest, ...data } = previous;
      const updated = { ...data, text, redacted: data.redacted || data.text !== text, basis: data.text !== text ? 'user-asserted' as const : data.basis, verification: data.text !== text ? null : data.verification };
      return { ...updated, digest: learningDigest(updated) };
    });
    if (evidence.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0) > LEARNING_LIMITS.evidenceBytes) learningError('Evidence preview exceeds 16 KiB.');
    const capture = { ...current, evidence, digest: learningDigest(evidence) };
    this.captures.set(capture.id, { origin, capture });
    return structuredClone(capture);
  }
  cancel(origin: LearningOrigin, id: string): void {
    const request = this.requests.get(id);
    if (request) { this.assertBinding(origin, request.binding); request.controller.abort(); }
    const capture = this.captures.get(id);
    if (capture) { this.assertBinding(origin, capture.origin.binding); this.captures.delete(id); }
  }
  settingsChanged(): void {
    for (const request of this.requests.values()) request.controller.abort();
    this.captures.clear();
    for (const listener of this.listeners) listener({ projectKey: 'settings', scope: 'project', revision: 0 });
  }
  invalidate(origin: LearningOrigin): void {
    for (const [id, capture] of this.captures) if (capture.origin.binding.projectKey === origin.binding.projectKey && capture.origin.binding.sessionId === origin.binding.sessionId) this.captures.delete(id);
    for (const request of this.requests.values()) if (request.binding.projectKey === origin.binding.projectKey && request.binding.sessionId === origin.binding.sessionId) request.controller.abort();
  }
  dispose(): void { for (const request of this.requests.values()) request.controller.abort(); this.requests.clear(); this.captures.clear(); this.listeners.clear(); }

  async mutate(origin: LearningOrigin, input: LearningMutation): Promise<void> {
    this.assertBinding(origin, input.binding);
    const capture = input.action === 'save-draft' && input.captureId ? this.capture(origin, input.captureId) : null;
    if (input.action === 'save-draft') await this.requireCaptureEnabled(origin);
    const snapshot = await this.repository.mutate(learningIdentity(origin.root, origin.binding.scope), { epoch: input.epoch, revision: input.expectedRevision }, (state) => {
      this.assertBinding(origin, input.binding);
      const draft = 'id' in input ? state.drafts.find((item) => item.id === input.id) : undefined;
      const lesson = 'id' in input ? state.lessons.find((item) => item.id === input.id) : undefined;
      if (input.action === 'save-draft') {
        if (!this.enabled(origin) || state.mode === 'off') learningError('Learning was disabled.');
        const scopeError = memoryScopeError(input.content, state.scope);
        if (scopeError) learningError(scopeError);
        if (input.id && (!draft || draft.state !== 'pending')) learningError('That pending draft no longer exists.');
        if (input.lessonId && !state.lessons.some((item) => item.id === input.lessonId)) learningError('Lesson no longer exists in this scope.');
        if (capture) for (const item of capture.evidence) if (!state.evidence.some((stored) => stored.id === item.id)) state.evidence.push(item);
        const evidenceIds = capture ? capture.evidence.map((item) => item.id) : input.evidenceIds;
        if (evidenceIds.some((id) => !state.evidence.some((item) => item.id === id))) learningError('Selected evidence no longer exists.');
        const replacement = { id: draft?.id ?? randomUUID(), lessonId: draft?.lessonId ?? input.lessonId ?? null, version: (draft?.version ?? 0) + 1, state: 'pending' as const, content: input.content, evidenceIds, digest: learningDigest({ content: input.content, evidenceIds }), createdAt: draft?.createdAt ?? Date.now(), uncertainty: draft?.uncertainty ?? [] };
        if (draft) Object.assign(draft, replacement); else state.drafts.push(replacement);
      } else if (input.action === 'approve') {
        if (!draft || draft.state !== 'pending' || draft.digest !== input.digest) learningError('Approval is stale. Review the exact current draft and evidence.');
        const scopeError = memoryScopeError(draft.content, state.scope);
        if (scopeError) learningError(scopeError);
        if (draft.evidenceIds.some((id) => !state.evidence.some((item) => item.id === id))) learningError('Evidence was removed. Update this draft before approval.');
        const now = Date.now();
        const existing = state.lessons.find((item) => item.id === draft.lessonId);
        if (draft.lessonId && !existing) learningError('Lesson was deleted.');
        if (isCoreMemory(draft.content) && state.lessons.some((item) => item.id !== existing?.id && state.revisions.some((revision) => revision.id === item.activeRevisionId && revision.content.kind === draft.content.kind))) learningError('This scope already has a core memory. Edit its existing profile or briefing instead of creating competing copies.');
        const lessonId = existing?.id ?? randomUUID();
        const revisionNumber = state.revisions.filter((item) => item.lessonId === lessonId).length + 1;
        if (revisionNumber > LEARNING_LIMITS.revisions) learningError('Revision limit reached. Delete or export/review this lesson before creating another revision.');
        const revision = { id: randomUUID(), lessonId, revisionNumber, content: draft.content, evidenceIds: draft.evidenceIds, contentDigest: draft.digest, approvedAt: now, approvalSource: 'local-user' as const, createdFromDraftId: draft.id, supersedesRevisionId: existing?.activeRevisionId ?? null };
        state.revisions.push(revision);
        if (existing) { existing.activeRevisionId = revision.id; existing.freshness = 'current'; existing.updatedAt = now; }
        else state.lessons.push({ id: lessonId, activeRevisionId: revision.id, enabled: true, freshness: 'current', conflict: false, createdAt: now, updatedAt: now });
        draft.state = 'approved';
      } else if (input.action === 'reject' || input.action === 'delete-draft') {
        if (!draft) learningError('Draft no longer exists.');
        if (input.action === 'reject') { if (draft.state !== 'pending') learningError('Only pending drafts can be rejected.'); draft.state = 'rejected'; }
        else state.drafts = state.drafts.filter((item) => item.id !== draft.id);
      } else if (input.action === 'set-enabled' || input.action === 'set-conflict' || input.action === 'delete-lesson') {
        if (!lesson) learningError('Lesson no longer exists in this scope.');
        if (input.action === 'set-enabled') lesson.enabled = input.enabled;
        else if (input.action === 'set-conflict') lesson.conflict = input.conflict;
        else {
          state.lessons = state.lessons.filter((item) => item.id !== lesson.id);
          const draftIds = new Set(state.revisions.filter((item) => item.lessonId === lesson.id).map((item) => item.createdFromDraftId));
          state.revisions = state.revisions.filter((item) => item.lessonId !== lesson.id);
          state.drafts = state.drafts.filter((item) => item.lessonId !== lesson.id && !draftIds.has(item.id));
        }
      } else if (input.action === 'delete-evidence') {
        if (!state.evidence.some((item) => item.id === input.id)) learningError('Evidence no longer exists.');
        state.evidence = state.evidence.filter((item) => item.id !== input.id);
        for (const item of state.lessons) if (state.revisions.some((revision) => revision.id === item.activeRevisionId && revision.evidenceIds.includes(input.id))) item.freshness = 'needs-review';
      } else if (input.action === 'set-mode') state.mode = input.mode;
      else if (input.action === 'reset') Object.assign(state, emptyLearningSnapshot(learningIdentity(origin.root, origin.binding.scope)), { revision: state.revision });
      const used = new Set([...state.drafts, ...state.revisions].flatMap((item) => item.evidenceIds));
      state.evidence = state.evidence.filter((item) => used.has(item.id));
    });
    if (input.action === 'reset' || input.action === 'delete-lesson' || input.action === 'delete-evidence' || input.action === 'delete-draft' || (input.action === 'set-mode' && input.mode === 'off')) {
      for (const request of this.requests.values()) if (request.binding.projectKey === origin.binding.projectKey && request.binding.scope === origin.binding.scope) request.controller.abort();
      for (const [id, owner] of this.captures) if (owner.origin.binding.projectKey === origin.binding.projectKey && owner.origin.binding.scope === origin.binding.scope) this.captures.delete(id);
    }
    if (capture) this.captures.delete(capture.id);
    this.emit(snapshot);
  }

  async generate(origin: LearningOrigin, input: GenerateDraftInput, provider: LearningProvider | null): Promise<{ outcome: 'draft' | 'no_lesson'; reason: string | null }> {
    this.assertBinding(origin, input.binding);
    const before = await this.requireCaptureEnabled(origin);
    if (before.epoch !== input.epoch || before.revision !== input.expectedRevision) learningError('Review changed before generation. Refresh first.');
    if (!provider) learningError('Configured provider is unavailable. Manual drafting still works.');
    const capture = structuredClone(this.capture(origin, input.captureId));
    if (capture.digest !== input.captureDigest) learningError('Source preview changed. Review it before sending.');
    if (this.requests.size >= 4 || this.requests.has(input.requestId)) learningError('A draft request is already active or the request limit was reached.');
    const controller = new AbortController();
    this.requests.set(input.requestId, { controller, binding: origin.binding });
    const timeout = setTimeout(() => controller.abort(), LEARNING_LIMITS.timeoutMs);
    const invalidation = setInterval(() => { if (!this.enabled(origin) || !this.captures.has(capture.id)) controller.abort(); }, 100);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Memory Learning: Generation cancelled or timed out. Provider billing may be uncertain.')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    let usage: LearningUsage = { inputTokens: null, outputTokens: null, costUsd: null };
    try {
      const generated = await Promise.race([generateLearningDraft(provider, capture, input, controller.signal, (known) => { usage = known; }), aborted]);
      if (controller.signal.aborted || !this.enabled(origin) || !this.captures.has(capture.id)) learningError('Delayed generation result discarded.');
      const snapshot = await this.repository.mutate(learningIdentity(origin.root, origin.binding.scope), { epoch: input.epoch, revision: input.expectedRevision }, (state) => {
        if (controller.signal.aborted || !this.enabled(origin) || state.mode === 'off' || this.capture(origin, capture.id).digest !== capture.digest) learningError('Generation binding or reviewed source changed. Result discarded.');
        if (generated.result.outcome === 'draft') {
          const { evidenceIds, uncertainty } = generated.result;
          const scopeError = memoryScopeError(generated.result.content, state.scope);
          if (scopeError) learningError(scopeError);
          const proposed = generated.result.content;
          const existing = isCoreMemory(proposed) ? state.lessons.find((item) => state.revisions.some((revision) => revision.id === item.activeRevisionId && revision.content.kind === proposed.kind)) : undefined;
          for (const evidence of capture.evidence.filter((item) => evidenceIds.includes(item.id))) if (!state.evidence.some((item) => item.id === evidence.id)) state.evidence.push(evidence);
          const previous = existing ? state.revisions.find((item) => item.id === existing.activeRevisionId) : undefined;
          const content = lessonContentSchema.parse(previous ? mergeProfileAdditions(previous.content, generated.result.content) : generated.result.content);
          const reviewedEvidenceIds = content.kind === 'user-profile' && previous ? [...new Set([...previous.evidenceIds, ...evidenceIds])].slice(-LEARNING_LIMITS.sources) : evidenceIds;
          state.drafts.push({ id: randomUUID(), lessonId: existing?.id ?? null, version: 1, state: 'pending', content, evidenceIds: reviewedEvidenceIds, uncertainty, digest: learningDigest({ content, evidenceIds: reviewedEvidenceIds }), createdAt: Date.now() });
        }
        state.generationUsage.push({ requestId: input.requestId, provider: input.provider, model: input.model, createdAt: Date.now(), outcome: generated.result.outcome, ...generated.usage });
      });
      this.emit(snapshot);
      return { outcome: generated.result.outcome, reason: generated.result.outcome === 'no_lesson' ? generated.result.reason : null };
    } catch (error) {
      // Do not resurrect deleted stores or overwrite concurrent edits to record a late bill.
      await this.repository.mutate(learningIdentity(origin.root, origin.binding.scope), { epoch: input.epoch, revision: input.expectedRevision }, (state) => {
        if (!origin.valid()) learningError('Origin no longer exists.');
        state.generationUsage.push({ requestId: input.requestId, provider: input.provider, model: input.model, createdAt: Date.now(), outcome: controller.signal.aborted ? 'cancelled' : 'failed', ...usage });
      }).then((state) => this.emit(state)).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout); clearInterval(invalidation); controller.signal.removeEventListener('abort', onAbort); this.requests.delete(input.requestId);
    }
  }

  async previewSelection(origin: LearningOrigin, input: PreviewSelectionInput) {
    this.assertBinding(origin, input.binding, true);
    const snapshot = await this.repository.read(learningIdentity(origin.root, 'project'));
    const global = await this.repository.read(learningIdentity(origin.root, 'global')).catch(() => null);
    const companions = global ? [global] : [];
    return (await selectLearning({ snapshot, companions, enabled: this.settings().enabled && origin.valid(), layers: this.layers(), root: origin.root, projectKey: origin.binding.projectKey, text: input.text, pins: input.pins, pinScope: input.binding.scope, excluded: input.excluded, branch: snapshot.revisions.some((item) => item.content.activation.branchRestriction) ? (await learningCodeState(origin.root)).branch : null })).selection;
  }

  async prepareDispatch(origin: LearningOrigin, dispatchId: string, text: string, turn?: LearningTurn): Promise<{ block: string; manifest: LearningManifest } | null> {
    if (turn) {
      try { this.assertBinding(origin, turn.binding, true); }
      catch (error) { if (turn.pins.length) throw error; return null; }
    }
    if (!origin.valid() || !this.settings().enabled) { if (turn?.pins.length) learningError('Learning is off. Remove the explicit selection or re-enable it.'); return null; }
    try {
      let prepared: { block: string; manifest: LearningManifest } | null = null;
      let blocked = false;
      const identity = learningIdentity(origin.root, 'project');
      const snapshot = await this.repository.mutate(identity, null, async (state, companions) => {
        const { selection, block } = await selectLearning({ snapshot: state, companions, enabled: this.settings().enabled && origin.valid(), layers: this.layers(), root: origin.root, projectKey: origin.binding.projectKey, text, pins: turn?.pins ?? [], pinScope: turn?.binding.scope ?? origin.binding.scope, excluded: turn?.excluded ?? [], branch: state.revisions.some((item) => item.content.activation.branchRestriction) ? (await learningCodeState(origin.root)).branch : null });
        blocked = Boolean(turn?.pins.some((pin) => !selection.selected.some((item) => item.revisionId === pin.revisionId && item.scope === (pin.scope ?? turn.binding.scope))));
        if (!this.active(origin)) learningError('Learning changed before dispatch.');
        const manifest: LearningManifest = { dispatchId, projectKey: origin.binding.projectKey, sessionId: origin.binding.sessionId ?? 'no-session', scope: 'project', policyVersion: 2, mode: state.mode, contextModes: { project: state.mode, global: companions[0]?.mode ?? null }, createdAt: Date.now(), items: selection.selected.map(({ title: _title, ...item }) => item), skipped: selection.skipped, contextDigest: learningDigest(block), bytes: selection.bytes, estimatedTokens: selection.estimatedTokens, tokenMethod: selection.tokenMethod, state: blocked ? 'not-sent' : 'prepared' };
        state.manifests.push(manifest);
        prepared = { block, manifest };
      }, learningIdentity(origin.root, 'global'));
      this.emit(snapshot);
      if (blocked) learningError('An explicitly selected revision changed or became ineligible. Restore the queued draft and refresh its selection, or send without it.');
      return prepared;
    } catch (error) { if (turn?.pins.length) throw error; return null; }
  }

  async markDispatch(origin: LearningOrigin, dispatchId: string, status: LearningManifest['state']): Promise<void> {
    await this.repository.mutate(learningIdentity(origin.root, 'project'), null, (state) => {
      const manifest = state.manifests.find((item) => item.dispatchId === dispatchId);
      if (!manifest) learningError('Manifest was deleted; do not recreate it.');
      manifest.state = status;
    }).then((snapshot) => this.emit(snapshot)).catch(() => undefined);
  }

  async recover(origin: LearningOrigin, input: LearningRecoveryInput): Promise<void> {
    this.assertBinding(origin, input.binding);
    const identity = learningIdentity(origin.root, origin.binding.scope);
    if (input.action === 'recover-lock') await this.repository.recoverLock(identity, input.digest);
    else { if (input.confirmation !== 'DELETE LEARNING') learningError('Explicit deletion confirmation is required.'); await this.repository.resetCorrupt(identity, input.digest); this.invalidate(origin); }
    this.emit(await this.repository.read(identity));
  }
}
