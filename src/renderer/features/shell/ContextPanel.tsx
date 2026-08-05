import {
  Activity,
  BarChart3,
  BrainCircuit,
  CircleDollarSign,
  Database,
  Gauge,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import type { RuntimeState, TokenMetrics, TokenUsageSample } from '../../../shared/contracts/ipc';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { InspectorSectionHeading } from './InspectorPrimitives';

type ContextPanelRuntime = Pick<
  RuntimeState,
  'contextUsage' | 'model' | 'objective' | 'project' | 'streaming' | 'thinkingLevel' | 'tokenTelemetry'
>;

const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const timeFormatter = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

function formatTokens(value: number): string {
  if (value < 1_000) return integerFormatter.format(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
  return `${(value / 1_000_000_000).toFixed(1)}b`;
}

function exactTokens(value: number): string {
  return `${integerFormatter.format(value)} tokens`;
}

function formatCost(value: number): string {
  if (value === 0) return '—';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${integerFormatter.format(value)}`;
}

function formatGoalDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function inputTokens(usage: Pick<TokenMetrics, 'input' | 'cacheRead' | 'cacheWrite'>): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function cacheCoverage(usage: Pick<TokenMetrics, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const total = inputTokens(usage);
  return total === 0 ? null : usage.cacheRead / total * 100;
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  if (value >= 99.95) return '100%';
  if (value < 0.05) return '0%';
  return `${value.toFixed(1)}%`;
}

function boundedPercent(value: number | null | undefined): number {
  return Math.min(100, Math.max(0, value ?? 0));
}

function trafficTotal(usage: Pick<TokenMetrics, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function usageTitle(sample: TokenUsageSample, index: number): string {
  return [
    `Response ${index + 1} · ${timeFormatter.format(sample.timestamp)}`,
    `Uncached input ${integerFormatter.format(sample.input)}`,
    `Cache read ${integerFormatter.format(sample.cacheRead)}`,
    `Cache write ${integerFormatter.format(sample.cacheWrite)}`,
    `Output ${integerFormatter.format(sample.output)}`,
  ].join('\n');
}

const TokenHistoryChart = memo(function TokenHistoryChart({ history }: { history: TokenUsageSample[] }) {
  if (history.length === 0) {
    return (
      <div className="token-chart-empty">
        <BarChart3 size={18} />
        <span>Traffic appears after Pi completes a response.</span>
      </div>
    );
  }

  const width = 360;
  const plotHeight = 106;
  const baseline = 112;
  const maximum = Math.max(1, ...history.map(trafficTotal));
  const slot = width / history.length;
  const gap = slot > 8 ? 2 : slot > 3 ? 1 : 0.45;
  const barWidth = Math.max(0.8, slot - gap);
  const hasCacheEvents = history.some((sample) => sample.cacheRead > 0 || sample.cacheWrite > 0);
  const coveragePoints = history.map((sample, index) => {
    const coverage = cacheCoverage(sample) ?? 0;
    return `${index * slot + slot / 2},${baseline - coverage / 100 * plotHeight}`;
  }).join(' ');
  const first = history[0]!;
  const last = history[history.length - 1]!;

  return (
    <figure className="token-chart">
      <div className="token-chart-scale" aria-hidden="true"><span>{formatTokens(maximum)}</span><span>0</span></div>
      {hasCacheEvents ? <div className="token-chart-coverage-scale" aria-hidden="true"><span>100%</span><span>0%</span></div> : null}
      <svg
        viewBox={`0 0 ${width} 118`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Stacked token traffic for the ${history.length} most recent responses on the active branch`}
      >
        <line className="token-chart-grid" x1="0" y1="6" x2={width} y2="6" />
        <line className="token-chart-grid" x1="0" y1="59" x2={width} y2="59" />
        <line className="token-chart-baseline" x1="0" y1={baseline} x2={width} y2={baseline} />
        {history.map((sample, index) => {
          const x = index * slot + gap / 2;
          let y = baseline;
          const segments = [
            { key: 'output', value: sample.output },
            { key: 'input', value: sample.input },
            { key: 'cache-read', value: sample.cacheRead },
            { key: 'cache-write', value: sample.cacheWrite },
          ] as const;
          return (
            <g key={`${sample.timestamp}-${index}`}>
              <title>{usageTitle(sample, index)}</title>
              {segments.map((segment) => {
                const height = segment.value / maximum * plotHeight;
                y -= height;
                return <rect key={segment.key} className={`token-chart-${segment.key}`} x={x} y={y} width={barWidth} height={Math.max(0, height)} rx={barWidth > 3 ? 0.8 : 0} />;
              })}
            </g>
          );
        })}
        {hasCacheEvents ? <polyline className="token-chart-coverage" points={coveragePoints} /> : null}
      </svg>
      <figcaption>
        <span>{timeFormatter.format(first.timestamp)}</span>
        <span>{history.length} {history.length === 1 ? 'response' : 'responses'}</span>
        <span>{timeFormatter.format(last.timestamp)}</span>
      </figcaption>
    </figure>
  );
}, (previous, next) => {
  if (previous.history.length !== next.history.length) return false;
  const previousLatest = previous.history.at(-1);
  const nextLatest = next.history.at(-1);
  return previousLatest?.timestamp === nextLatest?.timestamp
    && previousLatest?.totalTokens === nextLatest?.totalTokens
    && previousLatest?.cacheRead === nextLatest?.cacheRead
    && previousLatest?.cacheWrite === nextLatest?.cacheWrite;
});

function TrafficLegend({ hasCacheEvents }: { hasCacheEvents: boolean }) {
  return (
    <div className="token-legend" aria-label="Chart legend">
      <span><i data-kind="input" />Uncached</span>
      <span><i data-kind="cache-read" />Cache read</span>
      <span><i data-kind="cache-write" />Cache write</span>
      <span><i data-kind="output" />Output</span>
      {hasCacheEvents ? <span><i data-kind="coverage" />Cache coverage</span> : <em>No cache events reported</em>}
    </div>
  );
}

function UsageComposition({ usage }: { usage: TokenMetrics }) {
  const total = Math.max(1, trafficTotal(usage));
  const parts = [
    { key: 'input', value: usage.input, label: 'Uncached input' },
    { key: 'cache-read', value: usage.cacheRead, label: 'Cache read' },
    { key: 'cache-write', value: usage.cacheWrite, label: 'Cache write' },
    { key: 'output', value: usage.output, label: 'Output' },
  ] as const;
  return (
    <div className="usage-composition">
      <div className="usage-composition-bar" aria-label="Session token composition">
        {parts.map((part) => <i key={part.key} data-kind={part.key} style={{ width: `${part.value / total * 100}%` }} />)}
      </div>
      <dl className="token-ledger">
        {parts.map((part) => (
          <div key={part.key}>
            <dt><i data-kind={part.key} />{part.label}</dt>
            <dd title={exactTokens(part.value)}>{formatTokens(part.value)}</dd>
          </div>
        ))}
        {usage.reasoning !== undefined ? (
          <div className="token-ledger-secondary">
            <dt><BrainCircuit size={11} />Reasoning <small>included in output</small></dt>
            <dd title={exactTokens(usage.reasoning)}>{formatTokens(usage.reasoning)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function RuntimeFacts({ runtime }: { runtime: ContextPanelRuntime }) {
  return (
    <section className="context-runtime">
      <InspectorSectionHeading icon={Database} title="Runtime" />
      <dl>
        <div><dt>Model</dt><dd>{runtime.model?.name ?? 'Unavailable'}</dd></div>
        <div><dt>Thinking</dt><dd>{runtime.thinkingLevel}</dd></div>
        <div><dt>Project</dt><dd>{runtime.project?.name ?? 'Not selected'}</dd></div>
        <div><dt>Objective</dt><dd>{runtime.objective || 'No active objective'}</dd></div>
      </dl>
      <div className="context-trust" data-trusted={runtime.project?.trusted === true}>
        <ShieldCheck size={14} />
        <span>{runtime.project?.trusted ? `Trusted workspace · ${runtime.project.path}` : 'Project trust begins after selection'}</span>
      </div>
    </section>
  );
}

export function ContextPanel({ runtime }: { runtime: ContextPanelRuntime }) {
  const goal = useGoalMaxStore((state) => state.goal);
  const setGoalEditorOpen = useUiStore((state) => state.setGoalEditorOpen);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!goal || goal.status === 'completed' || goal.status === 'cancelled') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goal?.id, goal?.status]);
  const context = runtime.contextUsage;
  const telemetry = runtime.tokenTelemetry;
  const session = telemetry?.session;
  const latest = telemetry?.latest;
  const contextPercent = context?.percent ?? null;
  const pressure = contextPercent === null ? 'unknown' : contextPercent >= 85 ? 'critical' : contextPercent >= 65 ? 'warning' : 'nominal';
  const remaining = context?.tokens === null || context?.tokens === undefined
    ? null
    : Math.max(0, context.contextWindow - context.tokens);
  const coverage = session ? cacheCoverage(session) : null;
  const hasCacheEvents = telemetry?.history.some((sample) => sample.cacheRead > 0 || sample.cacheWrite > 0) ?? false;

  return (
    <div className="context-dashboard">
      <section className="context-capacity" data-pressure={pressure}>
        <div className="context-capacity-heading">
          <div>
            <span><Gauge size={14} />Live context</span>
            <strong>{contextPercent === null ? 'Awaiting response' : `${formatPercent(contextPercent)} used`}</strong>
          </div>
          <span className="context-live-state" data-streaming={runtime.streaming}>
            <i />{runtime.streaming ? 'Updating' : 'Pi estimate'}
          </span>
        </div>
        <div
          className="context-capacity-track"
          role="meter"
          aria-label={contextPercent === null ? 'Context usage unavailable until the next response' : `Context usage ${formatPercent(contextPercent)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(contextPercent === null ? {} : { 'aria-valuenow': boundedPercent(contextPercent) })}
        >
          <i style={{ width: `${boundedPercent(contextPercent)}%` }} />
        </div>
        <div className="context-capacity-scale">
          <span>{context?.tokens == null ? 'Usage unavailable' : `${formatTokens(context.tokens)} active`}</span>
          <span>{context ? `${remaining === null ? '—' : formatTokens(remaining)} free · ${formatTokens(context.contextWindow)} window` : 'No model context'}</span>
        </div>
      </section>

      <section className="context-summary-strip" aria-label="Session token summary">
        <div>
          <span>Session traffic</span>
          <strong title={session ? exactTokens(session.totalTokens) : undefined}>{session ? formatTokens(session.totalTokens) : '—'}</strong>
          <small>{session ? `${session.turns} ${session.turns === 1 ? 'response' : 'responses'}` : 'No usage yet'}</small>
        </div>
        <div>
          <span>Cache coverage</span>
          <strong>{formatPercent(coverage)}</strong>
          <small>provider-reported input</small>
        </div>
        <div>
          <span>Session cost</span>
          <strong>{session ? formatCost(session.cost) : '—'}</strong>
          <small>{session?.cost ? 'estimated from model rates' : 'pricing unavailable'}</small>
        </div>
      </section>

      {goal ? (
        <section className="context-goal-budget">
          <InspectorSectionHeading icon={Target} title="Goal budget" detail={goal.budget.source === 'user-explicit' ? 'User-set limits' : goal.budget.source === 'system-hard-limit' ? 'System policy' : 'No explicit limit'} />
          <dl>
            <div><dt>Tokens</dt><dd>{formatTokens(goal.tokensUsed)} / {goal.budget.tokenLimit === null ? 'none' : formatTokens(goal.budget.tokenLimit)}</dd></div>
            <div><dt>Time</dt><dd>{formatGoalDuration(goal.elapsedMs + (goal.startedAt && goal.status !== 'completed' && goal.status !== 'cancelled' ? Math.max(0, now - goal.updatedAt) : 0))} / {goal.budget.timeLimitMs === null ? 'none' : formatGoalDuration(goal.budget.timeLimitMs)}</dd></div>
            <div><dt>Source</dt><dd>{goal.budget.source ?? 'none'}</dd></div>
            <div><dt>Verification</dt><dd>{goal.verificationLevel}</dd></div>
            <div><dt>Agents</dt><dd>{goal.agentStrategy}</dd></div>
          </dl>
          <button type="button" onClick={() => setGoalEditorOpen(true)}>Edit limits</button>
        </section>
      ) : null}

      <section className="context-traffic">
        <InspectorSectionHeading
          icon={Activity}
          title="Token traffic"
          detail={telemetry?.history.length ? `Active branch · latest ${telemetry.history.length}` : 'Active branch'}
        />
        <TokenHistoryChart history={telemetry?.history ?? []} />
        <TrafficLegend hasCacheEvents={hasCacheEvents} />
      </section>

      <section className="context-breakdown">
        <InspectorSectionHeading icon={BarChart3} title="Session ledger" detail="All billed session work" />
        {session ? <UsageComposition usage={session} /> : <div className="context-inline-empty">Token totals appear after the first completed response.</div>}
      </section>

      <section className="context-latest">
        <InspectorSectionHeading
          icon={BrainCircuit}
          title="Latest response"
          detail={latest ? timeFormatter.format(latest.timestamp) : 'No response yet'}
        />
        {latest ? (
          <>
            <div className="latest-response-summary">
              <div><span>Total</span><strong title={exactTokens(latest.totalTokens)}>{formatTokens(latest.totalTokens)}</strong></div>
              <div><span>Input</span><strong title={exactTokens(inputTokens(latest))}>{formatTokens(inputTokens(latest))}</strong></div>
              <div><span>Output</span><strong title={exactTokens(latest.output)}>{formatTokens(latest.output)}</strong></div>
              <div><span>Cached</span><strong>{formatPercent(cacheCoverage(latest))}</strong></div>
            </div>
            <UsageComposition usage={latest} />
          </>
        ) : <div className="context-inline-empty">The next completed response will populate this breakdown.</div>}
      </section>

      <section className="context-definitions">
        <InspectorSectionHeading icon={CircleDollarSign} title="How to read this" />
        <p><strong>Input</strong> is uncached prompt traffic. <strong>Cache read</strong> was served from provider cache. <strong>Output</strong> already includes reasoning tokens when reported.</p>
      </section>

      <RuntimeFacts runtime={runtime} />
    </div>
  );
}
