# Planner Omega Plan: Fate GUI Speech — Model Catalog Upgrade + Handy Performance Port

## 1. Mission and Definition of Done
- **Goal:** (a) Replace/extend the 3-tier speech catalog with the best verified local GGUF models (multi-entry tiers, streaming preferred, non-streaming allowed when accuracy/coverage wins), and (b) port Handy's CPU-efficiency techniques so live dictation stops overloading the CPU while keeping or improving accuracy.
- **Done means:** 6-model catalog (1 mini / 3 balanced / 2 max) with commit-pinned URLs + SHA-256, downloadable and transcribable through the existing engine; silence-gated streaming; opt-in stop-time accuracy pass; existing user downloads keep working (no re-download); full test suite + typecheck pass; spike script proves each new model loads, transcribes, and streams with `transcribe-cpp@0.1.3`.
- **Non-goals:** No cloud APIs. No new native dependencies. No GPU/Vulkan default changes (Vulkan stays CPU-forced; revisit later). No diarization/multitalker. No UI redesign beyond grouped model picker + one toggle.
- **Key constraints:** Must not break current transcription. Local-only. GGUF from `handy-computer` org (verified with transcribe.cpp). Batch tests at the end, not per edit.

## 2. Grounding and Assumptions
| Item | Status | Evidence | Impact |
|---|---|---|---|
| Engine supports all candidate families | Confirmed | transcribe.cpp README: 16 families incl. Nemotron 3.5 ASR, TDT v3, whisper-turbo; Node binding 0.1.3 = latest npm | Catalog feasibility |
| Verified WER/RTF per quant | Confirmed | HF model cards (`cardData.transcribe_cpp`), transcribe.cpp docs | Tier assignment |
| Nemotron GGUF arch = `parakeet` (loads via existing loader) | Confirmed | HF card `gguf.architecture: "parakeet"` | No loader change |
| Nemotron streams via default slot or `parakeet_buffered` in Node binding | Assumed (spike will prove) | Binding types lack `nemotron` family kind | Task 8 spike gates Task 3 |
| Nemotron needs BCP-47 language (`en-US`), supports `auto` | Confirmed | transcribe.cpp nemotron doc | Language mapping task |
| Whisper-turbo is CPU-slow (RTF 0.8–1.8 CPU, 46× Metal, 3.4× Vulkan) | Confirmed | HF card RTF table | Max-tier entry carries warning; CPU-forced on Vulkan makes it slow on Windows → label honestly |
| Handy's low CPU comes from: VAD silence filtering + no default full re-run + (their own) transcribe-rs engine | Confirmed (README: Silero VAD, optional post-process; transcribe-rs for Parakeet) | We port the first two; engine swap impossible without new dep | Scope of perf port |
| Existing user model files stay valid | Confirmed | filenames unchanged for kept models; `isInstalled` checks by fileName+sha | No re-download |
| Old settings store `modelId: 'mini'|'balanced'|'max'` | Confirmed | `speechModelIdSchema` enum = tier names | Migration mapping required |

## 3. Recommended Strategy
Port the two pipeline techniques that make Handy calm (silence gate + opt-in refinement), cap threads at 4, and expand the catalog with the strongest verified GGUFs per tier. Nemotron multilingual streaming is the headline addition; TDT v3 gives multilingual batch at Parakeet speed; whisper-turbo gives 99-language coverage for the max tier with an explicit speed warning.

**Chosen catalog (all Q5_K_M except Cohere Q4_K_M as today):**
| Tier | id | Model | WER (test-clean) | Langs | Stream | Size |
|---|---|---|---|---|---|---|
| mini | `canary-flash` | Canary 180M Flash (keep) | 1.90% | 4 + translate | ✗ | 159 MB |
| balanced | `parakeet-unified` | Parakeet Unified EN 0.6B (keep) | 1.58% | en | ✓ | 541 MB |
| balanced | `nemotron-stream` | Nemotron 3.5 ASR Streaming 0.6B (new) | 3.10% | 28 + auto-detect | ✓ | 560 MB |
| balanced | `parakeet-tdt-v3` | Parakeet TDT 0.6B v3 (new) | 1.92% | 25 EU + auto-detect | ✗ | 549 MB |
| max | `cohere-transcribe` | Cohere Transcribe 03-2026 (keep) | 1.25% | 14 | ✗ | 1.56 GB |
| max | `whisper-turbo` | Whisper large-v3-turbo (new) | 2.00% | 99 + auto-detect | ✗ | 620 MB |

**Alternatives rejected:** Voxtral Realtime (3.3 GB download — too heavy for balanced), Whisper Medium (worse WER than turbo, slower), Moonshine (WER too high for dictation), canary-1b-flash (no live, no gain over balanced set), tdt-v2 (subsumed by unified for EN).

## 4. Plan Model
- Current state: 3-entry catalog keyed by tier-ids; continuous decode incl. silence; mandatory full re-run at stop; up to 8 threads.
- Desired state: 6-entry catalog keyed by model ids; silence-gated feeds; opt-in refinement; 4-thread cap; grouped picker; stored settings migrated.
- Allowed actions: edit catalog/schema/service/renderer/UI; add tests; add spike script; download spike models to temp.
- Preconditions: research complete (this doc); node_modules has transcribe-cpp 0.1.3.
- Effects: catalog downloads verified; IPC contract extended compatibly (new optional fields only).
- Evidence required: spike output per new model; full vitest+typecheck green.
- Replan triggers: spike shows nemotron cannot stream with binding 0.1.3 → drop to batch or replace with unified-multilingual fallback and note; tests reveal schema consumers beyond known list.

## 5. Execution Roadmap

### Phase A — Contracts + catalog
- [x] A1. Split `speechTierSchema` from `speechModelIdSchema` (6 model ids); migrate stored ids (`mini→canary-flash`, `balanced→parakeet-unified`, `max→cohere-transcribe`); `speechStatusSchema.models` length(3) → min(1).max(12); `speechModelInfoSchema.tier` uses tier schema. Acceptance: typecheck clean; migration test parses legacy settings.
- [x] A2. Rewrite `speechModels.ts`: 6 definitions, commit-pinned URLs, exact bytes + sha256 (from HF cards/Handy catalog), internal fields `streamFamily` + `languageMap` (nemotron BCP-47), honest `detail` strings (WER · langs · live badge · GPU note for whisper-turbo). Acceptance: new `speechModels.test.ts` integrity test passes (unique ids/fileNames, pinned urls, positive bytes, tier coverage).

### Phase B — Service pipeline
- [x] B1. `SpeechService`: per-definition stream family (unified → `parakeet_buffered`; nemotron → spike-chosen menu); language mapping for nemotron (`auto` passes through, `en→en-US` etc.); `CPU_THREADS` cap 8→4; `streamStart` accepts optional `refine` (default false) gating `refineFinalStreamText`. Acceptance: updated unit tests incl. nemotron language mapping + refine skip.
- [x] B2. IPC/preload/api: `speechStreamStartInputSchema` gains `refine`; preload `startSpeechStream(modelId, language?, refine?)`. Acceptance: api tests pass; Composer passes `speech.finalAccuracyPass`.

### Phase C — Handy perf port (renderer)
- [x] C1. Silence gate in `voiceStream.ts`: exported pure `SpeechGate` (RMS threshold 0.006, 800 ms hangover) used by `VoiceStreamFeedQueue.push` — silence is not fed to native; speech bursts always forwarded with tail. Acceptance: new unit tests (silence dropped, speech passes, hangover tail kept, gate reopens).
- [x] C2. Settings: `speech.finalAccuracyPass` (boolean, default false) + Settings toggle beside "Live transcription" (visible only when live-capable model selected). Acceptance: schema test + UI renders toggle.

### Phase D — UI
- [x] D1. SettingsDialog: model list grouped by tier (Fastest / Balanced / Highest accuracy) with per-model download/remove as today; badge "· live" for streaming models. Acceptance: typecheck; grouped rendering logic covered by existing status polling.

### Phase E — Spike + batch verification
- [x] E1. `scripts/verify-speech-models.mjs`: for each new model (tdt-v3, nemotron, whisper-turbo): download pinned file to temp, sha-verify, load via transcribe-cpp, batch-run synthetic PCM, and for nemotron test stream via default slot + `parakeet_buffered` with `en-US` and `auto`; print device + text. Acceptance: all three load and produce output; nemotron menu choice recorded and applied in B1.
- [x] E2. Batch gate: `pnpm typecheck` + `pnpm test` full suite green; fix all fallout (registerIpc/api/SettingsDialog tests). Acceptance: 0 failures.

## 6. Assumption and Experiment Map
| Assumption | Category | Evidence | Test | Decision rule |
|---|---|---|---|---|
| Nemotron streams via default/parakeet_buffered menu in 0.1.3 | Feasibility | Medium | E1 spike | If both fail → mark batch-only or drop entry |
| `en` accepted or needs `en-US` for nemotron | Feasibility | Medium | E1 spike | Map if needed (languageMap) |
| Silence gate threshold 0.006 RMS works for real mics | Viability | Low | User validation post-merge | Tune constant if words clipped |
| Whisper-turbo acceptable on user machines | Desirability | Medium | Label warning only | Keep entry; CPU-only users pick Cohere |
| 4 threads calm CPU without hurting RTF | Adaptability | Medium | User validation | Constant, easy to retune |

## 7. Verification Plan
| Check | Method | When | Pass criterion |
|---|---|---|---|
| Catalog integrity | unit test | A2 | 6 entries, pinned, unique |
| Migration | unit test | A1 | legacy ids parse to mapped ids |
| Pipeline behavior | vitest suite | E2 | all green |
| Real engine compat | spike script E1 | before E2 | 3 models load + transcribe |
| No regression for current users | files unchanged + tests | E2 | kept models' files/ids resolve |

## 8. Risk Register
| Risk | Trigger | Impact | Mitigation | Fallback |
|---|---|---|---|---|
| Nemotron stream menu unsupported | E1 fails both menus | balanced entry broken | Spike before shipping entry | Ship tdt-v3 only; note nemotron for engine update |
| Stored settings parse fail | A1 miss a consumer | speech resets to defaults | Migration preprocess + suite grep | Accept reset (defaults are sane) |
| Silence gate clips speech | threshold too high | lost words | Conservative 0.006 + 800 ms tail | Lower threshold / lengthen hangover |
| Whisper-turbo slow on CPU boxes | users without GPU | bad max-tier UX | detail warning | Users choose Cohere |
| Large spike downloads fail | network | E1 blocked | Resume-capable script (Range) | Ship with unit tests only + mark spike TODO |

## 9. Immediate Next Actions
- [ ] A1 contracts (acceptance: typecheck + migration test)
- [ ] A2 catalog + integrity test
- [ ] B1/B2 service + IPC
- [ ] C1/C2 gate + setting
- [ ] D1 UI
- [ ] E1 spike, apply findings
- [ ] E2 full batch gate

## 10. Plan Control
- Version 1.0. Ticks only after acceptance check passes. Deviations logged here. Replan trigger: E1 nemotron failure → revise catalog table (Section 3) before proceeding to E2.

## Plan Change Log
- v1.0 → v1.1 (execution complete): Spike findings applied — Nemotron streams via the DEFAULT slot (rejects parakeet_buffered; the literal "auto" tag is rejected, so auto omits the language key for engine detection; explicit codes map to BCP-47). TDT v3 verified at CPU RTF 8.0x. Whisper-turbo verified on CPU at RTF 0.2x (GPU warning labels kept; Vulkan load hangs on RTX-class Windows — CPU-forcing policy validated and documented in code). Batch gate: 143 files / 1327 tests green, typecheck clean.
