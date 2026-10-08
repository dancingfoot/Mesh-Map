import React, { useState } from 'react';
import { GpsPoint } from '../types';
import { exportToGeoJson, exportToGpx, exportToCsv } from '../utils/haversine';
import { Download, FileJson, FileSpreadsheet, Search } from 'lucide-react';

interface PointsTableProps {
  /** Packets currently displayed (after the time-window / node filters). */
  points: GpsPoint[];
  /** Total logged packets, so the filtered subset stays discoverable. */
  totalCount?: number;
}

export const PointsTable: React.FC<PointsTableProps> = ({ points, totalCount }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const unfilteredCount = totalCount ?? points.length;

  const filteredPoints = points.filter(
    (p) =>
      p.source.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.latitude.toString().includes(searchTerm) ||
      p.longitude.toString().includes(searchTerm) ||
      (p.node_id && p.node_id.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportGeoJson = () => {
    downloadFile(exportToGeoJson(points), `meshtastic_track_${Date.now()}.geojson`, 'application/geo+json');
  };

  const handleExportGpx = () => {
    downloadFile(exportToGpx(points), `meshtastic_track_${Date.now()}.gpx`, 'application/gpx+xml');
  };

  const handleExportCsv = () => {
    downloadFile(exportToCsv(points), `meshtastic_track_${Date.now()}.csv`, 'text/csv');
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Logged Coordinate Points</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {points.length === unfilteredCount
              ? `${points.length} coordinates recorded in current session trace`
              : `${points.length} of ${unfilteredCount} coordinates shown (time window / node filter)`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Filter coordinates..."
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:border-blue-500 w-44"
            />
          </div>

          {/* Export Buttons */}
          <button
            onClick={handleExportGeoJson}
            disabled={points.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg transition-colors disabled:opacity-40"
            title="Export GeoJSON for QGIS / ArcGIS"
          >
            <FileJson className="w-3.5 h-3.5 text-blue-600" />
            <span>GeoJSON</span>
          </button>

          <button
            onClick={handleExportGpx}
            disabled={points.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg transition-colors disabled:opacity-40"
            title="Export GPX for Garmin / OsmAnd / Google Earth"
          >
            <Download className="w-3.5 h-3.5 text-emerald-600" />
            <span>GPX</span>
          </button>

          <button
            onClick={handleExportCsv}
            disabled={points.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg transition-colors disabled:opacity-40"
            title="Export CSV spreadsheet"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-amber-600" />
            <span>CSV</span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[320px]">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60 sticky top-0 z-10 text-slate-600 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="py-2.5 px-3 w-12">#</th>
              <th className="py-2.5 px-3">Timestamp</th>
              <th className="py-2.5 px-3">Latitude</th>
              <th className="py-2.5 px-3">Longitude</th>
              <th className="py-2.5 px-3">Altitude</th>
              <th className="py-2.5 px-3">Speed</th>
              <th className="py-2.5 px-3">Source</th>
              <th className="py-2.5 px-3">Node ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200 font-mono">
            {filteredPoints.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-500 font-sans">
                  No coordinate records match.
                </td>
              </tr>
            ) : (
              [...filteredPoints].reverse().map((pt, idx) => {
                const isStart = pt.id === points[0]?.id;
                const isCurrent = pt.id === points[points.length - 1]?.id;
                return (
                  <tr
                    key={pt.id}
                    className={`hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors ${
                      isCurrent
                        ? 'bg-rose-50/40 dark:bg-rose-950/20'
                        : isStart
                        ? 'bg-emerald-50/40 dark:bg-emerald-950/20'
                        : ''
                    }`}
                  >
                    <td className="py-2 px-3 text-slate-400 tabular-nums">
                      {isCurrent ? (
                        <span className="text-red-600 font-bold">●</span>
                      ) : isStart ? (
                        <span className="text-emerald-600 font-bold">▶</span>
                      ) : (
                        points.length - idx
                      )}
                    </td>
                    <td className="py-2 px-3 tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {new Date(pt.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 px-3 tabular-nums font-semibold">{pt.latitude.toFixed(6)}°</td>
                    <td className="py-2 px-3 tabular-nums font-semibold">{pt.longitude.toFixed(6)}°</td>
                    <td className="py-2 px-3 tabular-nums">
                      {pt.altitude != null ? `${pt.altitude} m` : '—'}
                    </td>
                    <td className="py-2 px-3 tabular-nums">
                      {pt.speed_kmh != null ? `${pt.speed_kmh} km/h` : '—'}
                    </td>
                    <td className="py-2 px-3 font-sans text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {pt.source}
                    </td>
                    <td className="py-2 px-3 text-slate-500 tabular-nums">
                      {pt.node_id || '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
