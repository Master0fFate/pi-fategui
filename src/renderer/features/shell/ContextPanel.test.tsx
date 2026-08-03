import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { ContextPanel } from './ContextPanel';

const base: RuntimeState = {
  status: 'ready',
  project: { path: '/workspace/pi-desktop', name: 'pi-desktop', trusted: true },
  sessionId: 'session-1',
  sessionFile: '/sessions/session-1.jsonl',
  streaming: false,
  model: { provider: 'test', id: 'precision', name: 'Precision Model', reasoning: true, contextWindow: 100_000 },
  models: [],
  thinkingLevel: 'high',
  messages: [],
  error: null,
};

const sample = {
  input: 200,
  output: 100,
  cacheRead: 800,
  cacheWrite: 0,
  reasoning: 40,
  totalTokens: 1_100,
  cost: 0.0123,
  timestamp: Date.UTC(2026, 0, 1, 12, 30),
};

describe('ContextPanel', () => {
  it('separates live context, session traffic, cache coverage, and reasoning-subset metrics', () => {
    const runtime: RuntimeState = {
      ...base,
      objective: 'Build exact token telemetry',
      contextUsage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
      tokenTelemetry: {
        session: {
          input: 1_000,
          output: 500,
          cacheRead: 3_000,
          cacheWrite: 0,
          totalTokens: 4_500,
          cost: 0.0789,
          turns: 2,
        },
        latest: sample,
        history: [
          { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: 0.02, timestamp: sample.timestamp - 60_000 },
          sample,
        ],
      },
    };

    const { container } = render(<ContextPanel runtime={runtime} />);

    expect(screen.getByRole('meter', { name: 'Context usage 50.0%' })).toHaveAttribute('aria-valuenow', '50');
    const summary = screen.getByRole('region', { name: 'Session token summary' });
    expect(within(summary).getByText('4.5k')).toBeVisible();
    expect(within(summary).getByText('75.0%')).toBeVisible();
    expect(within(summary).getByText('$0.08')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Stacked token traffic for the 2 most recent responses on the active branch' })).toBeVisible();
    expect(screen.getByText('included in output')).toBeVisible();
    expect(screen.getByText('Build exact token telemetry')).toBeVisible();
    expect(container.querySelectorAll('.token-chart-cache-read')).toHaveLength(2);
  });

  it('keeps unavailable and first-response states honest', () => {
    render(<ContextPanel runtime={{ ...base, project: null, model: null }} />);

    expect(screen.getByRole('meter', { name: 'Context usage unavailable until the next response' })).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('Awaiting response')).toBeVisible();
    expect(screen.getByText('Traffic appears after Pi completes a response.')).toBeVisible();
    expect(screen.getByText('Token totals appear after the first completed response.')).toBeVisible();
    expect(screen.getByText('Project trust begins after selection')).toBeVisible();
  });
});
