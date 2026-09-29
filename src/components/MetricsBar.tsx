import React from 'react';
import { GpsPoint } from '../types';
import { calculateTotalDistanceKm } from '../utils/haversine';
import { Navigation, MapPin, Gauge, Mountain, Radio, Compass } from 'lucide-react';

interface MetricsBarProps {
  points: GpsPoint[];
}

export const MetricsBar: React.FC<MetricsBarProps> = ({ points }) => {
  const totalPoints = points.length;
  const totalDistanceKm = calculateTotalDistanceKm(points);
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {/* 1. Total Points */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <MapPin className="w-3.5 h-3.5 text-blue-600" />
          <span>Logged Points</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {totalPoints.toLocaleString()}
          </span>
          <span className="text-xs font-mono text-slate-400">pts</span>
        </div>
      </div>

      {/* 2. Total Distance */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Navigation className="w-3.5 h-3.5 text-emerald-600" />
          <span>Distance Covered</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {totalDistanceKm.toFixed(2)}
          </span>
          <span className="text-xs font-mono text-slate-400">km</span>
        </div>
      </div>

      {/* 3. Current Latitude */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Compass className="w-3.5 h-3.5 text-cyan-600" />
          <span>Current Latitude</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white truncate">
            {latestPoint ? latestPoint.latitude.toFixed(5) : '—'}
          </span>
          {latestPoint && <span className="text-xs font-mono text-slate-400">°N</span>}
        </div>
      </div>

      {/* 4. Current Longitude */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Compass className="w-3.5 h-3.5 text-cyan-600" />
          <span>Current Longitude</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white truncate">
            {latestPoint ? latestPoint.longitude.toFixed(5) : '—'}
          </span>
          {latestPoint && <span className="text-xs font-mono text-slate-400">°E</span>}
        </div>
      </div>

      {/* 5. Altitude */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Mountain className="w-3.5 h-3.5 text-amber-600" />
          <span>Altitude</span>
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {latestPoint && latestPoint.altitude !== null ? latestPoint.altitude : '—'}
          </span>
          {latestPoint && latestPoint.altitude !== null && (
            <span className="text-xs font-mono text-slate-400">m</span>
          )}
        </div>
      </div>

      {/* 6. Active Source */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Radio className="w-3.5 h-3.5 text-indigo-600" />
          <span>Active Packet</span>
        </div>
        <div className="mt-1">
          <span className="text-sm font-semibold font-mono text-slate-900 dark:text-white truncate block">
            {latestPoint ? latestPoint.source : 'Idle'}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate block">
            {latestPoint?.node_id ? `ID: ${latestPoint.node_id}` : '115200 baud'}
          </span>
        </div>
      </div>
    </div>
  );
};
