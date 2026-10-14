import React, { useState, useRef, useEffect } from 'react';
import { usePanelView } from './Panel';
import { Terminal, Send, Trash2, Copy, Check, ArrowDownCircle, Download } from 'lucide-react';

interface SerialTerminalProps {
  logs: string[];
  onClearLogs: () => void;
  onInjectLine: (line: string) => void;
}

export const SerialTerminal: React.FC<SerialTerminalProps> = ({
  logs,
  onClearLogs,
  onInjectLine,
}) => {
  // Fills the resizable body when its Panel is floating; fixed height when docked.
  const { floating } = usePanelView();
  const [inputVal, setInputVal] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputVal.trim()) return;
    onInjectLine(inputVal.trim());
    setInputVal('');
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(logs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadLogs = () => {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meshmap_serial_${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const samplePackets = [
    {
      name: 'Meshtastic Scaled JSON',
      val: '{"type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":45}}',
    },
    {
      name: 'Meshtastic Float JSON',
      val: '{"from":"!28a9df12","type":"position","lat":37.7772,"lon":-122.4178,"altitude":52}',
    },
    {
      name: 'NMEA $GPGGA',
      val: '$GPGGA,123519,3746.520,N,12225.140,W,1,08,0.9,54.2,M,0.0,M,,*42',
    },
    {
      name: 'Telemetry Power',
      val: '{"sender":"!28a9df12","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":88,"voltage":4.12,"channelUtilization":2.8,"airUtilTx":0.45}}}',
    },
    {
      name: 'Node Info',
      val: '{"from":"!28a9df12","type":"nodeinfo","payload":{"id":"!28a9df12","longName":"Tactical Base Station","shortName":"BASE","hwModel":"HELTEC_V3"}}',
    },
  ];

  const getLogLineStyle = (line: string) => {
    if (line.includes('✓ Parsed') || line.includes('Position Fix')) {
      return 'text-emerald-400 font-medium bg-emerald-950/25';
    }
    if (line.startsWith('$GP') || line.startsWith('$GN')) {
      return 'text-emerald-300 font-mono';
    }
    if (line.startsWith('{') || line.includes('"type":')) {
      return 'text-cyan-300 font-mono';
    }
    if (line.includes('Lora RX') || line.includes('INFO')) {
      return 'text-violet-300 font-mono';
    }
    if (line.includes('Error') || line.includes('Failed') || line.includes('Exception')) {
      return 'text-rose-400 bg-rose-950/30';
    }
    return 'text-slate-300';
  };

  return (
    <div
      className={`bg-slate-950 text-slate-200 flex flex-col overflow-hidden ${
        floating ? 'h-full min-h-[240px]' : 'h-[380px]'
      }`}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-200">Serial Stream Monitor</span>
          <span className="text-slate-600">·</span>
          <span className="font-mono text-[11px] text-slate-400">115200 8-N-1</span>
          <span className="text-slate-600">·</span>
          <span className="font-mono text-[11px] text-slate-400 tabular-nums">{logs.length} lines</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
              autoScroll
                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/80'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
            title="Toggle automatic scroll to bottom"
          >
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </button>

          <button
            onClick={handleCopy}
            className="p-1 hover:bg-slate-800 rounded-md text-slate-400 hover:text-white transition-colors"
            title="Copy all serial stream logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDownloadLogs}
            disabled={logs.length === 0}
            className="p-1 hover:bg-slate-800 rounded-md text-slate-400 hover:text-white transition-colors disabled:opacity-40"
            title="Download serial log file (.log)"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onClearLogs}
            className="p-1 hover:bg-slate-800 rounded-md text-slate-400 hover:text-rose-400 transition-colors"
            title="Clear terminal buffer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Log Output Window */}
      <div
        ref={scrollRef}
        className="flex-1 p-3 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-0.5 select-text selection:bg-blue-600 selection:text-white"
      >
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center py-8">
            <ArrowDownCircle className="w-6 h-6 mb-2 opacity-40 text-blue-400" />
            <p className="text-xs">Serial buffer idle. Connect to USB node or inject a test packet below.</p>
          </div>
        ) : (
          logs.map((log, index) => (
            <div
              key={index}
              className={`break-all py-0.5 px-1.5 rounded transition-colors ${getLogLineStyle(log)}`}
            >
              <span className="text-slate-600 select-none mr-2">{String(index + 1).padStart(4, ' ')}</span>
              {log}
            </div>
          ))
        )}
      </div>

      {/* Sample Quick Inject Bar */}
      <div className="px-3 py-1.5 bg-slate-900/80 border-t border-slate-800 flex items-center gap-1.5 overflow-x-auto text-[11px] shrink-0">
        <span className="text-slate-400 shrink-0 font-medium">Quick Inject:</span>
        {samplePackets.map((sample, idx) => (
          <button
            key={idx}
            onClick={() => onInjectLine(sample.val)}
            className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white shrink-0 border border-slate-700/80 transition-colors"
          >
            {sample.name}
          </button>
        ))}
      </div>

      {/* Input / Inject Line Form */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-2 bg-slate-900 border-t border-slate-800 shrink-0">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder="Paste raw serial line (e.g. $GPGGA,... or Meshtastic JSON) to parse..."
          className="flex-1 bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <button
          type="submit"
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Inject</span>
        </button>
      </form>
    </div>
  );
};
