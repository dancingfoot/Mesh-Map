import React, { useState, useRef, useEffect } from 'react';
import { NodeSummary } from '../utils/nodes';
import {
  Send,
  Radio,
  CheckCheck,
  Check,
  Clock,
  ShieldAlert,
  Hash,
  User,
  Sparkles,
  RefreshCw,
  MessageSquare,
} from 'lucide-react';

export interface ChatMessage {
  id: string;
  timestamp: string;
  channel: number; // 0 = primary/LongFast, 1 = admin/ops
  fromNodeId: string;
  fromName: string;
  fromColor?: string;
  toNodeId?: string; // empty if broadcast
  text: string;
  status: 'sent' | 'delivered' | 'acked' | 'relayed';
  hopCount: number;
  snr?: number;
}

interface MeshChatProps {
  messages: ChatMessage[];
  nodeSummaries: NodeSummary[];
  onSendMessage: (channel: number, text: string, toNodeId?: string) => void;
  isRadioConnected: boolean;
}

export const MeshChat: React.FC<MeshChatProps> = ({
  messages,
  nodeSummaries,
  onSendMessage,
  isRadioConnected,
}) => {
  const [selectedChannel, setSelectedChannel] = useState<number>(0);
  const [selectedDmNode, setSelectedDmNode] = useState<string | null>(null);
  const [inputText, setInputText] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const cannedTacticalMessages = [
    '10-4 Copy that, loud and clear',
    'Radio check / Signal report request',
    'Location beacon sent · Check map',
    'Stationary at checkpoint alpha',
    'Battery low on relay node · Returning',
    'All clear on mesh channel',
  ];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(selectedChannel, inputText.trim(), selectedDmNode || undefined);
    setInputText('');
  };

  const handleCannedClick = (msg: string) => {
    onSendMessage(selectedChannel, msg, selectedDmNode || undefined);
  };

  // Filter messages for current channel or DM
  const currentMessages = messages.filter((m) => {
    if (selectedDmNode) {
      return (
        (m.fromNodeId === selectedDmNode || m.toNodeId === selectedDmNode)
      );
    }
    return m.channel === selectedChannel && !m.toNodeId;
  });

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-140px)] min-h-[580px] bg-[#0A0F19] rounded-xl border border-slate-800/90 overflow-hidden shadow-2xl">
      {/* ── LEFT CHAT CHANNELS & DM SIDEBAR ── */}
      <div className="w-full md:w-64 bg-[#0E1524] border-b md:border-b-0 md:border-r border-slate-800/90 flex flex-col shrink-0">
        <div className="p-3 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-cyan-400" />
            <span className="font-bold text-xs tracking-wide text-slate-200">Mesh Channels</span>
          </div>
          <span className="text-[10px] font-mono text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/80">
            {isRadioConnected ? 'ONLINE' : 'SIM'}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {/* Public Channels */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 px-2 mb-1.5">
              Public Mesh Groups
            </div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedChannel(0);
                  setSelectedDmNode(null);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-mono transition-colors text-left ${
                  selectedChannel === 0 && !selectedDmNode
                    ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Hash className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="truncate">0: LongFast (Primary)</span>
                </div>
                <span className="text-[10px] text-slate-500 tabular-nums">
                  {messages.filter((m) => m.channel === 0 && !m.toNodeId).length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedChannel(1);
                  setSelectedDmNode(null);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-mono transition-colors text-left ${
                  selectedChannel === 1 && !selectedDmNode
                    ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Hash className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate">1: Tactical Ops</span>
                </div>
                <span className="text-[10px] text-slate-500 tabular-nums">
                  {messages.filter((m) => m.channel === 1 && !m.toNodeId).length}
                </span>
              </button>
            </div>
          </div>

          {/* Direct Node Messages */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 px-2 mb-1.5 flex items-center justify-between">
              <span>Direct Node DMs</span>
              <span>{nodeSummaries.length} nodes</span>
            </div>
            <div className="space-y-1">
              {nodeSummaries.length === 0 ? (
                <div className="text-[11px] text-slate-500 px-2 py-1 italic">No nodes detected</div>
              ) : (
                nodeSummaries.map((node) => {
                  const isSelected = selectedDmNode === node.key;
                  return (
                    <button
                      key={node.key}
                      type="button"
                      onClick={() => setSelectedDmNode(node.key)}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-mono transition-colors text-left ${
                        isSelected
                          ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 font-semibold'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm"
                          style={{ backgroundColor: node.color }}
                        />
                        <span className="truncate">{node.label}</span>
                      </div>
                      <span className="text-[9px] text-slate-500 font-mono truncate max-w-[60px]">
                        {node.key}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Radio Specs Footer */}
        <div className="p-2.5 bg-[#0A0F19] border-t border-slate-800/80 text-[10px] font-mono text-slate-500 flex items-center justify-between">
          <span>Payload limit: 237 bytes</span>
          <span className="text-cyan-400">ACK Enabled</span>
        </div>
      </div>

      {/* ── RIGHT CHAT STREAM & INPUT ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#090D16]">
        {/* Chat Header */}
        <div className="p-3 bg-[#101726] border-b border-slate-800/90 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-slate-100 flex items-center gap-1.5 font-mono">
              {selectedDmNode ? (
                <>
                  <User className="w-4 h-4 text-violet-400" />
                  <span>DM to {nodeSummaries.find((n) => n.key === selectedDmNode)?.label || selectedDmNode}</span>
                </>
              ) : (
                <>
                  <Hash className="w-4 h-4 text-cyan-400" />
                  <span>Channel {selectedChannel}: {selectedChannel === 0 ? 'LongFast (Primary Mesh)' : 'Tactical Ops'}</span>
                </>
              )}
            </span>
          </div>

          <div className="text-[11px] font-mono text-slate-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>LoRa 915MHz Broadcast</span>
          </div>
        </div>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
          {currentMessages.length === 0 ? (
            <div className="py-20 text-center text-slate-500 space-y-2">
              <Radio className="w-8 h-8 text-cyan-500/40 mx-auto" />
              <p>No messages in this channel yet.</p>
              <p className="text-[11px] text-slate-600">
                Send a tactical message below or click a canned response to broadcast across the mesh network.
              </p>
            </div>
          ) : (
            currentMessages.map((msg) => {
              const isMine = msg.fromNodeId === 'local' || msg.fromNodeId === '!local';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isMine ? 'items-end' : 'items-start'} space-y-1`}
                >
                  <div className="flex items-center gap-2 text-[10px] text-slate-400">
                    <span
                      className="font-bold px-1.5 py-0.2 rounded"
                      style={{
                        backgroundColor: msg.fromColor ? `${msg.fromColor}22` : '#1e293b',
                        color: msg.fromColor || '#38bdf8',
                      }}
                    >
                      {msg.fromName}
                    </span>
                    <span className="tabular-nums">{msg.timestamp}</span>
                    <span className="text-slate-600 font-mono">
                      {msg.hopCount === 0 ? 'Direct (0 hops)' : `${msg.hopCount} hop(s)`}
                    </span>
                    {msg.snr != null && (
                      <span className="text-emerald-500 font-mono">+{msg.snr}dB</span>
                    )}
                  </div>

                  <div
                    className={`max-w-[85%] sm:max-w-[70%] p-3 rounded-xl border leading-relaxed ${
                      isMine
                        ? 'bg-blue-600/20 text-blue-100 border-blue-500/40 rounded-tr-none'
                        : 'bg-[#121B2C] text-slate-200 border-slate-700/80 rounded-tl-none'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>

                  {/* Delivery status */}
                  <div className="flex items-center gap-1 text-[9px] text-slate-500">
                    {msg.status === 'acked' && (
                      <>
                        <CheckCheck className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400">Mesh ACK confirmed</span>
                      </>
                    )}
                    {msg.status === 'delivered' && (
                      <>
                        <Check className="w-3 h-3 text-cyan-400" />
                        <span className="text-cyan-400">Delivered</span>
                      </>
                    )}
                    {msg.status === 'relayed' && (
                      <>
                        <RefreshCw className="w-3 h-3 text-amber-400 animate-spin" />
                        <span className="text-amber-400">Relaying via repeater</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Canned Quick Actions Bar */}
        <div className="px-3 py-2 bg-[#0C121E] border-t border-slate-800/80 flex items-center gap-1.5 overflow-x-auto text-[11px] font-mono shrink-0">
          <span className="text-slate-500 text-[10px] shrink-0 uppercase tracking-wider flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-cyan-400" />
            Quick:
          </span>
          {cannedTacticalMessages.map((canned, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleCannedClick(canned)}
              className="px-2 py-1 rounded bg-[#131D2E] hover:bg-[#1C2B42] text-slate-300 hover:text-cyan-300 border border-slate-700/60 whitespace-nowrap transition-colors"
            >
              {canned}
            </button>
          ))}
        </div>

        {/* Message Input Form */}
        <form
          onSubmit={handleSend}
          className="p-3 bg-[#101726] border-t border-slate-800/90 flex items-center gap-2"
        >
          <div className="flex-1 relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                selectedDmNode
                  ? `Direct message to ${selectedDmNode}...`
                  : `Broadcast to Channel ${selectedChannel} (LongFast)...`
              }
              maxLength={237}
              className="w-full pl-3 pr-14 py-2 bg-[#090D16] border border-slate-800 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-600">
              {237 - inputText.length}
            </span>
          </div>

          <button
            type="submit"
            disabled={!inputText.trim()}
            className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600 text-white font-mono text-xs font-bold rounded-lg transition-colors shadow-sm shadow-cyan-900/30 shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Transmit</span>
          </button>
        </form>
      </div>
    </div>
  );
};
