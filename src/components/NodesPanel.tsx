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
    <div className="space-y-1.5">
      {/* Small show/hide-everything pair + a compact counter */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onShowAll}
          disabled={summaries.length === 0}
          title="Show every node trace"
          className="px-1.5 py-0.5 rounded border border-slate-300 bg-white/70 text-[9px] font-semibold text-slate-600 hover:bg-white disabled:opacity-40 transition-colors"
        >
          All
        </button>
        <button
          type="button"
          onClick={onHideAll}
          disabled={summaries.length === 0}
          title="Hide every node trace"
          className="px-1.5 py-0.5 rounded border border-slate-300 bg-white/70 text-[9px] font-semibold text-slate-600 hover:bg-white disabled:opacity-40 transition-colors"
        >
          None
        </button>
        <span className="ml-auto text-[9px] font-mono text-slate-500 tabular-nums">
          {visibleCount}/{summaries.length} · {shownCount}/{windowedCount} pkts
        </span>
      </div>

      {summaries.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-4 text-center text-[10px] text-slate-500">
          <RadioTower className="w-4 h-4 opacity-50" />
          <span>No nodes in this time window.</span>
        </div>
      ) : (
        <ul className="space-y-1">
          {summaries.map((node) => {
            const visible = isVisible(node.key);
            const soloed = soloKey === node.key;
            return (
              <li
                key={node.key}
                className={`rounded border px-1.5 py-1 transition-colors ${
                  soloed
                    ? 'border-blue-400 bg-blue-50/90'
                    : visible
                    ? 'border-slate-300/70 bg-white/70'
                    : 'border-slate-300/50 bg-white/40 opacity-60'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {/* Colour swatch — same colour as the map trace/markers */}
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 border ${
                      node.isStale ? 'border-dashed border-amber-500 bg-transparent' : 'border-slate-400/70'
                    }`}
                    style={node.isStale ? undefined : { backgroundColor: node.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="font-mono text-[10px] font-semibold text-slate-700 truncate"
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
                  <span className="ml-auto text-[9px] font-mono text-slate-500 shrink-0 tabular-nums">
                    {node.count}×
                  </span>

                  <button
                    type="button"
                    onClick={() => onToggleVisible(node.key)}
                    title={visible ? 'Hide this node trace' : 'Show this node trace'}
                    aria-label={visible ? 'Hide node' : 'Show node'}
                    aria-pressed={visible}
                    className={`p-0.5 rounded transition-colors ${
                      visible
                        ? 'text-emerald-600 hover:bg-emerald-50'
                        : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onToggleSolo(node.key)}
                    title={
                      soloed ? 'Stop soloing this node' : 'Show only this node (Solo)'
                    }
                    aria-label={soloed ? 'Unsolo node' : 'Solo node'}
                    aria-pressed={soloed}
                    className={`p-0.5 rounded transition-colors ${
                      soloed
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-white'
                    }`}
                  >
                    <Crosshair className="w-3 h-3" />
                  </button>
                </div>

                <div className="pl-4 text-[9px] font-mono text-slate-500 truncate">
                  {/* A database fix is not a live one — say so before anything else. */}
                  {node.isStale && (
                    <span className="text-amber-600 font-semibold">last known · </span>
                  )}
                  {/* The short name is terse, so keep the descriptive name and the
                      raw address visible underneath it. */}
                  {node.longLabel && <span className="text-slate-400">{node.longLabel} · </span>}
                  {node.label !== node.key && <span className="text-slate-400">{node.key} · </span>}
                  {node.distanceKm.toFixed(2)} km · {formatRelativeTime(node.lastSeen, now)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

