import React from 'react';
import { TIME_WINDOWS } from '../utils/nodes';

interface TimeWindowSelectorProps {
  /** Selected window in ms, `null` = All. */
  value: number | null;
  onChange: (ms: number | null) => void;
  className?: string;
}

/**
 * Segmented control for the map header: All / 1 min / 30 min / 1 h / 3 h /
 * 6 h / 12 h. Filters which packets every view (map, legend, table, metrics)
 * displays.
 */
export const TimeWindowSelector: React.FC<TimeWindowSelectorProps> = ({
  value,
  onChange,
  className = '',
}) => {
  return (
    <div
      role="group"
      aria-label="Time window"
      className={`flex items-center gap-0.5 bg-slate-800 border border-slate-800 p-0.5 rounded-lg ${className}`}
    >
      {TIME_WINDOWS.map((window) => {
        const active = window.ms === value;
        return (
          <button
            key={window.label}
            type="button"
            onClick={() => onChange(window.ms)}
            aria-pressed={active}
            title={
              window.ms === null
                ? 'Show every logged packet'
                : `Only packets from the last ${window.label}`
            }
            className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
              active
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            {window.label}
          </button>
        );
      })}
    </div>
  );
};
