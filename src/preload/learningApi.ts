import { ipcRenderer } from 'electron';
import { emptyInputSchema, ipcChannels } from '../shared/contracts/ipc';
import { cancelLearningInputSchema, captureSchema, generateDraftInputSchema, generationResultSchema, learningChangedSchema, learningMutationSchema, learningStateSchema, previewEvidenceInputSchema, previewSelectionInputSchema, recoveryInputSchema, reviewCaptureInputSchema, selectionSchema, learningStorageSchema, learningStateInputSchema, type LearningApi, type LearningScope } from '../shared/contracts/learning';

export const learningApi: LearningApi = {
  async getLearningStorage() { return learningStorageSchema.parse(await ipcRenderer.invoke(ipcChannels.learningGetStorage, emptyInputSchema.parse({}))); },
  async getLearningState(scope?: LearningScope) { return learningStateSchema.parse(await ipcRenderer.invoke(ipcChannels.learningGetState, learningStateInputSchema.parse(scope ? { scope } : {}))); },
  async mutateLearning(input) { return learningStateSchema.parse(await ipcRenderer.invoke(ipcChannels.learningMutate, learningMutationSchema.parse(input))); },
  async previewLearningEvidence(input) { return captureSchema.parse(await ipcRenderer.invoke(ipcChannels.learningPreviewEvidence, previewEvidenceInputSchema.parse(input))); },
  async reviewLearningCapture(input) { return captureSchema.parse(await ipcRenderer.invoke(ipcChannels.learningReviewCapture, reviewCaptureInputSchema.parse(input))); },
  async generateLearningDraft(input) { return generationResultSchema.parse(await ipcRenderer.invoke(ipcChannels.learningGenerateDraft, generateDraftInputSchema.parse(input))); },
  async cancelLearning(input) { await ipcRenderer.invoke(ipcChannels.learningCancel, cancelLearningInputSchema.parse(input)); },
  async recoverLearning(input) { return learningStateSchema.parse(await ipcRenderer.invoke(ipcChannels.learningRecover, recoveryInputSchema.parse(input))); },
  async previewLearningSelection(input) { return selectionSchema.parse(await ipcRenderer.invoke(ipcChannels.learningPreviewSelection, previewSelectionInputSchema.parse(input))); },
  onLearningChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = learningChangedSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(ipcChannels.learningChanged, handler);
    return () => { ipcRenderer.removeListener(ipcChannels.learningChanged, handler); };
  },
};
