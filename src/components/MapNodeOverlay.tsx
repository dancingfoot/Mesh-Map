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
    <div className="w-64 rounded-xl border border-slate-700/80 bg-slate-900/90 backdrop-blur-md shadow-2xl text-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Collapse node list' : 'Expand node list'}
        title={open ? 'Collapse the node list' : 'Expand the node list'}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-slate-800/80 transition-colors"
      >
        <Users className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-slate-100">Mesh Fleet</span>
        <span
          className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-cyan-300"
          title={`${summaries.length} node(s) in current time window`}
        >
          {summaries.length}
        </span>
        <span className="ml-auto text-slate-400">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </span>
      </button>

      {open && (
        <div
          className="border-t border-slate-800 max-h-[42vh] overflow-y-auto p-2"
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
