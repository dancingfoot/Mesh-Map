import React from 'react';

interface SparklineProps {
  /** Numeric history, oldest first. Values are finite numbers. */
  values: number[];
  /** Stroke colour (defaults to the app's blue). */
  color?: string;
  /** Optional label for assistive tech. */
  label?: string;
  className?: string;
}

/** Draws a polyline through `values` inside a 100x28 viewBox. */
function buildPath(values: number[], min: number, max: number): string {
  const span = max - min;
  const n = values.length;
  return values
    .map((value, index) => {
      const x = n === 1 ? 50 : (index / (n - 1)) * 100;
      const y = span === 0 ? 14 : 25 - ((value - min) / span) * 22;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Rounds to at most 2 decimals and trims trailing zeros. */
function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Inline SVG sparkline (no chart library).
 *
 * The newest sample sits on the right. Min/max labels are rendered underneath
 * so the shape is readable without axes. Values are drawn with
 * `preserveAspectRatio="none"` and a non-scaling stroke, so the chart fills
 * whatever width the card gives it without distorting the line weight.
 */
export const Sparkline: React.FC<SparklineProps> = ({
  values,
  color = '#2563EB',
  label,
  className = '',
}) => {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length === 0) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const path = buildPath(points, min, max);

  return (
    <div className={className}>
      <svg
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        className="w-full h-7 block"
        role="img"
        aria-label={label ?? `Sparkline of the last ${points.length} values`}
      >
        {/* Baseline, so a flat series is still visible */}
        <line x1="0" y1="25" x2="100" y2="25" stroke="#E2E8F0" strokeWidth="0.4" />
        <polyline
          points={path}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.length === 1 && (
          <circle cx="50" cy={buildPath(points, min, max).split(',')[1]} r="2" fill={color} />
        )}
      </svg>
      <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 leading-none mt-0.5">
        <span title="Lowest value in this window">min {formatTick(min)}</span>
        <span className="text-slate-300">{points.length} pts</span>
        <span title="Highest value in this window">max {formatTick(max)}</span>
      </div>
    </div>
  );
};
