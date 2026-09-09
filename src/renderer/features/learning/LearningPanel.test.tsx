import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../../shared/contracts/ipc';
import { emptyActivation, type LearningState } from '../../../shared/contracts/learning';
import { useLearningStore } from './learningStore';
import { LearningPanel } from './LearningPanel';

const draftId = '00000000-0000-4000-8000-000000000001';
const state: LearningState = {
  binding: { projectKey: 'a'.repeat(64), sessionId: 'session', runtimeGeneration: 1, scope: 'project' }, projectName: 'repo', enabled: true, diagnostic: null, recoveryDigest: null, provider: null, sources: [],
  snapshot: { schemaVersion: 1, projectKey: 'a'.repeat(64), canonicalRoot: '/repo', scope: 'project', epoch: '00000000-0000-4000-8000-000000000002', revision: 1, mode: 'manual', lessons: [], revisions: [], evidence: [], generationUsage: [], manifests: [], drafts: [{ id: draftId, lessonId: null, version: 1, state: 'pending', content: { kind: 'note', title: 'Reviewed note', body: { guidance: 'Keep IO in main', rationale: '', exceptions: [] }, activation: emptyActivation }, evidenceIds: [], digest: 'b'.repeat(64), createdAt: 1, uncertainty: [] }] },
};
beforeEach(() => useLearningStore.setState({ open: true, correction: null, turns: {} }));
afterEach(() => { Reflect.deleteProperty(window, 'piDesktop'); useLearningStore.getState().close(); });
function bridge() {
  let changed: (() => void) | undefined;
  const api = { getLearningState: vi.fn(async () => structuredClone(state)), onLearningChanged: vi.fn((listener: () => void) => { changed = listener; return vi.fn(); }), mutateLearning: vi.fn(async () => structuredClone(state)), cancelLearning: vi.fn(async () => undefined) };
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: api as unknown as PiDesktopApi });
  return { api, emit: () => changed?.() };
}
describe('Learning review UI', () => {
  it('offers a structured GLOBAL user profile instead of a generic shared repository note', async () => {
    const { api } = bridge();
    const global = structuredClone(state); global.binding!.scope = 'global'; global.snapshot!.scope = 'global'; global.snapshot!.drafts = [];
    api.getLearningState.mockResolvedValue(global);
    const user = userEvent.setup(); render(<LearningPanel />);
    await user.click(await screen.findByRole('button', { name: 'User profile' }));
    expect(screen.queryByRole('button', { name: 'Add lesson' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('communication'), 'Be concise.');
    await user.type(screen.getByLabelText('designPreferences'), 'Use restrained dark themes.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.mutateLearning).toHaveBeenCalledWith(expect.objectContaining({ action: 'save-draft', content: expect.objectContaining({ kind: 'user-profile', body: expect.objectContaining({ communication: ['Be concise.'] }) }) })));
  });
  it('keeps manual drafting available without a provider and labels assertion limits', async () => {
    const { api } = bridge(); const user = userEvent.setup(); render(<LearningPanel />);
    await user.click(await screen.findByRole('button', { name: 'Add lesson' }));
    await user.type(screen.getByLabelText('Title'), 'A manual note');
    await user.type(screen.getByLabelText('guidance'), 'Use named IPC.');
    expect(screen.getByText(/Manual content without runtime evidence/u)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.mutateLearning).toHaveBeenCalledWith(expect.objectContaining({ action: 'save-draft', content: expect.objectContaining({ title: 'A manual note' }) })));
  });
  it('pins the approval token shown in review even after a second-window state update', async () => {
    const { api, emit } = bridge(); const user = userEvent.setup(); render(<LearningPanel />);
    await user.click(await screen.findByRole('button', { name: 'Drafts' }));
    await user.click(screen.getByRole('button', { name: 'Review draft' }));
    const changed = structuredClone(state); changed.snapshot!.revision = 2; changed.snapshot!.drafts[0]!.digest = 'c'.repeat(64);
    api.getLearningState.mockResolvedValue(changed); emit();
    await waitFor(() => expect(api.getLearningState).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Approve exact revision' }));
    expect(api.mutateLearning).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', expectedRevision: 1, digest: 'b'.repeat(64) }));
  });
  it('editing invalidates approval and off state blocks new captures, not management', async () => {
    bridge(); const user = userEvent.setup(); render(<LearningPanel />);
    await user.click(await screen.findByRole('button', { name: 'Drafts' }));
    await user.click(screen.getByRole('button', { name: 'Review draft' }));
    fireEvent.change(screen.getByLabelText('guidance'), { target: { value: 'Edited guidance' } });
    expect(screen.getByRole('button', { name: 'Approve exact revision' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  });
});
