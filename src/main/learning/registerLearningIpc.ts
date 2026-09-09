import { BrowserWindow } from 'electron';
import { ipcChannels, emptyInputSchema } from '../../shared/contracts/ipc';
import { cancelLearningInputSchema, captureSchema, generateDraftInputSchema, generationResultSchema, learningChangedSchema, learningMutationSchema, learningStateSchema, previewEvidenceInputSchema, previewSelectionInputSchema, recoveryInputSchema, reviewCaptureInputSchema, selectionSchema, learningStorageSchema, learningStateInputSchema } from '../../shared/contracts/learning';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import { PiDesktopError } from '../pi/errors';
import { learningError, learningIdentity } from './LearningRepository';
import type { LearningService } from './LearningService';

type Register = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => void;
export function registerLearningIpc(handle: Register, runtime: PiRuntimeService, service: LearningService | undefined, settingsFile: () => string): void {
  const register = (channel: string, work: (input: unknown, learning: LearningService) => Promise<unknown> | unknown) => handle(channel, async (_event, input) => {
    if (!service) learningError('This runtime does not support Memory Learning.');
    try { return await work(input, service); }
    catch (error) {
      if (error instanceof PiDesktopError) throw error;
      learningError('Operation failed or was cancelled. Refresh and review before retrying; provider delivery or cost may be uncertain.');
    }
  });
  register(ipcChannels.learningGetStorage, (input, learning) => {
    emptyInputSchema.parse(input);
    const project = runtime.getState(false).project;
    return learningStorageSchema.parse({ settingsFile: settingsFile(), globalFile: learning.repository.snapshotPath(learningIdentity('', 'global')), projectFile: project?.trusted ? learning.repository.snapshotPath(learningIdentity(project.path, 'project')) : null });
  });
  register(ipcChannels.learningGetState, async (input, learning) => {
    const scope = learningStateInputSchema.parse(input ?? {}).scope ?? 'project';
    if (!runtime.getState(false).project?.trusted) return learningStateSchema.parse({ binding: null, projectName: '', enabled: false, snapshot: null, diagnostic: 'Open a trusted project to manage learning.', recoveryDigest: null, provider: null, sources: [] });
    return learningStateSchema.parse(await learning.state(runtime.learningOrigin(undefined, scope), runtime.learningProvider()));
  });
  const originFor = (scope: 'global' | 'project' = 'project') => runtime.learningOrigin(undefined, scope);
  register(ipcChannels.learningMutate, async (input, learning) => {
    const parsed = learningMutationSchema.parse(input);
    const origin = originFor(parsed.binding.scope);
    const provider = runtime.learningProvider();
    await learning.mutate(origin, parsed);
    return learningStateSchema.parse(await learning.state(origin, provider));
  });
  register(ipcChannels.learningPreviewEvidence, async (input, learning) => {
    const parsed = previewEvidenceInputSchema.parse(input);
    return captureSchema.parse(await learning.previewEvidence(originFor(parsed.binding.scope), parsed));
  });
  register(ipcChannels.learningReviewCapture, async (input, learning) => {
    const parsed = reviewCaptureInputSchema.parse(input);
    return captureSchema.parse(await learning.reviewCapture(originFor(parsed.binding.scope), parsed));
  });
  register(ipcChannels.learningGenerateDraft, async (input, learning) => {
    const parsed = generateDraftInputSchema.parse(input);
    const origin = originFor(parsed.binding.scope);
    const provider = runtime.learningProvider();
    const result = await learning.generate(origin, parsed, provider);
    return generationResultSchema.parse({ ...result, state: await learning.state(origin, provider) });
  });
  register(ipcChannels.learningCancel, (input, learning) => {
    const parsed = cancelLearningInputSchema.parse(input);
    const origin = originFor(parsed.binding.scope);
    learning.assertBinding(origin, parsed.binding);
    learning.cancel(origin, parsed.id);
  });
  register(ipcChannels.learningPreviewSelection, async (input, learning) => {
    const parsed = previewSelectionInputSchema.parse(input);
    return selectionSchema.parse(await learning.previewSelection(originFor(parsed.binding.scope), parsed));
  });
  register(ipcChannels.learningRecover, async (input, learning) => {
    const parsed = recoveryInputSchema.parse(input);
    const origin = originFor(parsed.binding.scope);
    const provider = runtime.learningProvider();
    await learning.recover(origin, parsed);
    return learningStateSchema.parse(await learning.state(origin, provider));
  });
  service?.onChanged((event) => {
    const parsed = learningChangedSchema.parse(event);
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(ipcChannels.learningChanged, parsed);
  });
}
