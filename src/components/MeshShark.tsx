import React, { useState, useMemo } from 'react';
import { GpsPoint } from '../types';
import {
  Search,
  Filter,
  Play,
  Pause,
  Trash2,
  Download,
  Copy,
  Check,
  Radio,
  FileCode,
  Layers,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';

export interface CapturedPacket {
  id: string;
  number: number;
  timestamp: string;
  timeEpoch: number;
  from: string;
  fromName?: string;
  to: string;
  toName?: string;
  portnum: 'POSITION_APP' | 'TELEMETRY_APP' | 'NODEINFO_APP' | 'TEXT_MESSAGE_APP' | 'ROUTING_APP' | 'TRACEROUTE_APP' | 'NMEA';
  rxSNR?: number | null;
  rxRSSI?: number | null;
  hopLimit?: number;
  hopStart?: number;
  hopsTraversed?: number;
  sizeBytes: number;
  summary: string;
  decoded: Record<string, any>;
  raw: string;
}

interface MeshSharkProps {
  packets: CapturedPacket[];
  onClearPackets: () => void;
  onInjectPacket?: (raw: string) => void;
}

export const MeshShark: React.FC<MeshSharkProps> = ({
  packets,
  onClearPackets,
}) => {
  const [filterType, setFilterType] = useState<string>('ALL');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(true);
  const [copiedRaw, setCopiedRaw] = useState<boolean>(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    radio: true,
    mesh: true,
    payload: true,
  });

  const toggleSection = (sec: string) => {
    setExpandedSections((prev) => ({ ...prev, [sec]: !prev[sec] }));
  };

  const filteredPackets = useMemo(() => {
    return packets.filter((p) => {
      if (filterType !== 'ALL' && p.portnum !== filterType) {
        return false;
      }
      if (filterQuery.trim()) {
        const q = filterQuery.toLowerCase();
        const matchesQuery =
          p.from.toLowerCase().includes(q) ||
          (p.fromName && p.fromName.toLowerCase().includes(q)) ||
          p.to.toLowerCase().includes(q) ||
          p.summary.toLowerCase().includes(q) ||
          p.portnum.toLowerCase().includes(q) ||
          p.raw.toLowerCase().includes(q);
        if (!matchesQuery) return false;
      }
      return true;
    });
  }, [packets, filterType, filterQuery]);

  // Set default selected packet
  const selectedPacket = useMemo(() => {
    if (selectedPacketId) {
      const found = packets.find((p) => p.id === selectedPacketId);
      if (found) return found;
    }
    return filteredPackets.length > 0 ? filteredPackets[filteredPackets.length - 1] : null;
  }, [selectedPacketId, packets, filteredPackets]);

  const handleCopyRaw = () => {
    if (!selectedPacket) return;
    navigator.clipboard.writeText(selectedPacket.raw);
    setCopiedRaw(true);
    setTimeout(() => setCopiedRaw(false), 2000);
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(filteredPackets, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `meshshark_capture_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    dlAnchor.click();
  };

  // Color mappings
  const getPortnumBadge = (portnum: CapturedPacket['portnum']) => {
    switch (portnum) {
      case 'POSITION_APP':
        return 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80';
      case 'TELEMETRY_APP':
        return 'bg-violet-950/80 text-violet-300 border-violet-800/80';
      case 'NODEINFO_APP':
        return 'bg-cyan-950/80 text-cyan-300 border-cyan-800/80';
      case 'TEXT_MESSAGE_APP':
        return 'bg-amber-950/80 text-amber-300 border-amber-800/80';
      case 'TRACEROUTE_APP':
      case 'ROUTING_APP':
        return 'bg-blue-950/80 text-blue-300 border-blue-800/80';
      case 'NMEA':
      default:
        return 'bg-slate-800/80 text-slate-300 border-slate-700/80';
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] min-h-[580px] bg-[#0A0F19] rounded-xl border border-slate-800/90 overflow-hidden shadow-2xl">
      {/* ── TOP TOOLBAR ── */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2 bg-[#101726] border-b border-slate-800/90 text-xs">
        {/* Left: Branding & Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-900 border border-cyan-500/30 rounded text-cyan-400 font-bold font-mono text-[11px] mr-1">
            <Radio className="w-3.5 h-3.5" />
            <span>MeshShark</span>
          </div>

          {(['ALL', 'POSITION_APP', 'TELEMETRY_APP', 'NODEINFO_APP', 'TEXT_MESSAGE_APP', 'ROUTING_APP', 'NMEA'] as const).map(
            (type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                  filterType === type
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                {type === 'ALL'
                  ? 'All Packets'
                  : type.replace('_APP', '')}
              </button>
            )
          )}
        </div>

        {/* Right: Capture status, search, and export */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="BPF / packet filter..."
              className="pl-8 pr-3 py-1 bg-[#090D16] border border-slate-800 rounded text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono w-44 sm:w-56"
            />
          </div>

          <button
            onClick={() => setIsCapturing(!isCapturing)}
            title={isCapturing ? 'Pause live packet capture' : 'Resume live packet capture'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
              isCapturing
                ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800 hover:bg-emerald-900/60'
                : 'bg-amber-950/60 text-amber-300 border border-amber-800 hover:bg-amber-900/60'
            }`}
          >
            {isCapturing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            <span className="hidden sm:inline">{isCapturing ? 'Live' : 'Paused'}</span>
          </button>

          <button
            onClick={handleExportJson}
            title="Export captured packets to JSON"
            className="flex items-center gap-1 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700/80 text-xs font-mono transition-colors"
          >
            <Download className="w-3 h-3" />
            <span className="hidden sm:inline">Export</span>
          </button>

          <button
            onClick={onClearPackets}
            title="Clear capture buffer"
            className="p-1 rounded bg-slate-900 hover:bg-rose-950/50 hover:text-rose-400 text-slate-400 border border-slate-800 text-xs transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── UPPER PANE: PACKET LIST (Wireshark Table) ── */}
      <div className="flex-1 min-h-[220px] overflow-auto border-b border-slate-800/90 font-mono text-xs select-text">
        <table className="w-full text-left border-collapse">
          <thead className="bg-[#0D1322] text-[10px] text-slate-400 uppercase tracking-wider sticky top-0 border-b border-slate-800/80 z-10">
            <tr>
              <th className="py-1.5 px-2.5 w-12 text-slate-500">No.</th>
              <th className="py-1.5 px-2 w-24">Time</th>
              <th className="py-1.5 px-2.5 w-32">Source</th>
              <th className="py-1.5 px-2.5 w-28">Destination</th>
              <th className="py-1.5 px-2.5 w-32">PortNum</th>
              <th className="py-1.5 px-2 w-16 text-right">Len</th>
              <th className="py-1.5 px-2.5 w-24 text-right">SNR/RSSI</th>
              <th className="py-1.5 px-2 w-16 text-center">Hops</th>
              <th className="py-1.5 px-3">Protocol Summary / Info</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {filteredPackets.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-slate-500 font-mono">
                  No packets captured. Start simulation or send radio packets to view live traffic.
                </td>
              </tr>
            ) : (
              filteredPackets.map((pkt) => {
                const isSelected = selectedPacket?.id === pkt.id;
                return (
                  <tr
                    key={pkt.id}
                    onClick={() => setSelectedPacketId(pkt.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-cyan-950/70 text-cyan-100 font-medium'
                        : 'hover:bg-slate-800/40 text-slate-300'
                    }`}
                  >
                    <td className="py-1 px-2.5 text-slate-500 tabular-nums">{pkt.number}</td>
                    <td className="py-1 px-2 text-slate-400 tabular-nums truncate">{pkt.timestamp}</td>
                    <td className="py-1 px-2.5 font-bold text-cyan-400 truncate">
                      {pkt.fromName || pkt.from}
                    </td>
                    <td className="py-1 px-2.5 text-slate-400 truncate">
                      {pkt.toName || pkt.to}
                    </td>
                    <td className="py-1 px-2.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${getPortnumBadge(pkt.portnum)}`}>
                        {pkt.portnum.replace('_APP', '')}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-right text-slate-400 tabular-nums">{pkt.sizeBytes} B</td>
                    <td className="py-1 px-2.5 text-right font-mono tabular-nums text-slate-300">
                      {pkt.rxSNR != null ? `+${pkt.rxSNR} dB` : '—'}
                    </td>
                    <td className="py-1 px-2 text-center text-slate-400 tabular-nums">
                      {pkt.hopsTraversed != null ? `${pkt.hopsTraversed}h` : '0h'}
                    </td>
                    <td className="py-1 px-3 text-slate-300 truncate max-w-md">
                      {pkt.summary}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── LOWER PANE: PROTOCOL TREE & PAYLOAD HEX/JSON VIEW ── */}
      <div className="h-60 sm:h-64 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800/90 bg-[#0B0F1A]">
        {/* Detail Pane 1: Protocol Layers Breakdown */}
        <div className="overflow-y-auto p-3 font-mono text-xs space-y-2">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between pb-1 border-b border-slate-800">
            <span>Protocol Tree Breakdown</span>
            {selectedPacket && (
              <span className="text-cyan-400 font-normal">Frame #{selectedPacket.number}</span>
            )}
          </div>

          {!selectedPacket ? (
            <div className="text-slate-500 py-6 text-center">Select a packet above to inspect protocol headers.</div>
          ) : (
            <div className="space-y-2">
              {/* Radio Physical Layer */}
              <div className="border border-slate-800 rounded bg-[#0E1524]">
                <button
                  type="button"
                  onClick={() => toggleSection('radio')}
                  className="w-full flex items-center justify-between p-2 text-left text-slate-300 font-semibold hover:bg-slate-800/50"
                >
                  <span className="flex items-center gap-1 text-cyan-400">
                    {expandedSections.radio ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    Radio Physical Layer (LoRa SX1262)
                  </span>
                  <span className="text-[10px] text-slate-500">915.000 MHz</span>
                </button>
                {expandedSections.radio && (
                  <div className="p-2.5 pt-0 text-[11px] text-slate-400 space-y-1 divide-y divide-slate-800/40">
                    <div className="flex justify-between pt-1">
                      <span>Rx Signal-to-Noise Ratio (SNR):</span>
                      <span className="text-emerald-400 font-bold">
                        {selectedPacket.rxSNR != null ? `+${selectedPacket.rxSNR} dB` : '+6.4 dB (nominal)'}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span>Rx Signal Strength (RSSI):</span>
                      <span className="text-cyan-400 font-bold">
                        {selectedPacket.rxRSSI != null ? `${selectedPacket.rxRSSI} dBm` : '-68 dBm'}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span>Modulation / Bandwidth:</span>
                      <span className="text-slate-300">LoRa BW=250kHz, SF=11, CR=4/5</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Meshtastic Mesh Header */}
              <div className="border border-slate-800 rounded bg-[#0E1524]">
                <button
                  type="button"
                  onClick={() => toggleSection('mesh')}
                  className="w-full flex items-center justify-between p-2 text-left text-slate-300 font-semibold hover:bg-slate-800/50"
                >
                  <span className="flex items-center gap-1 text-violet-400">
                    {expandedSections.mesh ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    Meshtastic Routing &amp; Transport Header
                  </span>
                  <span className="text-[10px] text-slate-500">{selectedPacket.portnum}</span>
                </button>
                {expandedSections.mesh && (
                  <div className="p-2.5 pt-0 text-[11px] text-slate-400 space-y-1 divide-y divide-slate-800/40">
                    <div className="flex justify-between pt-1">
                      <span>Source Node ID (From):</span>
                      <span className="text-violet-300 font-bold font-mono">{selectedPacket.from} ({selectedPacket.fromName || 'Node'})</span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span>Destination Node (To):</span>
                      <span className="text-slate-300 font-mono">{selectedPacket.to}</span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span>Hop Limit / Start / Traversed:</span>
                      <span className="text-amber-400 font-mono">
                        {selectedPacket.hopLimit ?? 3} / {selectedPacket.hopStart ?? 3} ({selectedPacket.hopsTraversed ?? 0} hops taken)
                      </span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span>PortNum / Application:</span>
                      <span className="text-cyan-300 font-mono">{selectedPacket.portnum}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Application Payload Decoded */}
              <div className="border border-slate-800 rounded bg-[#0E1524]">
                <button
                  type="button"
                  onClick={() => toggleSection('payload')}
                  className="w-full flex items-center justify-between p-2 text-left text-slate-300 font-semibold hover:bg-slate-800/50"
                >
                  <span className="flex items-center gap-1 text-emerald-400">
                    {expandedSections.payload ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    Decoded Application Fields
                  </span>
                  <span className="text-[10px] text-slate-500">{selectedPacket.sizeBytes} bytes</span>
                </button>
                {expandedSections.payload && (
                  <div className="p-2.5 pt-0 text-[11px] text-slate-400 space-y-1">
                    {Object.keys(selectedPacket.decoded).length === 0 ? (
                      <div className="text-slate-500 italic">No structured payload fields available.</div>
                    ) : (
                      Object.entries(selectedPacket.decoded).map(([key, value]) => (
                        <div key={key} className="flex justify-between border-t border-slate-800/40 pt-1">
                          <span className="text-slate-400">{key}:</span>
                          <span className="text-emerald-300 font-bold truncate max-w-[200px]">
                            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Detail Pane 2: Raw Hex & JSON Inspector */}
        <div className="overflow-y-auto p-3 font-mono text-xs flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between pb-1 border-b border-slate-800 mb-2">
              <span>Raw Payload Inspector (Hex &amp; JSON)</span>
              {selectedPacket && (
                <button
                  onClick={handleCopyRaw}
                  className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 text-[10px]"
                >
                  {copiedRaw ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedRaw ? 'Copied' : 'Copy Raw'}</span>
                </button>
              )}
            </div>

            {!selectedPacket ? (
              <div className="text-slate-500 py-6 text-center">No packet selected.</div>
            ) : (
              <div className="space-y-2">
                <div className="p-2 bg-[#080C14] rounded border border-slate-800 text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {selectedPacket.raw}
                </div>

                <div className="p-2 bg-[#080C14] rounded border border-slate-800 text-[10px] text-cyan-300 overflow-x-auto">
                  <div className="text-slate-500 mb-1">// Parsed packet schema:</div>
                  <pre>{JSON.stringify(selectedPacket.decoded, null, 2)}</pre>
                </div>
              </div>
            )}
          </div>

          {selectedPacket && (
            <div className="mt-2 pt-2 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
              <span>Length: {selectedPacket.sizeBytes} bytes</span>
              <span className="text-slate-400 font-mono">CRC-16 OK · Mesh ACK Valid</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
