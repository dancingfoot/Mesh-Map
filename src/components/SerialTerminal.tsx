import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Trash2, Copy, Check, ArrowDownCircle } from 'lucide-react';

interface SerialTerminalProps {
  logs: string[];
  onClearLogs: () => void;
  onInjectLine: (line: string) => void;
  connectionStatus: string;
}

export const SerialTerminal: React.FC<SerialTerminalProps> = ({
  logs,
  onClearLogs,
  onInjectLine,
  connectionStatus,
}) => {
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
      name: 'NMEA $GPRMC',
      val: '$GPRMC,123519,A,3746.540,N,12225.120,W,012.4,084.2,280926,,,A*65',
    },
  ];

  return (
    <div className="bg-slate-950 text-slate-200 rounded-xl border border-slate-800 shadow-sm flex flex-col h-[380px] overflow-hidden">
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-200">Serial Stream Monitor</span>
          <span className="text-slate-500">·</span>
          <span className="font-mono text-[11px] text-slate-400">115200 8-N-1</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              autoScroll
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                : 'text-slate-400 hover:text-white'
            }`}
            title="Auto-scroll"
          >
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </button>

          <button
            onClick={handleCopy}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors"
            title="Copy all logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={onClearLogs}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors"
            title="Clear terminal log"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Log Output Window */}
      <div
        ref={scrollRef}
        className="flex-1 p-3 overflow-y-auto font-mono text-xs leading-relaxed space-y-1 select-text selection:bg-blue-600 selection:text-white"
      >
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center py-8">
            <ArrowDownCircle className="w-6 h-6 mb-2 opacity-50" />
            <p>Serial buffer empty. Connect to serial port or inject a test packet below.</p>
          </div>
        ) : (
          logs.map((log, index) => {
            const isGpsMatch = log.includes('✓ Parsed') || log.includes('Position Fix');
            const isError = log.includes('Error') || log.includes('Failed');
            return (
              <div
                key={index}
                className={`break-all py-0.5 px-1.5 rounded ${
                  isGpsMatch
                    ? 'text-emerald-300 bg-emerald-950/20 font-medium'
                    : isError
                    ? 'text-rose-300 bg-rose-950/20'
                    : 'text-slate-300'
                }`}
              >
                {log}
              </div>
            );
          })
        )}
      </div>

      {/* Sample Quick Inject Bar */}
      <div className="px-3 py-1.5 bg-slate-900/60 border-t border-slate-800/80 flex items-center gap-1.5 overflow-x-auto text-[11px]">
        <span className="text-slate-400 shrink-0 font-medium">Quick Inject:</span>
        {samplePackets.map((sample, idx) => (
          <button
            key={idx}
            onClick={() => onInjectLine(sample.val)}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white shrink-0 border border-slate-700 transition-colors"
          >
            {sample.name}
          </button>
        ))}
      </div>

      {/* Input / Inject Line Form */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-2 bg-slate-900 border-t border-slate-800">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder="Paste raw serial line (e.g. $GPGGA,... or Meshtastic JSON) to parse..."
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <button
          type="submit"
          className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Inject</span>
        </button>
      </form>
    </div>
  );
};
