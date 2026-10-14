import React, { useEffect, useState } from 'react';
import { NodeSummary, formatRelativeTime } from '../utils/nodes';
import { Crosshair, Eye, EyeOff, RadioTower } from 'lucide-react';

interface NodesPanelProps {
  /** Aggregated nodes of the current time window, newest first. */
  summaries: NodeSummary[];
  /** Keys explicitly hidden with the eye toggle. */
  hiddenKeys: string[];
  /** When set, only this node is displayed regardless of `hiddenKeys`. */
  soloKey: string | null;
  /** Packets currently displayed (after time + node filtering). */
  shownCount: number;
  /** Packets inside the current time window (before node filtering). */
  windowedCount: number;
  onToggleVisible: (key: string) => void;
  onToggleSolo: (key: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

/**
 * Node list for the left rail: one row per mesh node with colour swatch,
 * packet count, distance, relative last-seen time and the Visible / Solo
 * toggles. Presentation only — all state lives in `App`.
 */
export const NodesPanel: React.FC<NodesPanelProps> = ({
  summaries,
  hiddenKeys,
  soloKey,
  shownCount,
  windowedCount,
  onToggleVisible,
  onToggleSolo,
  onShowAll,
  onHideAll,
}) => {
  // Re-render periodically so "just now" ages into "3 m ago" without traffic.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const isVisible = (key: string) =>
    soloKey !== null ? soloKey === key : !hiddenKeys.includes(key);

  const visibleCount = summaries.filter((s) => isVisible(s.key)).length;

  return (
    <div className="space-y-2">
      {/* Small show/hide-everything pair + a compact counter */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onShowAll}
          disabled={summaries.length === 0}
          title="Show every node trace"
          className="px-2 py-0.5 rounded-md border border-slate-700 bg-slate-800/90 text-[10px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          All
        </button>
        <button
          type="button"
          onClick={onHideAll}
          disabled={summaries.length === 0}
          title="Hide every node trace"
          className="px-2 py-0.5 rounded-md border border-slate-700 bg-slate-800/90 text-[10px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          None
        </button>
        <span className="ml-auto text-[10px] font-mono text-slate-400 tabular-nums">
          {visibleCount}/{summaries.length} nodes · {shownCount}/{windowedCount} pkts
        </span>
      </div>

      {summaries.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-6 text-center text-xs text-slate-400">
          <RadioTower className="w-5 h-5 opacity-40 text-blue-400" />
          <span>No mesh nodes active in this window.</span>
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-[360px] overflow-y-auto pr-0.5">
          {summaries.map((node) => {
            const visible = isVisible(node.key);
            const soloed = soloKey === node.key;
            return (
              <li
                key={node.key}
                className={`rounded-lg border px-2 py-1.5 transition-all ${
                  soloed
                    ? 'border-blue-500 bg-blue-950/60 shadow-sm shadow-blue-900/30'
                    : visible
                    ? 'border-slate-800 bg-slate-900/90 hover:border-slate-700'
                    : 'border-slate-800/60 bg-slate-900/40 opacity-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  {/* Colour swatch */}
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 border ${
                      node.isStale ? 'border-dashed border-amber-400 bg-transparent' : 'border-slate-300'
                    }`}
                    style={node.isStale ? undefined : { backgroundColor: node.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="font-mono text-[11px] font-bold text-slate-100 truncate"
                    title={
                      node.longLabel
                        ? `${node.label} — ${node.longLabel} (${node.key})`
                        : node.label === node.key
                        ? node.key
                        : `${node.label} (${node.key})`
                    }
                  >
                    {node.label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-cyan-400/90 shrink-0 tabular-nums">
                    {node.count} pkts
                  </span>

                  <button
                    type="button"
                    onClick={() => onToggleVisible(node.key)}
                    title={visible ? 'Hide this node trace' : 'Show this node trace'}
                    aria-label={visible ? 'Hide node' : 'Show node'}
                    aria-pressed={visible}
                    className={`p-1 rounded-md transition-colors ${
                      visible
                        ? 'text-emerald-400 hover:bg-emerald-950/60'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onToggleSolo(node.key)}
                    title={
                      soloed ? 'Stop soloing this node' : 'Solo: show only this node'
                    }
                    aria-label={soloed ? 'Unsolo node' : 'Solo node'}
                    aria-pressed={soloed}
                    className={`p-1 rounded-md transition-colors ${
                      soloed
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                    }`}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="pl-4.5 text-[10px] font-mono text-slate-400 truncate mt-0.5">
                  {node.isStale && (
                    <span className="text-amber-400 font-semibold">last known · </span>
                  )}
                  {node.longLabel && <span className="text-slate-300">{node.longLabel} · </span>}
                  {node.label !== node.key && <span className="text-slate-500">{node.key} · </span>}
                  <span className="text-slate-300">{node.distanceKm.toFixed(2)} km</span>
                  <span className="text-slate-500"> · </span>
                  <span>{formatRelativeTime(node.lastSeen, now)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

