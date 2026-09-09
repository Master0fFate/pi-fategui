import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, X } from 'lucide-react';
import { emptyActivation, lessonContentSchema, type LearningCapture, type LearningMutation, type LearningScope, type LearningState, type LessonContent, type PreviewEvidenceInput } from '../../../shared/contracts/learning';
import { learningMarkdown } from '../../../shared/learningMarkdown';
import { isCoreMemory, memoryKindLabel, newCoreMemory } from '../../../shared/learningMemory';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ipcErrorMessage } from '../../lib/ipcError';
import { learningDraftKey, useLearningStore } from './learningStore';
import './learning.css';

type Editor = { id?: string; lessonId?: string; content: LessonContent; evidenceIds: string[]; review?: { epoch: string; expectedRevision: number; digest: string } | undefined };
type MutationAction = LearningMutation extends infer T ? T extends LearningMutation ? Omit<T, 'binding' | 'epoch' | 'expectedRevision'> : never : never;
const newNote = (): LessonContent => ({ kind: 'note', title: '', body: { guidance: '', rationale: '', exceptions: [] }, activation: { ...emptyActivation } });
const lineList = (value: string) => value ? value.split('\n') : [];
const readError = (error: unknown) => ipcErrorMessage(error, 'Memory Learning could not complete this action.');

export function LearningPanel() {
  const open = useLearningStore((state) => state.open);
  const correction = useLearningStore((state) => state.correction);
  const runtimeProject = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const key = learningDraftKey(runtimeProject, sessionId);
  const [state, setState] = useState<LearningState | null>(null);
  const [editScope, setEditScope] = useState<LearningScope>('project');
  const [view, setView] = useState<'lessons' | 'drafts' | 'recent'>('lessons');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [capture, setCapture] = useState<LearningCapture | null>(null);
  const [excerpts, setExcerpts] = useState<{ id: string; text: string }[]>([]);
  const [manual, setManual] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [filePath, setFilePath] = useState('');
  const [startLine, setStartLine] = useState(1);
  const [endLine, setEndLine] = useState(30);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const request = useRef<string | null>(null);
  const captureRef = useRef<LearningCapture | null>(null);
  const stateRef = useRef<LearningState | null>(null);
  const generation = useRef(0);
  const captureInitialized = useRef(false);
  const snapshot = state?.snapshot;
  const enabled = state?.enabled && snapshot?.mode !== 'off';
  const recentUse = state?.recentUse ?? snapshot?.manifests ?? [];
  stateRef.current = state;
  captureRef.current = capture;
  const refresh = useCallback(async () => {
    if (!window.piDesktop?.getLearningState) return;
    const current = generation.current;
    try {
      const next = await window.piDesktop.getLearningState(editScope);
      if (current !== generation.current) return;
      if (stateRef.current?.binding && next.binding && stateRef.current.binding.scope !== next.binding.scope) { setEditor(null); setCapture(null); setExcerpts([]); }
      setState(next);
      if (!captureInitialized.current && next.binding) {
        captureInitialized.current = true;
        if (correction !== null) setEditor({ content: next.binding.scope === 'global' ? newCoreMemory('global') : newNote(), evidenceIds: [] });
      }
    } catch (failure) { if (current === generation.current) setError(readError(failure)); }
  }, [correction, editScope]);
  useEffect(() => {
    if (!open) return;
    ++generation.current;
    captureInitialized.current = false;
    setState(null); setEditor(null);
    setManual(correction ?? ''); setIntent(''); setCapture(null); setExcerpts([]); setSelectedSources([]); setFilePath(''); setError(null); setNotice(null); setBusy(false);
    void refresh();
    const unsubscribe = window.piDesktop?.onLearningChanged?.(() => { void refresh(); });
    return () => {
      ++generation.current; unsubscribe?.();
      const binding = stateRef.current?.binding;
      if (binding) {
        if (request.current) void window.piDesktop.cancelLearning({ binding, id: request.current }).catch(() => undefined);
        if (captureRef.current) void window.piDesktop.cancelLearning({ binding, id: captureRef.current.id }).catch(() => undefined);
      }
      request.current = null;
    };
  }, [open, runtimeProject, sessionId, correction, refresh]);
  const run = async (operation: () => Promise<void>) => {
    const current = generation.current;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (failure) { if (current === generation.current) setError(readError(failure)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const mutate = async (action: MutationAction, review?: Editor['review']) => {
    if (!state?.binding || !snapshot) return;
    const current = generation.current;
    const result = await window.piDesktop.mutateLearning({ binding: state.binding, epoch: review?.epoch ?? snapshot.epoch, expectedRevision: review?.expectedRevision ?? snapshot.revision, ...action } as LearningMutation);
    if (current === generation.current) { setState(result); setEditor(null); setCapture(null); }
  };
  const preview = () => run(async () => {
    if (!state?.binding) return;
    const sources: PreviewEvidenceInput['sources'] = selectedSources.flatMap((id) => {
      const source = state.sources.find((item) => item.entryId === id);
      return source ? [{ kind: 'entry' as const, entryId: id, leafId: source.leafId }] : [];
    });
    if (manual.trim()) sources.push({ kind: 'manual', text: manual });
    if (filePath.trim()) sources.push({ kind: 'file', path: filePath.trim(), startLine, endLine });
    const current = generation.current;
    if (capture) await window.piDesktop.cancelLearning({ binding: state.binding, id: capture.id });
    const requestId = crypto.randomUUID(); request.current = requestId;
    try {
      const next = await window.piDesktop.previewLearningEvidence({ binding: state.binding, requestId, sources });
      if (current !== generation.current) return;
      setCapture(next); setExcerpts(next.evidence.map(({ id, text }) => ({ id, text })));
    } finally { if (request.current === requestId) request.current = null; }
  });
  const previewUnchanged = capture && JSON.stringify(excerpts) === JSON.stringify(capture.evidence.map(({ id, text }) => ({ id, text })));
  const generate = () => run(async () => {
    if (!capture || !state?.binding || !snapshot || !state.provider || !previewUnchanged) return;
    const id = crypto.randomUUID(); request.current = id;
    const current = generation.current;
    try {
      const result = await window.piDesktop.generateLearningDraft({ binding: state.binding, epoch: snapshot.epoch, expectedRevision: snapshot.revision, captureId: capture.id, captureDigest: capture.digest, requestId: id, ...(editor ? { kind: editor.content.kind } : {}), correction: intent, ...state.provider, consent: true });
      if (current !== generation.current) return;
      setState(result.state); setNotice(result.reason ?? 'Pending draft created. Review and approve it separately.'); setView('drafts'); setEditor(null);
    } finally { if (request.current === id) request.current = null; }
  });
  const updateContent = (content: LessonContent) => setEditor((previous) => previous ? { ...previous, content, review: undefined } : null);
  const updateBody = (field: string, value: string | string[]) => {
    if (!editor) return;
    updateContent({ ...editor.content, body: { ...editor.content.body, [field]: value } } as LessonContent);
  };
  const openCore = () => {
    const scope = state?.binding?.scope ?? 'project';
    const kind = scope === 'global' ? 'user-profile' : 'project-brief';
    const lesson = snapshot?.lessons.find((item) => snapshot.revisions.some((revision) => revision.id === item.activeRevisionId && revision.content.kind === kind));
    const revision = lesson ? snapshot?.revisions.find((item) => item.id === lesson.activeRevisionId) : null;
    setEditor(revision && lesson ? { lessonId: lesson.id, content: structuredClone(revision.content), evidenceIds: revision.evidenceIds } : { content: newCoreMemory(scope), evidenceIds: [] });
    setView('drafts');
  };
  const evidenceView = (ids: string[]) => ids.map((id) => {
    const evidence = snapshot?.evidence.find((item) => item.id === id);
    return <details key={id}><summary>{evidence ? `${evidence.basis} · ${evidence.source.path ?? evidence.source.entryId ?? 'manual text'}` : 'Evidence deleted — review required'}</summary>{evidence && <><pre>{evidence.text}</pre><small>Commit: {evidence.codeState.commit ?? 'unknown'} · verification/code-state association: unknown · {evidence.omitted ? 'excerpt / omissions' : 'selected text'}</small><button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'delete-evidence', id }))}>Delete evidence</button></>}</details>;
  });
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) useLearningStore.getState().close(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="learning-dialog" aria-describedby="learning-description">
      <header><div><Dialog.Title><Brain size={18} /> Memory Learning</Dialog.Title><Dialog.Description id="learning-description">{state?.binding?.scope.toUpperCase() ?? 'PROJECT'} · {state?.projectName || 'No trusted project'} · reviewed knowledge, not model training.</Dialog.Description></div><Dialog.Close aria-label="Close Memory Learning"><X size={18} /></Dialog.Close></header>
      <div className="learning-body">
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        {busy && <div role="status">Working… <button type="button" onClick={() => { const binding = stateRef.current?.binding; if (binding && request.current) void window.piDesktop.cancelLearning({ binding, id: request.current }).catch(() => undefined); }}>Cancel capture or generation</button></div>}
        {!enabled && <p role="status">Learning is off. Existing data remains manageable. Enable Memory Learning in Settings → Memory Learning; choose GLOBAL or PROJECT and save.</p>}
        {state?.binding?.scope === 'global' ? <p className="learning-warning">GLOBAL is your coding profile: communication, workflow, design taste, likes and dislikes. Only explicit reviewed preferences—not guessed psychology or repository state. Automatic mode reuses it across trusted projects.</p> : <p>PROJECT holds this repository’s purpose, architecture, decisions, current work and next steps. A reviewed briefing prevents repeating orientation in every session; it does not replace checking current code.</p>}
        {state?.contextModes && <p>Context layers: GLOBAL {state.contextModes.global ?? 'unavailable'} + PROJECT {state.contextModes.project ?? 'unavailable'}. The scope selector chooses what you edit, not an exclusive context source. Current instructions always win.</p>}
        {state?.diagnostic && <p role="status">{state.diagnostic}</p>}
        {snapshot && state?.binding && <>
          <div className="learning-actions"><button type="button" aria-pressed={editScope === 'global'} onClick={() => { setEditScope('global'); setEditor(null); }}>Profile</button><button type="button" aria-pressed={editScope === 'project'} onClick={() => { setEditScope('project'); setEditor(null); }}>Project</button><label>Selection mode <select aria-label="Learning selection mode" value={snapshot.mode} disabled={busy} onChange={(event) => void run(() => mutate({ action: 'set-mode', mode: event.target.value as 'off' | 'manual' | 'automatic' }))}><option value="off">Off</option><option value="manual">Manual</option><option value="automatic">Automatic (opt-in)</option></select></label>{state.binding.scope === 'project' && <button type="button" disabled={!enabled || busy} onClick={() => { setEditor({ content: newNote(), evidenceIds: [] }); setView('drafts'); }}>Add lesson</button>}<button type="button" disabled={!enabled || busy} onClick={openCore}>{state.binding.scope === 'global' ? 'User profile' : 'Project briefing'}</button><button type="button" onClick={() => void refresh()}>Refresh</button></div>
          <nav className="learning-actions" aria-label="Learning views">{(['lessons', 'drafts', 'recent'] as const).map((tab) => <button type="button" aria-pressed={view === tab} key={tab} onClick={() => { setView(tab); setEditor(null); }}>{tab === 'recent' ? 'Recent use' : tab === 'drafts' ? 'Drafts' : 'Lessons'}</button>)}</nav>
          {view === 'lessons' && !editor && <>
            {!snapshot.lessons.length && <p>{state.binding.scope === 'global' ? 'No approved user profile yet. Open User profile to record explicit coding preferences.' : 'No approved project memory yet. Add a briefing, note, or managed project skill.'}</p>}
            {snapshot.lessons.map((lesson) => {
              const revision = snapshot.revisions.find((item) => item.id === lesson.activeRevisionId)!;
              return <article className="learning-card" key={lesson.id}><h3>{revision.content.title} <small>{memoryKindLabel(revision.content.kind)} · v{revision.revisionNumber}</small></h3><p>Approved by you · {lesson.enabled ? 'Enabled' : 'Disabled'} · {lesson.freshness}{lesson.conflict ? ' · unresolved conflict' : ''}</p><pre>{learningMarkdown(revision.content)}</pre><small>Activation: {JSON.stringify(revision.content.activation)}</small>
                <div className="learning-actions"><button type="button" disabled={!enabled || !lesson.enabled || lesson.conflict || lesson.freshness !== 'current' || !sessionId} onClick={() => {
                  if (!state.binding) return;
                  const existing = useLearningStore.getState().turns[key];
                  const sameSession = existing && existing.binding.projectKey === state.binding.projectKey && existing.binding.sessionId === state.binding.sessionId && existing.binding.runtimeGeneration === state.binding.runtimeGeneration;
                  const pins = sameSession ? existing.pins.filter((item) => item.lessonId !== lesson.id).map((item) => ({ ...item, scope: item.scope ?? existing.binding.scope })) : [];
                  if (pins.length >= 3) { setError('At most three items can be selected for one turn.'); return; }
                  useLearningStore.getState().setTurn(key, { binding: state.binding, pins: [...pins, { lessonId: lesson.id, revisionId: revision.id, scope: state.binding.scope }], excluded: existing?.excluded ?? [] });
                  setNotice('Selected exact revision for the next turn. Eligibility is checked again at dispatch.');
                }}>Use on next turn</button><button type="button" disabled={!enabled || busy} onClick={() => setEditor({ lessonId: lesson.id, content: structuredClone(revision.content), evidenceIds: revision.evidenceIds })}>Edit as new draft</button><button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'set-enabled', id: lesson.id, enabled: !lesson.enabled }))}>{lesson.enabled ? 'Disable' : 'Re-enable'}</button><button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'set-conflict', id: lesson.id, conflict: !lesson.conflict }))}>{lesson.conflict ? 'Resolve conflict' : 'Mark conflict'}</button></div>
                <details><summary>Evidence and revision history</summary>{evidenceView(revision.evidenceIds)}{snapshot.revisions.filter((item) => item.lessonId === lesson.id).map((item) => <details key={item.id}><summary>Revision {item.revisionNumber} · {item.id}</summary><pre>{learningMarkdown(item.content)}</pre><code>{item.contentDigest}</code><button type="button" disabled={!enabled || busy} onClick={() => setEditor({ lessonId: lesson.id, content: structuredClone(item.content), evidenceIds: item.evidenceIds })}>Review this content as a new revision</button></details>)}</details>
                <details><summary>Delete lesson</summary><p>Removes all stored revisions and orphan evidence. Past provider requests and sessions are not erased.</p><button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'delete-lesson', id: lesson.id }))}>Confirm delete lesson</button></details>
              </article>;
            })}
          </>}
          {view === 'drafts' && !editor && <>{!snapshot.drafts.length && <p>No drafts. Manual creation works without a provider.</p>}{snapshot.drafts.map((draft) => <article className="learning-card" key={draft.id}><h3>{draft.content.title}</h3><p>{draft.state} · user review is not verification.</p><div className="learning-actions">{draft.state === 'pending' && <button type="button" onClick={() => setEditor({ id: draft.id, ...(draft.lessonId ? { lessonId: draft.lessonId } : {}), content: structuredClone(draft.content), evidenceIds: draft.evidenceIds, review: { epoch: snapshot.epoch, expectedRevision: snapshot.revision, digest: draft.digest } })}>Review draft</button>}<button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'delete-draft', id: draft.id }))}>Delete draft</button></div></article>)}</>}
          {editor && <section className="learning-editor" aria-label="Lesson review">
            <h3>{editor.id ? 'Review exact draft' : editor.lessonId ? 'Pending replacement — approved content stays unchanged' : 'Add lesson'}</h3>
            <label>Type <select aria-label="Lesson type" value={editor.content.kind} onChange={(event) => updateContent(event.target.value === 'user-profile' ? newCoreMemory('global') : event.target.value === 'project-brief' ? newCoreMemory('project') : event.target.value === 'note' ? newNote() : { kind: 'procedure', title: editor.content.title, body: { purpose: '', useWhen: [], doNotUseWhen: [], preconditions: [], steps: [], verification: [], stopConditions: [] }, activation: { ...emptyActivation } })}>{state.binding.scope === 'global' ? <><option value="user-profile">User coding profile</option>{editor.content.kind !== 'user-profile' && <option value={editor.content.kind}>Legacy shared lesson — convert before saving</option>}</> : <><option value="note">Note</option><option value="procedure">Project skill (procedure)</option><option value="project-brief">Project briefing</option></>}</select></label>
            {isCoreMemory(editor.content) && <p>A single reviewed core memory is reused on new turns when this scope is set to Automatic. Profile updates remain pending until approved. Briefings with current work or next steps require review after seven days, or when referenced files change.</p>}
            <label>Title<input value={editor.content.title} maxLength={160} onChange={(event) => updateContent({ ...editor.content, title: event.target.value })} /></label>
            {Object.entries(editor.content.body).map(([field, value]) => <label key={field}>{field.replace(/([A-Z])/gu, ' $1')}<textarea aria-label={field} value={Array.isArray(value) ? value.join('\n') : value} onChange={(event) => updateBody(field, Array.isArray(value) ? lineList(event.target.value) : event.target.value)} /></label>)}
            {snapshot.drafts.find((item) => item.id === editor.id)?.uncertainty.map((text, index) => <p className="learning-warning" key={index}>{text}</p>)}
            {!isCoreMemory(editor.content) && <><h4>Activation scope (reviewed with the content)</h4>{(['relativePaths', 'symbols', 'keywords'] as const).map((field) => <label key={field}>{field} (one per line)<textarea aria-label={field} value={editor.content.activation[field].join('\n')} onChange={(event) => updateContent({ ...editor.content, activation: { ...editor.content.activation, [field]: lineList(event.target.value) } })} /></label>)}
            <label>Branch restriction<input value={editor.content.activation.branchRestriction ?? ''} onChange={(event) => updateContent({ ...editor.content, activation: { ...editor.content.activation, branchRestriction: event.target.value || null } })} /></label></>}
            {snapshot.revisions.filter((item) => item.lessonId !== editor.lessonId && JSON.stringify(item.content.body) === JSON.stringify(editor.content.body)).slice(0, 3).map((item) => <p className="learning-warning" key={item.id}>Exact content duplicate: {item.content.title}. Keep one item or narrow the scope; nothing is automatically merged.</p>)}
            {snapshot.revisions.filter((item) => item.lessonId !== editor.lessonId && item.content.activation.keywords.filter((word) => editor.content.activation.keywords.includes(word)).length >= 2).slice(0, 3).map((item) => <p key={item.id}>Possible overlap: {item.content.title}. Lexical overlap does not establish contradiction. Mark conflicting lessons before reuse.</p>)}
            <details open><summary>Reviewed evidence</summary>{evidenceView(editor.evidenceIds)}{!editor.evidenceIds.length && <p>Manual content without runtime evidence is a user assertion, not a verified result.</p>}</details>
            <details open={correction !== null}><summary>Capture or replace evidence</summary>
              <p>Select exact durable entries below, or paste text as user-asserted evidence. Message-row text is never treated as an authenticated entry ID.</p>
              <label>Manual evidence (user-asserted)<textarea value={manual} onChange={(event) => setManual(event.target.value)} maxLength={16384} /></label>
              <div className="learning-sources">{state.sources.map((source) => <label key={source.entryId}><input type="checkbox" checked={selectedSources.includes(source.entryId)} onChange={(event) => setSelectedSources((previous) => event.target.checked ? [...previous, source.entryId] : previous.filter((id) => id !== source.entryId))} /><span>{source.role} · {source.entryId} · {source.preview}</span></label>)}</div>
              <label>Project-relative file (optional)<input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="src/main/example.ts" /></label><div className="learning-actions"><label>First line<input type="number" min={1} value={startLine} onChange={(event) => setStartLine(event.target.valueAsNumber)} /></label><label>Last line<input type="number" min={1} value={endLine} onChange={(event) => setEndLine(event.target.valueAsNumber)} /></label></div>
              <button type="button" disabled={!enabled || busy} onClick={() => void preview()}>Preview selected evidence</button>
            </details>
            {capture && <section aria-label="Exact provider source preview"><h4>Exact redacted sources to send</h4><p>Review every excerpt. Secret filtering is not exhaustive. Only this accepted preview is retained.</p>{excerpts.map((excerpt) => <label key={excerpt.id}>Source {excerpt.id}<textarea value={excerpt.text} onChange={(event) => setExcerpts((previous) => previous.map((item) => item.id === excerpt.id ? { ...item, text: event.target.value } : item))} /><button type="button" onClick={() => setExcerpts((previous) => previous.filter((item) => item.id !== excerpt.id))}>Remove source</button></label>)}
              <button type="button" disabled={busy || !excerpts.length} onClick={() => void run(async () => { if (!state.binding) return; const current = generation.current; const next = await window.piDesktop.reviewLearningCapture({ binding: state.binding, captureId: capture.id, excerpts }); if (current === generation.current) { setCapture(next); setExcerpts(next.evidence.map(({ id, text }) => ({ id, text }))); } })}>Accept redacted preview</button>
              <label>Intended lesson / correction<textarea value={intent} maxLength={4000} onChange={(event) => setIntent(event.target.value)} /></label>
              <p>{state.provider ? `Provider: ${state.provider.provider} · Model: ${state.provider.model}. Generate sends these sources and your correction in one tool-free request and may incur provider cost.` : 'Provider unavailable. Save and edit manually instead.'}</p>
              <button type="button" disabled={!enabled || busy || !state.provider || !previewUnchanged} onClick={() => void generate()}>Generate draft — send reviewed sources</button>
              {request.current && <button type="button" onClick={() => { if (state.binding && request.current) void window.piDesktop.cancelLearning({ binding: state.binding, id: request.current }); }}>Cancel generation</button>}
            </section>}
            <div className="learning-actions"><button type="button" disabled={!enabled || busy || Boolean(capture && !previewUnchanged)} onClick={() => void run(async () => {
              const candidate: unknown = JSON.parse(JSON.stringify(editor.content), (_key, value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.map((item: string) => item.trim()).filter(Boolean) : value);
              const validated = lessonContentSchema.safeParse(candidate);
              if (!validated.success) throw new Error(validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).slice(0, 4).join('; '));
              await mutate({ action: 'save-draft', ...(editor.id ? { id: editor.id } : {}), ...(editor.lessonId ? { lessonId: editor.lessonId } : {}), content: validated.data, evidenceIds: editor.evidenceIds, ...(capture ? { captureId: capture.id } : {}) }); setView('drafts');
            })}>Save draft</button>{editor.id && <><button type="button" disabled={busy || !editor.review} onClick={() => void run(() => mutate({ action: 'approve', id: editor.id!, digest: editor.review!.digest }, editor.review))}>Approve exact revision</button><button type="button" disabled={busy} onClick={() => void run(() => mutate({ action: 'reject', id: editor.id! }))}>Reject</button></>}<button type="button" onClick={() => setEditor(null)}>Cancel review</button></div>
            {!editor.review && editor.id && <p>Edited content must be saved and reviewed again before approval.</p>}
          </section>}
          {view === 'recent' && !editor && <>
            {!recentUse.length && <p>No learning dispatches recorded. A selection preview is not a sent request.</p>}
            {[...recentUse].reverse().map((manifest) => <article className="learning-card" key={manifest.dispatchId}><h3>{manifest.state === 'handed-to-runtime' ? 'Handed to runtime (provider receipt unproven)' : manifest.state === 'prepared' ? 'Prepared — delivery uncertain if interrupted' : manifest.state}</h3><small>{manifest.dispatchId} · session {manifest.sessionId} · {manifest.bytes} UTF-8 bytes · ~{manifest.estimatedTokens} tokens ({manifest.tokenMethod})</small><ul>{manifest.items.map((item) => <li key={item.revisionId}>{(item.scope ?? manifest.scope).toUpperCase()} · {item.revisionId} {(item.scope ?? manifest.scope) !== snapshot.scope ? '(other memory scope)' : snapshot.revisions.some((revision) => revision.id === item.revisionId) ? '' : '(source revision deleted)'} — {item.reasons.join('; ')}</li>)}{manifest.skipped.map((item) => <li key={item.lessonId}>Skipped {item.lessonId}: {item.reason}</li>)}</ul></article>)}
            <h3>Draft generation usage (separate from coding)</h3>{snapshot.generationUsage.map((usage) => <p key={usage.requestId}>{usage.provider}/{usage.model} · {usage.outcome} · {usage.costUsd === null ? 'cost unknown' : `$${usage.costUsd}`} · input {usage.inputTokens ?? 'unknown'} / output {usage.outputTokens ?? 'unknown'}</p>)}
          </>}
        </>}
        <details><summary>Deletion limits and recovery</summary><p>Disable stops future use. Deletion cannot retract provider requests or remove text from existing Pi sessions, exported copies, or OS backups. Use a fresh session to avoid historical context. This is not secure erasure.</p><label>Type DELETE LEARNING to reset the selected scope<input aria-label="Reset learning confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button type="button" disabled={busy || confirmation !== 'DELETE LEARNING' || !state?.binding} onClick={() => void run(async () => {
          if (!state?.binding) return;
          if (snapshot) await mutate({ action: 'reset', confirmation: 'DELETE LEARNING' });
          else if (state.recoveryDigest) setState(await window.piDesktop.recoverLearning({ binding: state.binding, action: 'reset-store', digest: state.recoveryDigest, confirmation: 'DELETE LEARNING' }));
          else throw new Error('Unsafe or oversized store requires manual recovery; no automatic reset is offered.');
          setConfirmation('');
        })}>Reset selected learning scope</button>{state?.recoveryDigest && snapshot && <button type="button" disabled={busy} onClick={() => void run(async () => { if (state.binding && state.recoveryDigest) setState(await window.piDesktop.recoverLearning({ binding: state.binding, action: 'recover-lock', digest: state.recoveryDigest })); })}>Recover dead writer lock</button>}</details>
        <button type="button" onClick={() => { useLearningStore.getState().close(); useUiStore.getState().setSettingsOpen(true); }}>Open Settings</button>
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
