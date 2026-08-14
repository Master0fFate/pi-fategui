/**
 * Spike: prove every new catalog model works with the bundled transcribe-cpp
 * binding before shipping it. Downloads the exact pinned GGUF, verifies the
 * SHA-256, loads it, runs batch transcription over synthetic speech-shaped PCM,
 * and for streaming models exercises the live path (default slot and the
 * Parakeet buffered menu) with language handling.
 *
 * Usage: node scripts/verify-speech-models.mjs [modelId ...]
 * Default: all three new models. Files go to a temp dir and are removed.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Self-contained definitions (mirrors src/main/speech/speechModels.ts) so this
// runs under plain node without a TS loader.
const definitions = [
  {
    id: 'nemotron-stream',
    bytes: 559_647_200,
    fileName: 'nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/6d44e540bc31b0de1dbe174a3cea87f53a7f22fb/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf',
    sha256: '86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65',
    streaming: true,
    languageMap: { en: 'en-US' },
  },
  {
    id: 'parakeet-tdt-v3',
    bytes: 548_946_272,
    fileName: 'parakeet-tdt-0.6b-v3-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/85ac09ea12fc4b1112fa76810059364bc6adc9de/parakeet-tdt-0.6b-v3-Q5_K_M.gguf',
    sha256: 'cc722e76adc1a629fc0b2535de879d99b8160d07ad4c0215e2ca7d7ea0ae4b8f',
    streaming: false,
  },
  {
    id: 'whisper-turbo',
    bytes: 619_628_128,
    fileName: 'whisper-large-v3-turbo-Q5_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf/resolve/5eaf945c7978e564bae5b28a5b1639dd93c2bfb1/whisper-large-v3-turbo-Q5_K_M.gguf',
    sha256: '977b5db4e004349dffd1ab9caa10ba5aaba3fc3edd3ba72cadb84328a3203e36',
    streaming: false,
  },
];
const speechModels = definitions;
const resolveModelLanguage = (definition, language) =>
  !language ? undefined : language === 'auto' ? (definition.languageMap ? 'auto' : 'en') : (definition.languageMap?.[language] ?? language);
const newIds = ['nemotron-stream', 'parakeet-tdt-v3', 'whisper-turbo'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : newIds;

/** Synthetic "speech": 3 s of tone bursts with gaps — never silent overall. */
function speechPcm(seconds = 3) {
  const samples = 16_000 * seconds;
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / 16_000;
    const voiced = (t % 0.8) < 0.6;
    pcm[i] = voiced ? 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) : 0;
  }
  return pcm;
}

async function download(url, target, expectedBytes, expectedSha) {
  const { createReadStream } = await import('node:fs');
  let attempt = 0;
  let have = await stat(target).then((s) => s.size, () => 0);
  let hash = createHash('sha256');
  while (have < expectedBytes && attempt < 6) {
    attempt += 1;
    // A fresh digest per attempt: hash the full on-disk prefix, then the bytes
    // this attempt appends. Survives any number of interrupted resumes.
    hash = createHash('sha256');
    if (have > 0) {
      await pipeline(createReadStream(target), async function* (source) { for await (const chunk of source) { hash.update(chunk); } });
    }
    const resume = have > 0;
    const response = await fetch(url, resume ? { headers: { Range: `bytes=${have}-` } } : {});
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
    const appending = resume && response.status === 206;
    if (!appending && resume) have = 0; // server ignored the range: start over
    try {
      await pipeline(
        Readable.fromWeb(appending && have > 0 ? response.body : response.body),
        async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk; } },
        createWriteStream(target, appending ? { flags: 'a' } : {}),
      );
    } catch (error) {
      console.error(`\n  download interrupted (attempt ${attempt}): ${error.cause?.code ?? error.message}; resuming…`);
    }
    const size = await stat(target).then((s) => s.size, () => 0);
    if (size <= have && size !== expectedBytes) throw new Error('download made no progress; giving up');
    have = size;
  }
  if (have !== expectedBytes) throw new Error(`incomplete download: ${have}/${expectedBytes}`);
  if (attempt === 0) {
    // File was already complete: hash it now.
    await pipeline(createReadStream(target), async function* (source) { for await (const chunk of source) { hash.update(chunk); } });
  }
  const digest = hash.digest('hex');
  if (digest !== expectedSha) throw new Error(`sha256 mismatch for ${target}: ${digest} — delete and retry`);
}

async function main() {
  const { getAvailableBackends, TranscribeModel } = await import('transcribe-cpp');
  // Persistent cache so re-runs skip the ~560 MB downloads.
  const tmp = path.join(process.cwd(), 'node_modules', '.cache', 'speech-spike');
  await import('node:fs/promises').then((fs) => fs.mkdir(tmp, { recursive: true }));
  let failures = 0;
  try {
    console.log('Backends:', getAvailableBackends().map((b) => `${b.kind}(${b.deviceType})`).join(', '));
    for (const id of targets) {
      const definition = speechModels.find((model) => model.id === id);
      if (!definition) throw new Error(`unknown model ${id}`);
      const file = path.join(tmp, definition.fileName);
      process.stdout.write(`[${id}] downloading ${definition.bytes.toLocaleString()} bytes… `);
      await download(definition.url, file, definition.bytes, definition.sha256);
      console.log('ok');

      const model = await TranscribeModel.load(file, { backend: 'cpu' });
      console.log(`[${id}] loaded arch=${model.arch} backend=${model.backend} device=${model.device.name}`);

      const session = model.createSession({ nThreads: 4 });
      const pcm = speechPcm(3);
      const started = performance.now();
      const result = await session.run(pcm, { language: resolveModelLanguage(definition, 'en') ?? 'en', timestamps: 'none' });
      const batchMs = performance.now() - started;
      console.log(`[${id}] batch ok in ${Math.round(batchMs)} ms (RTF ${(3_000 / batchMs).toFixed(1)}x) text="${(result.text || '').trim().slice(0, 80)}" lang=${result.language}`);

      if (definition.streaming) {
        const streamLanguage = resolveModelLanguage(definition, 'en') ?? 'en';
        // Test exactly what the app sends: the model's configured family menu,
        // or the default slot when none is configured.
        const variants = [definition.streamFamily];
        for (const variant of variants) {
          const label = variant ? variant.kind : 'default-slot';
          try {
            const stream = await session.stream({ language: streamLanguage, timestamps: 'none', commitPolicy: 'stable_prefix', ...(variant ? { family: variant } : {}) });
            const chunk = speechPcm(2);
            await stream.feed(chunk);
            await stream.finalize();
            console.log(`[${id}] stream[${label}] ok lang=${streamLanguage} committed="${(stream.text.committed || '').trim().slice(0, 80)}"`);
            stream.reset();
          } catch (error) {
            failures += 1;
            console.error(`[${id}] stream[${label}] FAILED: ${error.message}`);
          }
        }
        // Language handling: 'auto' pass-through and BCP-47 mapping.
        console.log(`[${id}] language en->${resolveModelLanguage(definition, 'en')} auto->${resolveModelLanguage(definition, 'auto')}`);
      }
      session.dispose();
      model.dispose();
    }
  } finally {
    // Cached on purpose: re-runs reuse the files.
  }
  if (failures) { console.error(`${failures} streaming variant failure(s)`); process.exit(2); }
  console.log('ALL OK');
}

main().catch((error) => { console.error(error); process.exit(1); });
