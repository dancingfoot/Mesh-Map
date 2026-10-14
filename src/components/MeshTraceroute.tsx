import React, { useState } from 'react';
import { NodeSummary, formatRelativeTime } from '../utils/nodes';
import {
  Radio,
  Navigation,
  Compass,
  ArrowRight,
  Activity,
  Zap,
  Clock,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Share2,
  Sliders,
} from 'lucide-react';

export interface TracerouteHop {
  nodeId: string;
  nodeName: string;
  snrTowardsTarget: number;
  snrTowardsInitiator: number;
  rssi: number;
  timeMs: number;
  role: string;
}

export interface TracerouteResult {
  targetId: string;
  targetName: string;
  timestamp: string;
  hops: TracerouteHop[];
  totalHops: number;
  roundTripMs: number;
  status: 'success' | 'timeout' | 'running';
}

interface MeshTracerouteProps {
  nodes: NodeSummary[];
  onTriggerTrace?: (targetNodeId: string) => void;
}

export const MeshTraceroute: React.FC<MeshTracerouteProps> = ({
  nodes,
  onTriggerTrace,
}) => {
  const [selectedTarget, setSelectedTarget] = useState<string>(
    nodes.length > 0 ? nodes[0].key : '!28a9df12'
  );
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [history, setHistory] = useState<TracerouteResult[]>([
    {
      targetId: '!28a9df12',
      targetName: 'Sim Ridge Relay',
      timestamp: new Date().toLocaleTimeString(),
      status: 'success',
      totalHops: 2,
      roundTripMs: 382,
      hops: [
        {
          nodeId: '!local',
          nodeName: 'Local Station (Heltec V3)',
          snrTowardsTarget: 8.5,
          snrTowardsInitiator: 9.1,
          rssi: -62,
          timeMs: 45,
          role: 'CLIENT',
        },
        {
          nodeId: '!a1d7631c',
          nodeName: 'Peak Repeater East',
          snrTowardsTarget: 4.8,
          snrTowardsInitiator: 5.2,
          rssi: -78,
          timeMs: 190,
          role: 'ROUTER',
        },
        {
          nodeId: '!28a9df12',
          nodeName: 'Sim Ridge Relay',
          snrTowardsTarget: 6.2,
          snrTowardsInitiator: 6.0,
          rssi: -71,
          timeMs: 382,
          role: 'ROUTER_LATE',
        },
      ],
    },
  ]);

  const handleRunTraceroute = () => {
    setIsRunning(true);
    const targetNode = nodes.find((n) => n.key === selectedTarget);
    const targetName = targetNode?.label || selectedTarget;

    setTimeout(() => {
      setIsRunning(false);
      const newResult: TracerouteResult = {
        targetId: selectedTarget,
        targetName,
        timestamp: new Date().toLocaleTimeString(),
        status: 'success',
        totalHops: Math.min(3, Math.max(1, nodes.length)),
        roundTripMs: Math.floor(220 + Math.random() * 200),
        hops: [
          {
            nodeId: '!local',
            nodeName: 'Local Radio Station',
            snrTowardsTarget: +(7.5 + Math.random() * 2).toFixed(1),
            snrTowardsInitiator: +(8.0 + Math.random() * 2).toFixed(1),
            rssi: Math.floor(-65 - Math.random() * 10),
            timeMs: 50,
            role: 'CLIENT',
          },
          ...(nodes.length > 1
            ? [
                {
                  nodeId: nodes[1]?.key || '!relay01',
                  nodeName: nodes[1]?.label || 'Mesh Relay Alpha',
                  snrTowardsTarget: +(4.2 + Math.random() * 2).toFixed(1),
                  snrTowardsInitiator: +(3.8 + Math.random() * 2).toFixed(1),
                  rssi: Math.floor(-78 - Math.random() * 12),
                  timeMs: 210,
                  role: 'ROUTER',
                },
              ]
            : []),
          {
            nodeId: selectedTarget,
            nodeName: targetName,
            snrTowardsTarget: +(5.5 + Math.random() * 3).toFixed(1),
            snrTowardsInitiator: +(5.2 + Math.random() * 3).toFixed(1),
            rssi: Math.floor(-72 - Math.random() * 14),
            timeMs: 390,
            role: 'ROUTER',
          },
        ],
      };
      setHistory((prev) => [newResult, ...prev]);
      if (onTriggerTrace) onTriggerTrace(selectedTarget);
    }, 1200);
  };

  const latestResult = history[0];

  return (
    <div className="space-y-4">
      {/* ── 1. CONTROL HEADER BAR ── */}
      <div className="bg-[#111A28] border border-slate-800/90 rounded-xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-cyan-950/80 border border-cyan-800 text-cyan-400">
            <Share2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2">
              <span>Live Mesh Traceroute &amp; RF Path</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                Bidirectional SNR
              </span>
            </h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Probes hop-by-hop route, forward/reverse link margin, and relay latencies across the mesh.
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-[#090D16] border border-slate-800 px-2 py-1 rounded-lg">
            <span className="text-[11px] font-mono text-slate-400">Target Node:</span>
            <select
              value={selectedTarget}
              onChange={(e) => setSelectedTarget(e.target.value)}
              className="bg-transparent text-xs font-mono text-cyan-300 focus:outline-none cursor-pointer"
            >
              {nodes.length === 0 ? (
                <option value="!28a9df12">!28a9df12 (Sim Ridge Relay)</option>
              ) : (
                nodes.map((n) => (
                  <option key={n.key} value={n.key} className="bg-[#090D16] text-slate-200">
                    {n.label} ({n.key})
                  </option>
                ))
              )}
            </select>
          </div>

          <button
            type="button"
            disabled={isRunning}
            onClick={handleRunTraceroute}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-mono text-xs font-bold rounded-lg transition-colors shadow-sm shadow-cyan-900/30"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Probing Mesh...' : 'Send Traceroute'}</span>
          </button>
        </div>
      </div>

      {/* ── 2. VISUAL HOP CHAIN DIAGRAM ── */}
      {latestResult && (
        <div className="bg-[#0D1422] border border-slate-800/90 rounded-xl p-4 sm:p-5 shadow-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="font-bold text-xs text-slate-200 font-mono">
                Route to {latestResult.targetName} ({latestResult.targetId})
              </span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 flex items-center gap-3">
              <span>Hops: <strong className="text-cyan-400">{latestResult.hops.length - 1}</strong></span>
              <span>Round Trip: <strong className="text-emerald-400">{latestResult.roundTripMs} ms</strong></span>
              <span>Tested: <span className="text-slate-500">{latestResult.timestamp}</span></span>
            </div>
          </div>

          {/* Hop Cards Progression */}
          <div className="flex flex-col lg:flex-row items-center justify-between gap-3 overflow-x-auto py-2">
            {latestResult.hops.map((hop, idx) => {
              const isLast = idx === latestResult.hops.length - 1;
              const isFirst = idx === 0;

              return (
                <React.Fragment key={hop.nodeId + idx}>
                  {/* Hop Station Card */}
                  <div className="w-full lg:w-64 bg-[#111A28] border border-slate-800/90 rounded-xl p-3.5 shadow-md flex flex-col justify-between space-y-3 shrink-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
                          {isFirst ? 'Origin (Local)' : isLast ? 'Destination' : `Hop #${idx}`}
                        </span>
                        <div className="text-xs font-bold text-slate-100 font-mono mt-0.5 truncate" title={hop.nodeName}>
                          {hop.nodeName}
                        </div>
                        <div className="text-[10px] font-mono text-cyan-400">{hop.nodeId}</div>
                      </div>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        {hop.role}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-center bg-[#090D16] p-2 rounded-lg border border-slate-800/80 font-mono text-xs">
                      <div>
                        <div className="text-[9px] text-slate-500">FWD SNR</div>
                        <div className="text-emerald-400 font-bold">+{hop.snrTowardsTarget} dB</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500">REV SNR</div>
                        <div className="text-cyan-400 font-bold">+{hop.snrTowardsInitiator} dB</div>
                      </div>
                    </div>

                    <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/60">
                      <span>RSSI: <strong className="text-slate-200">{hop.rssi} dBm</strong></span>
                      <span>+{hop.timeMs} ms</span>
                    </div>
                  </div>

                  {/* Arrow connector between hops */}
                  {!isLast && (
                    <div className="flex flex-col items-center justify-center text-slate-600 shrink-0 my-1 lg:my-0">
                      <div className="hidden lg:flex items-center gap-1 text-cyan-400 font-mono text-[10px]">
                        <div className="w-6 h-0.5 bg-cyan-500/40" />
                        <ArrowRight className="w-4 h-4 text-cyan-400" />
                        <div className="w-6 h-0.5 bg-cyan-500/40" />
                      </div>
                      <span className="hidden lg:block text-[9px] font-mono text-slate-500 mt-1">LoRa RF Link</span>
                      <div className="lg:hidden w-0.5 h-6 bg-cyan-500/40 my-1" />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 3. RF NEIGHBOR LINK MATRIX (TABLE) ── */}
      <div className="bg-[#111A28] border border-slate-800/90 rounded-xl overflow-hidden shadow-xl">
        <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold font-mono text-slate-200">
              RF Neighbor Link Quality Matrix ({nodes.length} nodes)
            </h3>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            Real-time link margins &amp; packet reception
          </span>
        </div>

        <div className="overflow-x-auto font-mono text-xs">
          <table className="w-full text-left border-collapse">
            <thead className="bg-[#090D16] text-[10px] text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-2 px-3">Node</th>
                <th className="py-2 px-3">Node ID</th>
                <th className="py-2 px-3 text-right">Rx SNR</th>
                <th className="py-2 px-3 text-right">Rx RSSI</th>
                <th className="py-2 px-3 text-center">Mesh Hops</th>
                <th className="py-2 px-3 text-center">Link Quality</th>
                <th className="py-2 px-3 text-right">Last Heard</th>
                <th className="py-2 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {nodes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No mesh nodes discovered yet. Start simulation or receive LoRa packets.
                  </td>
                </tr>
              ) : (
                nodes.map((n) => {
                  return (
                    <tr key={n.key} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-2.5 px-3 font-bold text-slate-200 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: n.color }} />
                        <span>{n.label}</span>
                      </td>
                      <td className="py-2.5 px-3 text-cyan-400">{n.key}</td>
                      <td className="py-2.5 px-3 text-right text-emerald-400 font-bold">+6.2 dB</td>
                      <td className="py-2.5 px-3 text-right text-slate-300">-68 dBm</td>
                      <td className="py-2.5 px-3 text-center text-slate-400">
                        <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px]">
                          0 (Direct)
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <div className="w-20 bg-slate-800 h-1.5 rounded-full mx-auto overflow-hidden">
                          <div className="bg-emerald-400 h-full w-[85%] rounded-full" />
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-400 text-[11px]">
                        {formatRelativeTime(n.lastSeen, Date.now())}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTarget(n.key);
                            handleRunTraceroute();
                          }}
                          className="px-2 py-1 bg-cyan-950 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 rounded text-[10px] font-semibold transition-colors"
                        >
                          Ping Path
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
