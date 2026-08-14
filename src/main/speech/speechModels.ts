import type { SpeechModelId, SpeechModelInfo, SpeechTier } from '../../shared/contracts/ipc';

export interface SpeechModelDefinition extends Omit<SpeechModelInfo, 'installed' | 'downloadedBytes'> {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  /** True for models that support live streaming transcription (committed +
   *  tentative text while speaking). Batch-only models refuse streamStart. */
  readonly streaming: boolean;
  /** Native stream menu for streaming models. Parakeet RNN-T/TDT models use
   *  the buffered menu that batches audio for accuracy and real-time CPU speed.
   *  Omitted = the engine's default stream slot. */
  readonly streamFamily?: { kind: 'parakeet_buffered'; leftMs?: number; chunkMs?: number; rightMs?: number };
  /** Some engines require BCP-47 locales (en-US) while our settings store
   *  short codes (en). Map every supported short code; unmapped codes pass
   *  through unchanged. 'auto' is always passed through when present. */
  readonly languageMap?: Readonly<Record<string, string>>;
}

/**
 * Local voice model catalog. Every entry is GGUF, commit-pinned on Hugging
 * Face under the `handy-computer` org (the transcribe.cpp reference quants —
 * each is WER-verified against its reference implementation), and runs through
 * the bundled `transcribe-cpp` engine on CPU/Metal.
 *
 * WER = LibriSpeech test-clean, per the transcribe.cpp model cards. RTF = how
 * many times faster than real time on an average laptop CPU (AMD Ryzen 7
 * 4750U, from the same cards).
 */
export const speechModels: readonly SpeechModelDefinition[] = [
  {
    id: 'canary-flash',
    tier: 'mini',
    name: 'Mini',
    model: 'Canary 180M Flash',
    description: 'The fastest option: instant on any hardware, with strong accuracy for English dictation.',
    detail: '159 MB · 1.90% WER · English, German, Spanish, French · RTF 21×',
    bytes: 158_704_320,
    streaming: false,
    fileName: 'canary-180m-flash-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/canary-180m-flash-gguf/resolve/b147f9dc52b59f0998e410540a84727bd86457fd/canary-180m-flash-Q5_K_M.gguf',
    sha256: 'a87992d84aea5329fa5d70f2eb440d3ae4fe47bd774875374ec381472d348299',
  },
  {
    id: 'parakeet-unified',
    tier: 'balanced',
    name: 'English Live',
    model: 'Parakeet Unified EN 0.6B',
    description: 'Live English transcription with the best measured accuracy per watt. Built-in punctuation and casing.',
    detail: '541 MB · 1.58% WER · English · live · RTF 7.5×',
    bytes: 540_795_264,
    streaming: true,
    streamFamily: { kind: 'parakeet_buffered' },
    fileName: 'parakeet-unified-en-0.6b-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/7e948f21b7bdbac698d3318db9d350f1096f3b6c/parakeet-unified-en-0.6b-Q5_K_M.gguf',
    sha256: 'f9def6f9b4e83ab7d006df3e1b676dfa1f973a3b6da232a9c99fcaa66bcd2836',
  },
  {
    id: 'nemotron-stream',
    tier: 'balanced',
    name: 'Multilingual Live',
    model: 'Nemotron 3.5 ASR Streaming 0.6B',
    description: 'Live transcription in 28 languages with automatic language detection. Native punctuation and casing.',
    detail: '560 MB · 3.10% WER · 28 languages · live · auto-detect · RTF 7.5×',
    bytes: 559_647_200,
    streaming: true,
    fileName: 'nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/6d44e540bc31b0de1dbe174a3cea87f53a7f22fb/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf',
    sha256: '86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65',
    // Nemotron speaks BCP-47 locales; our settings store short codes.
    languageMap: {
      en: 'en-US', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL',
      de: 'de-DE', tr: 'tr-TR', ru: 'ru-RU', ar: 'ar-SA', hi: 'hi-IN', ja: 'ja-JP',
      ko: 'ko-KR', vi: 'vi-VN', uk: 'uk-UA', pl: 'pl-PL', sv: 'sv-SE', cs: 'cs-CZ',
      no: 'nb-NO', da: 'da-DK', bg: 'bg-BG', fi: 'fi-FI', hr: 'hr-HR', sk: 'sk-SK',
      zh: 'zh-CN', hu: 'hu-HU', ro: 'ro-RO', et: 'et-EE',
    },
  },
  {
    id: 'parakeet-tdt-v3',
    tier: 'balanced',
    name: 'Multilingual',
    model: 'Parakeet TDT 0.6B v3',
    description: 'Very accurate batch transcription across 25 European languages with automatic language detection.',
    detail: '549 MB · 1.92% WER · 25 European languages · auto-detect · RTF 7.5×',
    bytes: 548_946_272,
    streaming: false,
    fileName: 'parakeet-tdt-0.6b-v3-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/85ac09ea12fc4b1112fa76810059364bc6adc9de/parakeet-tdt-0.6b-v3-Q5_K_M.gguf',
    sha256: 'cc722e76adc1a629fc0b2535de879d99b8160d07ad4c0215e2ca7d7ea0ae4b8f',
  },
  {
    id: 'cohere-transcribe',
    tier: 'max',
    name: 'Max Accuracy',
    model: 'Cohere Transcribe 03-2026',
    description: 'The lowest measured error rate available locally, for users who prioritize transcript quality over speed.',
    detail: '1.56 GB · 1.25% WER · 14 languages · slowest',
    bytes: 1_558_162_944,
    streaming: false,
    fileName: 'cohere-transcribe-03-2026-Q4_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/cohere-transcribe-03-2026-gguf/resolve/dfa4adebb64f3076b7b6b90b721275cc069cb421/cohere-transcribe-03-2026-Q4_K_M.gguf',
    sha256: '0ea56826d8bd5d74b7143a4a04e022dc1bb75452cfae49d98b6acb0c1d16a1fb',
  },
  {
    id: 'whisper-turbo',
    tier: 'max',
    name: 'Max Languages',
    model: 'Whisper large-v3-turbo',
    description: 'Broadest language coverage (99 languages) with automatic detection. Needs a GPU for comfortable speed; CPU-only machines should choose Max Accuracy instead.',
    detail: '620 MB · 2.00% WER · 99 languages · auto-detect · needs GPU',
    bytes: 619_628_128,
    streaming: false,
    fileName: 'whisper-large-v3-turbo-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf/resolve/5eaf945c7978e564bae5b28a5b1639dd93c2bfb1/whisper-large-v3-turbo-Q5_K_M.gguf',
    sha256: '977b5db4e004349dffd1ab9caa10ba5aaba3fc3edd3ba72cadb84328a3203e36',
  },
] as const;

export function speechModel(modelId: SpeechModelId): SpeechModelDefinition {
  const model = speechModels.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown speech model: ${modelId}`);
  return model;
}

/** Resolve a settings language for a model definition.
 *  Returns undefined when the call must omit the language so the engine's own
 *  default applies (Nemotron's auto-detect mode); short codes map through
 *  languageMap (Nemotron needs BCP-47 locales like en-US). */
export function resolveModelLanguage(definition: SpeechModelDefinition, language: string | undefined): string | undefined {
  if (!language || language === 'auto') {
    return definition.languageMap ? undefined : 'en';
  }
  return definition.languageMap?.[language] ?? language;
}
