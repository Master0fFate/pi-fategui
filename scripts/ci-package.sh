#!/usr/bin/env bash

set -euo pipefail

PACKAGED_SMOKE_TIMEOUT_MS="${PACKAGED_SMOKE_TIMEOUT_MS:-120000}"
ELECTRON_BUILDER_LOG_LEVEL="${ELECTRON_BUILDER_LOG_LEVEL:-debug}"
CI_DEBUG_PATTERNS="${DEBUG:-electron-builder:*}"

export PACKAGED_SMOKE_TIMEOUT_MS
export ELECTRON_BUILDER_LOG_LEVEL
export DEBUG="$CI_DEBUG_PATTERNS"
export CI="${CI:-true}"

echo "Node version: $(node -v)"
echo "pnpm version: $(pnpm -v)"
echo "Runner OS: ${RUNNER_OS:-unknown}"
echo "Runner arch: ${RUNNER_ARCH:-unknown}"
echo "Run user: ${USER:-unknown}"
echo "Working directory: $(pwd)"
echo "Smoke timeout (ms): ${PACKAGED_SMOKE_TIMEOUT_MS}"
echo "Electron Builder log level: ${ELECTRON_BUILDER_LOG_LEVEL}"
echo "Debug patterns: ${CI_DEBUG_PATTERNS}"

for attempt in 1 2 3; do
  log_file="release-package-attempt-${attempt}.log"
  echo "=== Package and smoke attempt ${attempt} ==="
  rm -f "$log_file"

  set +e
  pnpm package 2>&1 | tee "$log_file"
  status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -eq 0 ]; then
    echo "Package and smoke attempt ${attempt} succeeded"
    exit 0
  fi

  echo "::group::Package attempt ${attempt} diagnostics"
  echo "Package and smoke failed with code ${status}"

  echo "Tail of attempt log:"
  tail -n 120 "$log_file" || true

  echo
  echo "Release artifacts snapshot:"
  if [ -d release ]; then
    find release -maxdepth 3 -type f -print | head -n 120 || true
  else
    echo "release directory not found"
  fi

  echo
  echo "Recent npm logs:"
  if [ -d "$HOME/.npm/_logs" ]; then
    find "$HOME/.npm/_logs" -type f -name '*.log' -print | sort -r | head -n 5 | while IFS= read -r debug_file; do
      echo "--- ${debug_file} ---"
      tail -n 80 "$debug_file" || true
    done
  else
    echo "No npm logs found at $HOME/.npm/_logs"
  fi

  echo
  echo "Recent pnpm logs:"
  if [ -d "$HOME/.pnpm-store/_logs" ]; then
    find "$HOME/.pnpm-store/_logs" -type f -name '*.log' -print | sort -r | head -n 5 | while IFS= read -r debug_file; do
      echo "--- ${debug_file} ---"
      tail -n 80 "$debug_file" || true
    done
  else
    echo "No pnpm logs found at $HOME/.pnpm-store/_logs"
  fi

  echo "::endgroup::"

  if [ "$attempt" -eq 3 ]; then
    echo "Unpacked package attempt ${attempt} failed; no retries remain."
    exit "$status"
  fi

  echo "Unpacked package attempt ${attempt} failed; retrying in 15 seconds."
  sleep 15
done
