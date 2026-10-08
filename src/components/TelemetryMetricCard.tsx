import React from 'react';
import { Sparkline } from './Sparkline';
import {
  friendlyMetricLabel,
  formatMetricValue,
  metricTone,
  metricUnit,
} from '../utils/telemetryMetrics';
import type { TelemetryValue } from '../utils/telemetry';

/** One metric history point (time in epoch ms, value numeric). */
export interface TelemetryPoint {
  t: number;
  v: number;
}

interface TelemetryMetricCardProps {
  /** Raw source field name, e.g. `batteryLevel`. */
  name: string;
  /** Newest value of that field for this node (from any sample). */
  value: TelemetryValue | undefined;
  /** Numeric history, oldest first (already scoped to the time window). */
  history: TelemetryPoint[];
  /** Colour of the owning node, used for the sparkline. */
  color: string;
}

/**
 * A single metric inside a kind card: friendly label, latest value, unit and —
 * for numeric metrics with at least two history points — an inline SVG
 * sparkline with min/max labels.
 *
 * Metrics with no known unit and no friendly name still render: the raw field
 * name and its raw value are shown, satisfying "never hide a field".
 */
export const TelemetryMetricCard: React.FC<TelemetryMetricCardProps> = ({
  name,
  value,
  history,
  color,
}) => {
  const unit = metricUnit(name);
  const tone = value === undefined ? 'none' : metricTone(value);
  const showSparkline = tone === 'number' && history.length >= 2;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 truncate" title={name}>
            {friendlyMetricLabel(name)}
          </div>
          <div className="font-mono text-[10px] text-slate-400 truncate" title={name}>
            {name}
          </div>
        </div>
        <div className="text-right shrink-0">
          {value === undefined ? (
            <span className="font-mono text-sm text-slate-400">—</span>
          ) : (
            <span className="font-mono text-sm font-semibold text-slate-100 break-all">
              {formatMetricValue(value)}
              {unit ? <span className="text-[10px] font-normal text-slate-400 ml-0.5">{unit}</span> : null}
            </span>
          )}
        </div>
      </div>

      {showSparkline && (
        <Sparkline
          values={history.map((point) => point.v)}
          color={color}
          label={`${friendlyMetricLabel(name)} trend, ${history.length} points`}
          className="mt-1.5"
        />
      )}

      {tone === 'number' && history.length === 1 && (
        <div className="mt-1 text-[9px] font-mono text-slate-400">1 point · trend needs 2+</div>
      )}
    </div>
  );
};
