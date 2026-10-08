import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Users } from 'lucide-react';
import { NodeSummary } from '../utils/nodes';
import { NodesPanel } from './NodesPanel';

interface MapNodeOverlayProps {
  summaries: NodeSummary[];
  hiddenKeys: string[];
  soloKey: string | null;
  shownCount: number;
  windowedCount: number;
  onToggleVisible: (key: string) => void;
  onToggleSolo: (key: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

/**
 * The node list as a map overlay, anchored bottom-left by `FoliumMap`.
 *
 * Collapsed it is a single header chip, so it never eats the map; expanded it
 * scrolls. Pointer/wheel events are stopped from reaching Leaflet, otherwise
 * scrolling the list would pan the map underneath.
 */
export const MapNodeOverlay: React.FC<MapNodeOverlayProps> = ({
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
  const [open, setOpen] = useState(true);

  return (
    <div className="w-56 rounded-lg border border-white/70 bg-white/75 backdrop-blur-md shadow-lg text-slate-700 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Collapse node list' : 'Expand node list'}
        title={open ? 'Collapse the node list' : 'Expand the node list'}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold hover:bg-white/70 transition-colors"
      >
        <Users className="w-3 h-3 text-blue-600" />
        <span>Nodes</span>
        <span
          className="px-1 py-0.5 rounded bg-slate-200/80 text-[9px] font-mono text-slate-600"
          title={`${summaries.length} node(s) in the current time window`}
        >
          {summaries.length}
        </span>
        <span className="ml-auto text-slate-400">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </span>
      </button>

      {open && (
        <div
          className="border-t border-white/70 max-h-[38vh] overflow-y-auto p-1.5"
          onPointerDownCapture={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <NodesPanel
            summaries={summaries}
            hiddenKeys={hiddenKeys}
            soloKey={soloKey}
            shownCount={shownCount}
            windowedCount={windowedCount}
            onToggleVisible={onToggleVisible}
            onToggleSolo={onToggleSolo}
            onShowAll={onShowAll}
            onHideAll={onHideAll}
          />
        </div>
      )}
    </div>
  );
};
