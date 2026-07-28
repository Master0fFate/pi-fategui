import type { RuntimeState } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';

const radius = 10;
const circumference = 2 * Math.PI * radius;

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  const value = tokens / 1_000;
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, '')}k`;
}

export function ContextWheel({ usage, fallbackWindow }: {
  usage: RuntimeState['contextUsage'];
  fallbackWindow?: number;
}) {
  const contextWindow = usage?.contextWindow ?? fallbackWindow;
  if (!contextWindow) return null;
  const rawPercent = usage?.percent ?? (usage?.tokens === null || usage?.tokens === undefined
    ? null
    : usage.tokens / contextWindow * 100);
  const percent = rawPercent === null ? null : Math.max(0, Math.min(100, rawPercent));
  const level = percent === null ? 'unknown' : percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : 'normal';
  const estimated = usage?.estimated === true && usage.tokens !== null;
  const usageText = usage?.tokens === null || usage?.tokens === undefined
    ? `Context updates after the next response · ? / ${compactTokens(contextWindow)}`
    : estimated
      ? `Estimated context ~${compactTokens(usage.tokens)} / ${compactTokens(contextWindow)} · ~${Math.round(rawPercent ?? 0)}%`
      : `Context ${compactTokens(usage.tokens)} / ${compactTokens(contextWindow)} · ${Math.round(rawPercent ?? 0)}%`;
  const accessibleText = percent === null
    ? `Context usage will update after the next response for a ${compactTokens(contextWindow)} token window`
    : estimated
      ? `Estimated context usage: ${Math.round(rawPercent ?? 0)}% of ${compactTokens(contextWindow)} tokens`
      : `Context usage: ${Math.round(rawPercent ?? 0)}% of ${compactTokens(contextWindow)} tokens`;

  return (
    <AppTooltip content={usageText} delayDuration={300}>
      <span
        className="context-wheel"
        role="meter"
        aria-label={accessibleText}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        data-level={level}
        tabIndex={0}
      >
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <circle className="context-wheel-track" cx="14" cy="14" r={radius} />
          <circle
            className="context-wheel-progress"
            cx="14"
            cy="14"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={percent === null ? circumference : circumference * (1 - percent / 100)}
          />
        </svg>
      </span>
    </AppTooltip>
  );
}
