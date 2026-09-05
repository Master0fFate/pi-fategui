# Resource measurements for 0.9.7-beta3

## Method

The baseline is `v0.9.7-beta2` (`3fe050f100f9862a7fc01dc96c0065dd75ac1939`), using Electron 43.4.1 and Pi SDK 0.84.4. The candidate uses Electron 43.6.0 and SDK 0.85.0. Each revision had its own frozen-lockfile dependencies and production renderer build. Both used the same final `scripts/profile-live-renderer.mjs` harness, with an explicit path to that revision's Electron executable.

Local conditions: Windows x64, Node 22.22.2, AMD Ryzen 9 5900X, 12 reported logical CPUs, 34,281,054,208 bytes RAM, 1280 × 720 Electron window. Each mode ran three times in fresh temporary project, Chromium, and Fate data directories. No builds or test suites ran concurrently with these samples. The installed Fate UI and its running task stayed alive, so this was not an otherwise idle machine.

The deterministic workload supplies 600 historical messages, 6,000 assistant deltas, and up to 600 replacement tool-output updates. The viewport stays on historical rows while output streams. Measurements include 500 ms settling, followed by 2,000 ms idle sampling. The harness checks the final output after timing. All samples retained 603 timeline entries, mounted 13 rows, and reported no renderer errors or long tasks.

CDP reports renderer task and script time in milliseconds. These are application-thread work measurements, not whole-machine CPU utilization. Retained heap is measured after garbage collection; working set sums the test application's processes. Values below are medians; MiB means 1,048,576 bytes.

## Before and after

| Mode | Renderer task time, ms | Script time, ms | Retained JS heap, MiB | Process working set, MiB |
| --- | --- | --- | --- | --- |
| Normal | 529.16 → 408.10 | 231.00 → 139.27 | 14.332 → 14.206 | 534.61 → 520.10 |
| Performance | 447.04 → 361.19 | 176.55 → 127.81 | 14.202 → 14.169 | 522.93 → 509.59 |
| Holy sh*t | 374.63 → 344.42 | 155.69 → 119.65 | 14.181 → 14.172 | 502.84 → 508.13 |

Renderer task time decreased by 22.9%, 19.2%, and 8.1% respectively. Retained heap was effectively flat. Holy sh*t's working set increased by about 1%; these samples do not establish a universal memory reduction. The small RAM differences should not be treated as statistically significant.

The reductions come from avoiding repeated Markdown work, bounded provisional-event batching, coalescing known-tool snapshots, removing delayed auto-scroll callbacks and the 60-frame settling loop, and fully disabling transitions in Performance mode rather than shortening them to 0.01 ms. Normal-mode presentation remains unchanged. Performance modes may present provisional output less frequently; completion, errors, queues, provenance, and session boundaries remain immediate.

Preliminary profiles exposed a viewport mismatch caused by delayed auto-scroll and were not used for this comparison. The final controller respects manual scrolling, including late content measurements. Native E2E tests cover that behavior in all three modes.

## Repeating the measurements

Build each revision with `pnpm install --frozen-lockfile` and `pnpm build:e2e`. Copy the candidate's profiler outside the tracked source before checking out the baseline. Run it from each revision's working directory:

```bash
node /path/to/frozen-profile.mjs --runs 3 --mode normal --idle-ms 2000 --out /path/to/results/normal.json
node /path/to/frozen-profile.mjs --runs 3 --mode performance --idle-ms 2000 --out /path/to/results/performance.json
node /path/to/frozen-profile.mjs --runs 3 --mode holy --idle-ms 2000 --out /path/to/results/holy.json
```

The frozen script must remain under a directory that can resolve this project's Playwright dependency. Separate worktrees must have separate dependencies; do not share a `node_modules` link across versions. Local raw evidence is in `.parallax/performance/beta3/frozen-before-*.json`, `validated-after-*.json`, and their CPU profiles. GitHub's Renderer performance profiles workflow performs the same comparison on all four native targets and uploads its reports.

These fixtures exercise main-process IPC, preload validation, stores, and the real renderer, but replace model responses deterministically. They do not measure live provider latency or paid-model rewrite quality. Basic Prompt Optimization's reasoning and cancellation changes have regression coverage; provider-specific timing remains unmeasured.
