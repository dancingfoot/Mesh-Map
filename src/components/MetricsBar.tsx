import React, { useState } from 'react';
import { GpsPoint } from '../types';
import { calculateTotalDistanceKm } from '../utils/haversine';
import { Navigation, MapPin, Mountain, Radio, Compass, Copy, Check } from 'lucide-react';

interface MetricsBarProps {
  /** Packets currently displayed (after the time-window / node filters). */
  points: GpsPoint[];
  /** Total logged packets, so the filtered subset stays discoverable. */
  totalCount?: number;
}

export const MetricsBar: React.FC<MetricsBarProps> = ({ points, totalCount }) => {
  const [copiedCoords, setCopiedCoords] = useState(false);
  const totalPoints = points.length;
  const unfilteredCount = totalCount ?? totalPoints;
  const isFiltered = unfilteredCount !== totalPoints;
  const totalDistanceKm = calculateTotalDistanceKm(points);
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;

  const handleCopyCoords = () => {
    if (!latestPoint) return;
    const text = `${latestPoint.latitude.toFixed(6)}, ${latestPoint.longitude.toFixed(6)}`;
    navigator.clipboard.writeText(text);
    setCopiedCoords(true);
    setTimeout(() => setCopiedCoords(false), 2000);
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {/* 1. Total Points */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <MapPin className="w-3 h-3 text-cyan-400" />
          <span>Fixes</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-base sm:text-lg font-bold font-mono tabular-nums text-slate-100">
            {totalPoints.toLocaleString()}
          </span>
          <span className="text-[10px] font-mono text-slate-500">
            {isFiltered ? `/${unfilteredCount}` : 'pkts'}
          </span>
        </div>
      </div>

      {/* 2. Total Distance */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <Navigation className="w-3 h-3 text-emerald-400" />
          <span>Distance</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-base sm:text-lg font-bold font-mono tabular-nums text-slate-100">
            {totalDistanceKm.toFixed(2)}
          </span>
          <span className="text-[10px] font-mono text-slate-500">km</span>
        </div>
      </div>

      {/* 3. Current Latitude */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <div className="flex items-center gap-1.5">
            <Compass className="w-3 h-3 text-cyan-400" />
            <span>Latitude</span>
          </div>
          {latestPoint && (
            <button
              onClick={handleCopyCoords}
              title="Copy coordinates"
              className="text-slate-500 hover:text-slate-300 transition-colors"
            >
              {copiedCoords ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
            </button>
          )}
        </div>
        <div className="mt-1 flex items-baseline gap-0.5">
          <span className="text-base sm:text-lg font-bold font-mono tabular-nums text-slate-100 truncate">
            {latestPoint ? latestPoint.latitude.toFixed(5) : '—'}
          </span>
          {latestPoint && <span className="text-[10px] font-mono text-slate-500">°N</span>}
        </div>
      </div>

      {/* 4. Current Longitude */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <Compass className="w-3 h-3 text-cyan-400" />
          <span>Longitude</span>
        </div>
        <div className="mt-1 flex items-baseline gap-0.5">
          <span className="text-base sm:text-lg font-bold font-mono tabular-nums text-slate-100 truncate">
            {latestPoint ? latestPoint.longitude.toFixed(5) : '—'}
          </span>
          {latestPoint && <span className="text-[10px] font-mono text-slate-500">°E</span>}
        </div>
      </div>

      {/* 5. Altitude */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <Mountain className="w-3 h-3 text-amber-400" />
          <span>Altitude</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-base sm:text-lg font-bold font-mono tabular-nums text-slate-100">
            {latestPoint && latestPoint.altitude != null ? latestPoint.altitude : '—'}
          </span>
          {latestPoint && latestPoint.altitude != null && (
            <span className="text-[10px] font-mono text-slate-500">m</span>
          )}
        </div>
      </div>

      {/* 6. Active Source */}
      <div className="p-2 sm:p-2.5 bg-[#101726] rounded-lg border border-slate-800/80 hover:border-slate-700 transition-colors">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
          <Radio className="w-3 h-3 text-violet-400" />
          <span>RF Source</span>
        </div>
        <div className="mt-0.5">
          <span className="text-xs font-bold font-mono text-slate-100 truncate block">
            {latestPoint ? latestPoint.source : 'Idle'}
          </span>
          <span className="text-[10px] text-slate-400 font-mono truncate block">
            {latestPoint?.node_id ? `${latestPoint.node_id}` : 'LoRa 915M'}
          </span>
        </div>
      </div>
    </div>
  );
};
