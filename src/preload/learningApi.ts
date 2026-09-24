import { emptyInputSchema, ipcChannels } from '../shared/contracts/ipc';
import { cancelLearningInputSchema, captureSchema, generateDraftInputSchema, generationResultSchema, learningChangedSchema, learningMutationSchema, learningStateSchema, previewEvidenceInputSchema, previewSelectionInputSchema, recoveryInputSchema, reviewCaptureInputSchema, selectionSchema, learningStorageSchema, learningStateInputSchema, type LearningApi } from '../shared/contracts/learning';
import { invoke, subscribe, ignoreResult } from './transport';

export const learningApi: LearningApi = {
  getLearningStorage: () => invoke(ipcChannels.learningGetStorage, emptyInputSchema, learningStorageSchema),
  getLearningState: (scope) => invoke(ipcChannels.learningGetState, learningStateInputSchema, learningStateSchema, scope ? { scope } : {}),
  mutateLearning: (input) => invoke(ipcChannels.learningMutate, learningMutationSchema, learningStateSchema, input),
  previewLearningEvidence: (input) => invoke(ipcChannels.learningPreviewEvidence, previewEvidenceInputSchema, captureSchema, input),
  reviewLearningCapture: (input) => invoke(ipcChannels.learningReviewCapture, reviewCaptureInputSchema, captureSchema, input),
  generateLearningDraft: (input) => invoke(ipcChannels.learningGenerateDraft, generateDraftInputSchema, generationResultSchema, input),
  cancelLearning: (input) => invoke(ipcChannels.learningCancel, cancelLearningInputSchema, ignoreResult, input),
  recoverLearning: (input) => invoke(ipcChannels.learningRecover, recoveryInputSchema, learningStateSchema, input),
  previewLearningSelection: (input) => invoke(ipcChannels.learningPreviewSelection, previewSelectionInputSchema, selectionSchema, input),
  onLearningChanged: (listener) => subscribe(ipcChannels.learningChanged, learningChangedSchema, listener, () => undefined),
};
