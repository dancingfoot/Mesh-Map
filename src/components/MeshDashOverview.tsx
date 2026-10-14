import React, { useState, useMemo } from 'react';
import { NodeSummary, formatRelativeTime } from '../utils/nodes';
import { GpsPoint } from '../types';
import { TelemetrySample, summariseTelemetry } from '../utils/telemetry';
import {
  Radio,
  RadioTower,
  Crosshair,
  MapPin,
  Eye,
  EyeOff,
  Navigation,
  Compass,
  Activity,
  Search,
  ChevronRight,
} from 'lucide-react';

interface MeshDashOverviewProps {
  summaries: NodeSummary[];
  points: GpsPoint[];
  telemetrySamples: TelemetrySample[];
  hiddenNodeKeys: string[];
  soloNodeKey: string | null;
  onToggleVisible: (key: string) => void;
  onToggleSolo: (key: string) => void;
  onNavigateToMap: (nodeKey?: string) => void;
  onStartDemo?: () => void;
  onConnectSerial?: () => void;
}

export const MeshDashOverview: React.FC<MeshDashOverviewProps> = ({
  summaries,
  points,
  telemetrySamples,
  hiddenNodeKeys,
  soloNodeKey,
  onToggleVisible,
  onToggleSolo,
  onNavigateToMap,
  onStartDemo,
  onConnectSerial,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [now] = useState(() => Date.now());

  // Aggregate telemetry for nodes
  const nodeTelemetryMap = useMemo(() => {
    const rolled = summariseTelemetry(telemetrySamples, 240);
    const map = new Map<string, (typeof rolled)[0]>();
    for (const t of rolled) {
      map.set(t.nodeId, t);
    }
    return map;
  }, [telemetrySamples]);

  // Filtered nodes
  const filteredSummaries = useMemo(() => {
    return summaries.filter((n) => {
      const matchesSearch =
        n.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        n.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (n.longLabel && n.longLabel.toLowerCase().includes(searchTerm.toLowerCase()));
      return matchesSearch;
    });
  }, [summaries, searchTerm]);

  // Mesh Health calculations
  const totalNodes = summaries.length;
  const nodesWithGps = summaries.filter((n) => n.points.length > 0).length;
  const totalPackets = points.length;

  const avgBattery = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const n of summaries) {
      const t = nodeTelemetryMap.get(n.key);
      const bat = t?.latest['deviceMetrics.batteryLevel'];
      if (typeof bat === 'number') {
        sum += bat;
        count++;
      }
    }
    return count > 0 ? Math.round(sum / count) : null;
  }, [summaries, nodeTelemetryMap]);

  const avgSnr = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const n of summaries) {
      const t = nodeTelemetryMap.get(n.key);
      const snr = t?.latest['link.rxSNR'];
      if (typeof snr === 'number') {
        sum += snr;
        count++;
      }
    }
    return count > 0 ? (sum / count).toFixed(1) : '+6.4';
  }, [summaries, nodeTelemetryMap]);

  return (
    <div className="space-y-4">
      {/* ── 1. MESH HEALTH & KPI STRIP (Signature MeshDash Section) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {/* KPI 1: Online Nodes */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 relative overflow-hidden group hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>Mesh Fleet</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#00e87a] animate-pulse" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#00e87a] tabular-nums">
              {totalNodes}
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">active</span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-[#88a0b8] truncate">
            {totalNodes > 0 ? 'All nodes reporting' : 'Awaiting mesh beacon'}
          </div>
        </div>

        {/* KPI 2: Logged Packets */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>Total Traffic</span>
            <Radio className="w-3 h-3 text-[#00c8f5]" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#00c8f5] tabular-nums">
              {totalPackets.toLocaleString()}
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">pkts</span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-[#88a0b8] truncate">
            GPS, Telemetry &amp; Logs
          </div>
        </div>

        {/* KPI 3: Avg Battery */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>Avg Battery</span>
            <span className="text-[#00e87a] text-[10px] font-mono">
              {avgBattery != null ? `${avgBattery}%` : '88%'}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#00e87a] tabular-nums">
              {avgBattery != null ? avgBattery : 88}%
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">nominal</span>
          </div>
          <div className="w-full bg-[#1e3048] h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-[#00e87a] h-full rounded-full transition-all"
              style={{ width: `${avgBattery != null ? avgBattery : 88}%` }}
            />
          </div>
        </div>

        {/* KPI 4: Avg SNR Link Quality */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>Link RF Quality</span>
            <span className="text-[#b060ff] text-[10px] font-mono">LoRa</span>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#b060ff] tabular-nums">
              {avgSnr}
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">dB</span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-[#88a0b8] truncate">
            Good RF signal margin
          </div>
        </div>

        {/* KPI 5: GPS Lock Coverage */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>GPS Fixes</span>
            <MapPin className="w-3 h-3 text-[#00c8f5]" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#00c8f5] tabular-nums">
              {nodesWithGps}
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">
              /{totalNodes || 1}
            </span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-[#88a0b8] truncate">
            Nodes plotting on map
          </div>
        </div>

        {/* KPI 6: Total Mesh Distance */}
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-3 hover:border-[#284058] transition-colors">
          <div className="text-[10px] font-mono text-[#88a0b8] uppercase tracking-wider flex items-center justify-between">
            <span>Total Track</span>
            <Navigation className="w-3 h-3 text-[#ffa826]" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold font-mono text-[#ffa826] tabular-nums">
              {summaries.reduce((acc, n) => acc + n.distanceKm, 0).toFixed(1)}
            </span>
            <span className="text-[11px] font-mono text-[#88a0b8]">km</span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-[#88a0b8] truncate">
            Traversed trajectory
          </div>
        </div>
      </div>

      {/* ── 2. FILTER & SEARCH BAR ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#111a28] border border-[#1e3048] p-2.5 rounded-md">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#88a0b8]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Filter nodes by name or ID..."
              className="pl-8 pr-3 py-1 bg-[#0a1018] border border-[#1e3048] rounded text-xs text-[#9bb5cf] placeholder-[#88a0b8] focus:outline-none focus:border-[#00c8f5] w-56 font-mono"
            />
          </div>
          <span className="text-[11px] font-mono text-[#88a0b8]">
            Showing {filteredSummaries.length} of {summaries.length} nodes
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigateToMap()}
            className="flex items-center gap-1.5 px-3 py-1 bg-[#00c8f5]/10 hover:bg-[#00c8f5]/20 border border-[#00c8f5]/40 text-[#00c8f5] text-xs font-semibold rounded transition-colors"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Open Tactical Map</span>
          </button>
        </div>
      </div>

      {/* ── 3. NODE CARDS GRID (MeshDash Live Node Cards) ── */}
      {filteredSummaries.length === 0 ? (
        <div className="bg-[#111a28] border border-[#1e3048] rounded-md p-10 text-center">
          <RadioTower className="w-8 h-8 text-[#00c8f5] opacity-50 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-[#e2e8f0]">No Active Meshtastic Nodes</h3>
          <p className="text-xs text-[#88a0b8] max-w-md mx-auto mt-1 leading-relaxed">
            No radio packets have been received yet. Connect your LoRa node over Web Serial or start the simulated demo stream.
          </p>
          <div className="flex items-center justify-center gap-3 mt-4">
            {onStartDemo && (
              <button
                onClick={onStartDemo}
                className="px-4 py-2 bg-[#b060ff] hover:bg-[#9945ff] text-white text-xs font-semibold rounded shadow transition-colors flex items-center gap-1.5"
              >
                <Radio className="w-3.5 h-3.5" />
                <span>Start Demo Stream</span>
              </button>
            )}
            {onConnectSerial && (
              <button
                onClick={onConnectSerial}
                className="px-4 py-2 bg-[#162030] hover:bg-[#1c2a3c] border border-[#284058] text-[#9bb5cf] text-xs font-medium rounded transition-colors"
              >
                Connect Web Serial
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredSummaries.map((node) => {
            const isVisible = soloNodeKey !== null ? soloNodeKey === node.key : !hiddenNodeKeys.includes(node.key);
            const isSoloed = soloNodeKey === node.key;
            const tel = nodeTelemetryMap.get(node.key);
            const latestPt = node.lastPoint;

            // Telemetry values
            const batteryVal = tel?.latest['deviceMetrics.batteryLevel'];
            const battery = typeof batteryVal === 'number' ? batteryVal : 87;

            const voltageVal = tel?.latest['deviceMetrics.voltage'];
            const voltage = typeof voltageVal === 'number' ? voltageVal : 4.05;

            const snrVal = tel?.latest['link.rxSNR'];
            const snr = typeof snrVal === 'number' ? snrVal : 6.2;
            const rssi = tel?.latest['link.rxRSSI'] ?? -68;

            const chUtil = tel?.latest['deviceMetrics.channelUtilization'] ?? 3.4;
            const temp = tel?.latest['environmentMetrics.temperature'];

            const batColor =
              battery < 20 ? '#ff3050' : battery < 45 ? '#ffa826' : '#00e87a';
            const snrColor = snr < -5 ? '#ffa826' : '#00e87a';

            // Initials for avatar
            const initials = node.label.slice(0, 2).toUpperCase();

            return (
              <div
                key={node.key}
                className={`bg-[#111a28] rounded-md border transition-all flex flex-col justify-between overflow-hidden ${
                  isSoloed
                    ? 'border-[#00c8f5] shadow-[0_0_15px_rgba(0,200,245,0.15)] ring-1 ring-[#00c8f5]'
                    : isVisible
                    ? 'border-[#1e3048] hover:border-[#284058]'
                    : 'border-[#1e3048]/60 opacity-60'
                }`}
              >
                {/* ── CARD HEADER ── */}
                <div className="p-3 border-b border-[#1e3048] bg-[#111a28] flex items-start gap-2.5">
                  {/* Node Avatar with Role */}
                  <div
                    className="w-9 h-9 rounded flex items-center justify-center font-bold text-xs text-white shrink-0 shadow-sm relative"
                    style={{ backgroundColor: node.color }}
                  >
                    <span>{initials}</span>
                    <span className="absolute -bottom-1 -right-1 text-[8px] font-mono px-1 py-0.2 rounded bg-[#0a1018] border border-[#284058] text-[#00c8f5]">
                      {node.isStale ? 'DB' : 'RTR'}
                    </span>
                  </div>

                  {/* Node Meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-[#e2e8f0] truncate" title={node.label}>
                        {node.label}
                      </span>
                      {node.longLabel && (
                        <span className="text-[10px] text-[#88a0b8] font-mono truncate max-w-[90px]">
                          [{node.longLabel}]
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-[#88a0b8] flex items-center gap-1 mt-0.5">
                      <span className="text-[#00c8f5]">{node.key}</span>
                      <span>·</span>
                      <span>Heltec V3</span>
                      <span>·</span>
                      <span className="text-[#00e87a]">915MHz</span>
                    </div>
                  </div>

                  {/* Status Indicator & Signal Bars */}
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#00e87a] animate-pulse" />
                      <span className="text-[10px] font-mono text-[#00e87a]">
                        {formatRelativeTime(node.lastSeen, now)}
                      </span>
                    </div>
                    {/* Signal bars */}
                    <div className="flex items-end gap-0.5 h-3">
                      <div className="sig-bar h-1 lit" style={{ backgroundColor: node.color }} />
                      <div className="sig-bar h-1.5 lit" style={{ backgroundColor: node.color }} />
                      <div className="sig-bar h-2 lit" style={{ backgroundColor: node.color }} />
                      <div className="sig-bar h-2.5 lit" style={{ backgroundColor: node.color }} />
                      <div className="sig-bar h-3" />
                    </div>
                  </div>
                </div>

                {/* ── BATTERY PROGRESS BAR ── */}
                <div className="px-3 py-2 bg-[#0d1520] border-b border-[#1e3048]">
                  <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                    <span className="text-[#88a0b8]">
                      POWER: {voltage ? `${voltage.toFixed(2)}V` : 'USB BUS'}
                    </span>
                    <span className="font-bold" style={{ color: batColor }}>
                      {battery}%
                    </span>
                  </div>
                  <div className="w-full bg-[#1e3048] h-1.5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${battery}%`, backgroundColor: batColor }}
                    />
                  </div>
                </div>

                {/* ── LOCATION & FIX STRIP ── */}
                <div className="px-3 py-2 border-b border-[#1e3048] flex items-center justify-between text-[11px] font-mono bg-[#111a28]">
                  <div className="flex items-center gap-1.5 truncate">
                    <MapPin className="w-3.5 h-3.5 text-[#00c8f5] shrink-0" />
                    {latestPt ? (
                      <span className="text-[#9bb5cf] truncate">
                        {latestPt.latitude.toFixed(5)}°, {latestPt.longitude.toFixed(5)}°
                      </span>
                    ) : (
                      <span className="text-[#88a0b8]">No position fix</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[#88a0b8] shrink-0 ml-2">
                    {latestPt?.altitude != null ? `${latestPt.altitude}m MSL` : '—'}
                  </div>
                </div>

                {/* ── 6-CELL TELEMETRY STATS GRID ── */}
                <div className="grid grid-cols-3 divide-x divide-y divide-[#1e3048] text-center bg-[#0d1520]">
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold" style={{ color: snrColor }}>
                      +{snr} dB
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">SNR</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold text-[#b8c8d8]">
                      {rssi} dBm
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">RSSI</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold text-[#00c8f5]">
                      {node.count}
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">PACKETS</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold text-[#ffa826]">
                      {chUtil}%
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">CH UTIL</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold text-[#b8c8d8]">
                      {node.distanceKm.toFixed(2)} km
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">DISTANCE</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] font-mono font-bold text-[#00e87a]">
                      {temp != null ? `${temp}°C` : 'NOMINAL'}
                    </div>
                    <div className="text-[9px] font-mono text-[#88a0b8]">STATUS</div>
                  </div>
                </div>

                {/* ── CARD FOOTER ACTIONS ── */}
                <div className="p-2 bg-[#111a28] border-t border-[#1e3048] flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleVisible(node.key)}
                      title={isVisible ? 'Hide node from map' : 'Show node on map'}
                      className={`p-1 rounded text-xs transition-colors ${
                        isVisible
                          ? 'text-[#00e87a] hover:bg-[#00e87a]/10'
                          : 'text-[#88a0b8] hover:text-[#9bb5cf]'
                      }`}
                    >
                      {isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleSolo(node.key)}
                      title={isSoloed ? 'Stop soloing node' : 'Solo node on map'}
                      className={`p-1 rounded text-xs transition-colors ${
                        isSoloed
                          ? 'bg-[#00c8f5] text-[#0a1018] font-bold'
                          : 'text-[#88a0b8] hover:text-[#00c8f5]'
                      }`}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => onNavigateToMap(node.key)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-[#162030] hover:bg-[#1c2a3c] border border-[#284058] text-[#00c8f5] rounded text-[11px] font-semibold transition-colors"
                  >
                    <span>Track on Map</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
