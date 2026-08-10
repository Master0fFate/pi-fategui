import type { SpeechModelId, SpeechModelInfo } from '../../shared/contracts/ipc';

export interface SpeechModelDefinition extends Omit<SpeechModelInfo, 'installed' | 'downloadedBytes'> {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  /** True for streaming-family models (Parakeet RNN-T/TDT, Moonshine, Voxtral).
   *  These crash on the transcribe.cpp Metal backend on macOS, so SpeechService
   *  routes them to CPU; they also unlock live streaming transcription. Batch
   *  models (Canary, Cohere Transcribe) keep the accelerator and run batch-only. */
  readonly streaming: boolean;
}

export const speechModels: readonly SpeechModelDefinition[] = [
  {
    id: 'mini',
    tier: 'mini',
    name: 'Mini',
    model: 'Canary 180M Flash',
    description: 'A current, highly accurate model that stays exceptionally fast on CPU.',
    detail: '159 MB · 1.90% English test-clean WER · fastest',
    bytes: 158_704_320,
    streaming: false,
    fileName: 'canary-180m-flash-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/canary-180m-flash-gguf/resolve/b147f9dc52b59f0998e410540a84727bd86457fd/canary-180m-flash-Q5_K_M.gguf',
    sha256: 'a87992d84aea5329fa5d70f2eb440d3ae4fe47bd774875374ec381472d348299',
  },
  {
    id: 'balanced',
    tier: 'balanced',
    name: 'Medium',
    model: 'Parakeet Unified EN 0.6B',
    description: 'High-accuracy English transcription with built-in punctuation and capitalization.',
    detail: '541 MB · 1.58% test-clean WER · English',
    bytes: 540_795_264,
    streaming: true,
    fileName: 'parakeet-unified-en-0.6b-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/7e948f21b7bdbac698d3318db9d350f1096f3b6c/parakeet-unified-en-0.6b-Q5_K_M.gguf',
    sha256: 'f9def6f9b4e83ab7d006df3e1b676dfa1f973a3b6da232a9c99fcaa66bcd2836',
  },
  {
    id: 'max',
    tier: 'max',
    name: 'Max',
    model: 'Cohere Transcribe 03-2026',
    description: 'The strongest measured accuracy tier for users who prioritize transcript quality.',
    detail: '1.56 GB · 1.25% English test-clean WER · highest accuracy',
    bytes: 1_558_162_944,
    streaming: false,
    fileName: 'cohere-transcribe-03-2026-Q4_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/cohere-transcribe-03-2026-gguf/resolve/dfa4adebb64f3076b7b6b90b721275cc069cb421/cohere-transcribe-03-2026-Q4_K_M.gguf',
    sha256: '0ea56826d8bd5d74b7143a4a04e022dc1bb75452cfae49d98b6acb0c1d16a1fb',
  },
] as const;

export function speechModel(modelId: SpeechModelId): SpeechModelDefinition {
  const model = speechModels.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown speech model: ${modelId}`);
  return model;
}
