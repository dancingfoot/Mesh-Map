import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Cable,
  CircleSlash,
  Gauge,
  ListPlus,
  Music,
  Plug,
  Radio,
  RefreshCw,
  Send,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import {
  OSC_MAX_INTERVAL_MS,
  OSC_MAX_QUEUE,
  OSC_MAX_TIMEOUT_MS,
  OSC_MIN_INTERVAL_MS,
  OSC_MIN_QUEUE,
  OSC_MIN_TIMEOUT_MS,
  buildNodeMessages,
  normalisePrefix,
  type OscClientConfig,
  type OscHealth,
  type OscStats,
} from '../utils/oscClient';
import {
  MIDI_CHANNELS,
  availableMetrics,
  configure as configureMidi,
  createRule,
  getStatus,
  isWebMidiSupported,
  panic as midiPanic,
  refreshPorts,
  ruleToMidiBytes,
  scaleToMidi,
  scaleToMidi14,
  to14BitPair,
  type MidiConfig,
  type MidiRule,
  type MidiStatus,
} from '../utils/midi';
import { oscClient, checkOscHealth, sendOscTestMessage, freshPositionNodeIds } from '../utils/outputs';
import type { NodeTelemetry } from '../utils/telemetry';
import { formatMetricValue } from '../utils/telemetryMetrics';
import { formatRelativeTime } from '../utils/nodes';

/** How much of an address list the preview renders before it says "and N more". */
const PREVIEW_LIMIT = 40;

interface OutputsPanelProps {
  oscConfig: OscClientConfig;
  onOscConfigChange: (next: OscClientConfig) => void;
  midiConfig: MidiConfig;
  onMidiConfigChange: (next: MidiConfig) => void;
  /** Per-node roll-up of every captured sample (source of the metric preview). */
  nodeSummaries: NodeTelemetry[];
  /** Every metric name seen so far (plus the defaults) for the rule dropdown. */
  seenMetrics: string[];
}

/** A small labelled text/number field used by both sections. */
const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ label, hint, children, className = '' }) => (
  <label className={`flex flex-col gap-1 ${className}`}>
    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-slate-400 leading-snug">{hint}</span>}
  </label>
);

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-200 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 disabled:bg-slate-800';

const selectClass = inputClass + ' cursor-pointer';

const buttonClass =
  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

const primaryButton = `${buttonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700 disabled:hover:bg-blue-600`;
const secondaryButton = `${buttonClass} border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800`;

/** Green/amber/rose chip used for status lines. */
const StatusChip: React.FC<{ tone: 'ok' | 'warn' | 'bad' | 'idle'; children: React.ReactNode }> = ({
  tone,
  children,
}) => {
  const tones: Record<typeof tone, string> = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    bad: 'border-rose-200 bg-rose-50 text-rose-800',
    idle: 'border-slate-800 bg-slate-950 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
};

/** One line of the OSC address preview. */
const PreviewRow: React.FC<{ address: string; args: string; kind: string; muted?: boolean }> = ({
  address,
  args,
  kind,
  muted = false,
}) => (
  <div
    className={`flex items-baseline gap-2 px-2 py-1 border-b border-slate-800 last:border-b-0 ${
      muted ? 'opacity-60' : ''
    }`}
  >
    <span className="text-[9px] font-mono uppercase text-slate-400 w-14 shrink-0">{kind}</span>
    <span className="font-mono text-[11px] text-slate-200 break-all">{address}</span>
    <span className="ml-auto font-mono text-[11px] text-blue-700 shrink-0">{args}</span>
  </div>
);

/** Reads `args` back into a compact display string. */
function formatArgs(args: Array<number | string | boolean>): string {
  if (args.length === 0) return '(no args)';
  return args
    .map((arg) => {
      if (typeof arg === 'string') return `"${arg}"`;
      if (typeof arg === 'boolean') return arg ? 'true' : 'false';
      return Number.isInteger(arg) ? String(arg) : arg.toFixed(3);
    })
    .join(', ');
}

/**
 * "Outputs" tab: emit the captured telemetry to music/visual software.
 *
 * Two independent sections:
 *  - **OSC** → the local bridge (`bridge/osc-bridge.mjs`) forwards OSC over UDP.
 *  - **MIDI** → Web MIDI API straight to an OS port, including QMidiNet /
 *    RTP-MIDI virtual ports, which appear in the port list like any other.
 *
 * Both degrade to a plain explanatory message when the bridge is down or the
 * browser has no Web MIDI, so the tab is never a dead end.
 */
export const OutputsPanel: React.FC<OutputsPanelProps> = ({
  oscConfig,
  onOscConfigChange,
  midiConfig,
  onMidiConfigChange,
  nodeSummaries,
  seenMetrics,
}) => {
  // ---------------------------------------------------------------- OSC state
  const [oscStats, setOscStats] = useState<OscStats>(() => oscClient.getStats());
  const [health, setHealth] = useState<OscHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string>('');

  // Subscribe to the client's counters (the client also emits after every flush).
  useEffect(() => {
    const unsubscribe = oscClient.subscribe(setOscStats);
    const timer = window.setInterval(() => setOscStats(oscClient.getStats()), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  const previewNode = useMemo(() => {
    if (nodeSummaries.length === 0) return null;
    return (
      nodeSummaries.find((node) => node.nodeId === previewNodeId) ??
      nodeSummaries.find((node) => node.nodeId !== 'local') ??
      nodeSummaries[0]
    );
  }, [nodeSummaries, previewNodeId]);

  const previewMessages = useMemo(
    () => (previewNode ? buildNodeMessages(previewNode.nodeId, previewNode.latest, oscConfig.prefix) : []),
    [previewNode, oscConfig.prefix]
  );

  const freshNodes = useMemo(() => new Set(freshPositionNodeIds()), []);

  const metricOptions = useMemo(() => availableMetrics(seenMetrics), [seenMetrics]);

  const handleHealthCheck = useCallback(() => {
    setHealthBusy(true);
    void checkOscHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, sent: null, oscTarget: null, uptime: null, error: 'health check failed' }))
      .finally(() => setHealthBusy(false));
  }, []);

  const handleSendTest = useCallback(() => {
    setTestBusy(true);
    setTestNote(null);
    void sendOscTestMessage()
      .then((result) => {
        setTestNote(
          result.ok
            ? `Bridge accepted ${result.sent} test message${result.sent === 1 ? '' : 's'}.`
            : result.error ?? 'test message failed'
        );
      })
      .catch(() => setTestNote('test message failed'))
      .finally(() => setTestBusy(false));
  }, []);

  // --------------------------------------------------------------- MIDI state
  const [midiStatus, setMidiStatus] = useState<MidiStatus>(() => getStatus(midiConfig));
  const [midiBusy, setMidiBusy] = useState(false);
  const [midiNote, setMidiNote] = useState<string | null>(null);
  const statusRequestRef = useRef(0);

  const refreshMidi = useCallback(
    (config: MidiConfig) => {
      const requestId = ++statusRequestRef.current;
      setMidiBusy(true);
      // `getStatus` covers the unsupported/idle cases synchronously; `refreshPorts`
      // is only meaningful when the Web MIDI API exists.
      const pending: Promise<MidiStatus> = isWebMidiSupported()
        ? refreshPorts(config)
        : Promise.resolve(getStatus(config));
      void pending
        .then((status) => {
          if (requestId === statusRequestRef.current) setMidiStatus(status);
        })
        .catch(() =>
          setMidiStatus({
            ...getStatus(config),
            code: 'error',
            message: 'Could not enumerate MIDI ports.',
          })
        )
        .finally(() => {
          if (requestId === statusRequestRef.current) setMidiBusy(false);
        });
    },
    []
  );

  // Enumerate once on mount when MIDI is already enabled, and again whenever the
  // config changes (enable toggle / port choice / rule edits keep the UI in sync).
  useEffect(() => {
    if (!midiConfig.enabled) {
      setMidiStatus(getStatus(midiConfig));
      return;
    }
    refreshMidi(midiConfig);
  }, [midiConfig, refreshMidi]);

  // Keep the pending-note counter honest without a full port refresh.
  useEffect(() => {
    const timer = window.setInterval(() => setMidiStatus(getStatus(midiConfig)), 1500);
    return () => window.clearInterval(timer);
  }, [midiConfig]);

  const handleMidiConfigure = useCallback(
    (patch: Partial<MidiConfig>) => {
      const next: MidiConfig = { ...midiConfig, ...patch };
      onMidiConfigChange(next);
      void configureMidi(next)
        .then(setMidiStatus)
        .catch(() => setMidiStatus(getStatus(next)));
    },
    [midiConfig, onMidiConfigChange]
  );

  const handlePanic = useCallback(() => {
    const outcome = midiPanic();
    setMidiNote(
      outcome.skipped
        ? `Panic could not send: ${outcome.skipped}`
        : `Sent ${outcome.sent} all-notes-off / reset messages.`
    );
  }, []);

  const updateRule = useCallback(
    (id: string, patch: Partial<MidiRule>) => {
      handleMidiConfigure({
        rules: midiConfig.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      });
    },
    [handleMidiConfigure, midiConfig.rules]
  );

  const removeRule = useCallback(
    (id: string) => {
      handleMidiConfigure({ rules: midiConfig.rules.filter((rule) => rule.id !== id) });
    },
    [handleMidiConfigure, midiConfig.rules]
  );

  const addRule = useCallback(() => {
    const used = new Set(midiConfig.rules.map((rule) => rule.metric));
    const nextMetric = metricOptions.find((metric) => !used.has(metric)) ?? 'batteryLevel';
    handleMidiConfigure({ rules: [...midiConfig.rules, createRule(nextMetric)] });
  }, [handleMidiConfigure, midiConfig.rules, metricOptions]);

  const oscTone: 'ok' | 'warn' | 'bad' | 'idle' = !oscConfig.enabled
    ? 'idle'
    : oscStats.failed > 0 && oscStats.lastSuccessAt === null
    ? 'bad'
    : oscStats.pending > 0
    ? 'warn'
    : 'ok';

  const midiTone: 'ok' | 'warn' | 'bad' | 'idle' =
    midiStatus.code === 'ready'
      ? 'ok'
      : midiStatus.code === 'unsupported' || midiStatus.code === 'no-ports'
      ? 'warn'
      : midiStatus.code === 'denied' || midiStatus.code === 'error'
      ? 'bad'
      : 'idle';

  return (
    <div className="flex flex-col min-h-0">
      <div className="p-4 space-y-6">
        {/* ------------------------------------------------------------ OSC */}
        <section className="rounded-xl border border-slate-800 overflow-hidden">
          <header className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-950 border-b border-slate-800">
            <Radio className="w-3.5 h-3.5 text-blue-600" />
            <h3 className="text-xs font-semibold text-slate-200">OSC output</h3>
            <span className="text-[10px] font-mono text-slate-400">
              browser → bridge (HTTP) → OSC 1.0 (UDP)
            </span>
            <div className="ml-auto flex items-center gap-2">
              <StatusChip tone={oscTone}>
                {oscConfig.enabled ? 'enabled' : 'disabled'} · {oscStats.sent} sent
              </StatusChip>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={oscConfig.enabled}
                  onChange={(event) => onOscConfigChange({ ...oscConfig, enabled: event.target.checked })}
                />
                Enable
              </label>
            </div>
          </header>

          <div className="p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <Field label="Bridge URL" hint="Where osc-bridge.mjs listens (HTTP + WS)." className="xl:col-span-1">
                <input
                  type="text"
                  className={inputClass}
                  value={oscConfig.url}
                  spellCheck={false}
                  onChange={(event) => onOscConfigChange({ ...oscConfig, url: event.target.value })}
                  placeholder="http://127.0.0.1:9000"
                />
              </Field>

              <Field
                label="OSC target host"
                hint="Where the bridge sends UDP. Pushed to the bridge when it changes."
              >
                <input
                  type="text"
                  className={inputClass}
                  value={oscConfig.targetHost}
                  spellCheck={false}
                  onChange={(event) =>
                    onOscConfigChange({ ...oscConfig, targetHost: event.target.value })
                  }
                  placeholder="127.0.0.1"
                />
              </Field>

              <Field
                label="OSC target port"
                hint="Must match your receiver — SuperCollider defaults to 57120."
              >
                <input
                  type="number"
                  min={0}
                  max={65535}
                  className={inputClass}
                  value={oscConfig.targetPort}
                  onChange={(event) =>
                    onOscConfigChange({ ...oscConfig, targetPort: Number(event.target.value) })
                  }
                  placeholder="57120"
                />
              </Field>

              <Field label="Address prefix" hint={`Preview: ${normalisePrefix(oscConfig.prefix)}/node/<id>/<metric>`}>
                <input
                  type="text"
                  className={inputClass}
                  value={oscConfig.prefix}
                  spellCheck={false}
                  onChange={(event) => onOscConfigChange({ ...oscConfig, prefix: event.target.value })}
                  placeholder="/mesh"
                />
              </Field>

              <Field label="Batch interval (ms)" hint="At most one HTTP request per interval.">
                <input
                  type="number"
                  className={inputClass}
                  min={OSC_MIN_INTERVAL_MS}
                  max={OSC_MAX_INTERVAL_MS}
                  step={5}
                  value={oscConfig.intervalMs}
                  onChange={(event) =>
                    onOscConfigChange({ ...oscConfig, intervalMs: Number(event.target.value) })
                  }
                />
              </Field>

              <Field label="Queue cap / timeout" hint={`Max ${OSC_MIN_QUEUE}–${OSC_MAX_QUEUE} messages, ${OSC_MIN_TIMEOUT_MS}–${OSC_MAX_TIMEOUT_MS} ms.`}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    className={inputClass}
                    min={OSC_MIN_QUEUE}
                    max={OSC_MAX_QUEUE}
                    step={50}
                    value={oscConfig.maxQueue}
                    onChange={(event) =>
                      onOscConfigChange({ ...oscConfig, maxQueue: Number(event.target.value) })
                    }
                  />
                  <input
                    type="number"
                    className={inputClass}
                    min={OSC_MIN_TIMEOUT_MS}
                    max={OSC_MAX_TIMEOUT_MS}
                    step={100}
                    value={oscConfig.timeoutMs}
                    onChange={(event) =>
                      onOscConfigChange({ ...oscConfig, timeoutMs: Number(event.target.value) })
                    }
                  />
                </div>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={secondaryButton} onClick={handleHealthCheck} disabled={healthBusy}>
                <Stethoscope className="w-3.5 h-3.5" />
                {healthBusy ? 'Checking…' : 'Health check'}
              </button>
              <button type="button" className={secondaryButton} onClick={handleSendTest} disabled={testBusy}>
                <Send className="w-3.5 h-3.5" />
                {testBusy ? 'Sending…' : 'Send test message'}
              </button>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => oscClient.resetStats()}
                title="Clear the counters below"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reset counters
              </button>
            </div>

            {testNote && <p className="text-[11px] text-slate-400">{testNote}</p>}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Counters */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Gauge className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-[11px] font-semibold text-slate-300">Live counters</span>
                </div>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                  <Counter label="Messages sent" value={oscStats.sent} tone="ok" />
                  <Counter label="Failures" value={oscStats.failed} tone={oscStats.failed > 0 ? 'bad' : 'idle'} />
                  <Counter label="Dropped (queue full)" value={oscStats.dropped} tone={oscStats.dropped > 0 ? 'warn' : 'idle'} />
                  <Counter label="Queued now" value={oscStats.pending} tone={oscStats.pending > 0 ? 'warn' : 'idle'} />
                  <Counter label="Last batch" value={oscStats.lastBatchSize} tone="idle" />
                  <Counter label="Queued total" value={oscStats.queued} tone="idle" />
                </dl>
                <p className="mt-2 text-[10px] text-slate-400 break-all">
                  Last success: {oscStats.lastSuccessAt ? new Date(oscStats.lastSuccessAt).toLocaleTimeString() : 'never'}
                </p>
                {oscStats.lastError && (
                  <p className="mt-1 text-[10px] text-rose-600 break-all flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>Last error: {oscStats.lastError}</span>
                  </p>
                )}
                {!oscConfig.enabled && (
                  <p className="mt-2 text-[10px] text-slate-400">
                    OSC is disabled, so nothing is queued. Tick <strong>Enable</strong> to start forwarding
                    telemetry.
                  </p>
                )}
              </div>

              {/* Health */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Stethoscope className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-[11px] font-semibold text-slate-300">Bridge health</span>
                </div>
                {health === null ? (
                  <p className="text-[11px] text-slate-400">
                    Press <strong>Health check</strong> to read <code className="font-mono">GET /health</code>{' '}
                    from the bridge. If it is not running, start it with{' '}
                    <code className="font-mono">npm run bridge</code> (default{' '}
                    <code className="font-mono">127.0.0.1:9000</code>).
                  </p>
                ) : health.ok ? (
                  <div className="space-y-1 text-[11px]">
                    <StatusChip tone="ok">
                      <Activity className="w-3 h-3" /> ok
                    </StatusChip>
                    <p className="font-mono text-slate-300 break-all">oscTarget: {health.oscTarget ?? 'unknown'}</p>
                    <p className="font-mono text-slate-300">sent by bridge: {health.sent ?? 'unknown'}</p>
                    {health.uptime !== null && (
                      <p className="font-mono text-slate-400">uptime: {health.uptime.toFixed(1)} s</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <StatusChip tone="bad">
                      <CircleSlash className="w-3 h-3" /> unreachable
                    </StatusChip>
                    <p className="text-[11px] text-slate-400 break-all">{health.error}</p>
                    <p className="text-[10px] text-slate-400">
                      Start it with{' '}
                      <code className="font-mono">
                        npm run bridge -- --listen 9000 --osc-port 57120 --verbose
                      </code>
                      .
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Address preview */}
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-950 border-b border-slate-800">
                <Cable className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[11px] font-semibold text-slate-300">
                  OSC addresses for the selected node
                </span>
                <select
                  className={`${selectClass} ml-auto max-w-[220px]`}
                  value={previewNode?.nodeId ?? ''}
                  onChange={(event) => setPreviewNodeId(event.target.value)}
                  disabled={nodeSummaries.length === 0}
                >
                  {nodeSummaries.length === 0 && <option value="">no nodes yet</option>}
                  {nodeSummaries.map((node) => (
                    <option key={node.nodeId} value={node.nodeId}>
                      {node.nodeId} ({node.sampleCount} samples)
                    </option>
                  ))}
                </select>
              </div>

              {previewNode === null ? (
                <p className="p-3 text-[11px] text-slate-400">
                  No telemetry yet — connect a node or press <strong>Start Demo</strong>. Every metric will then
                  appear here as <code className="font-mono">{normalisePrefix(oscConfig.prefix)}/node/&lt;id&gt;/&lt;metric&gt;</code>.
                </p>
              ) : (
                <div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[10px] text-slate-400">
                    <span className="font-mono">{previewNode.nodeId}</span>
                    <span>{previewMessages.length} message(s) from {Object.keys(previewNode.latest).length} fields</span>
                    <span>last seen {formatRelativeTime(Date.parse(previewNode.lastSeen))}</span>
                    {freshNodes.has(previewNode.nodeId) && (
                      <span className="text-emerald-600">position packet in the last batch</span>
                    )}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {previewMessages.slice(0, PREVIEW_LIMIT).map((message) => (
                      <PreviewRow
                        key={`${message.kind}:${message.address}`}
                        address={message.address}
                        args={formatArgs(message.args)}
                        kind={message.kind}
                      />
                    ))}
                    {previewMessages.length > PREVIEW_LIMIT && (
                      <p className="px-3 py-2 text-[10px] text-slate-400">
                        …and {previewMessages.length - PREVIEW_LIMIT} more addresses (the preview is capped so a
                        long metric list cannot stall the tab).
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- MIDI */}
        <section className="rounded-xl border border-slate-800 overflow-hidden">
          <header className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-950 border-b border-slate-800">
            <Music className="w-3.5 h-3.5 text-violet-600" />
            <h3 className="text-xs font-semibold text-slate-200">MIDI output</h3>
            <span className="text-[10px] font-mono text-slate-400">Web MIDI API · Chromium</span>
            <div className="ml-auto flex items-center gap-2">
              <StatusChip tone={midiTone}>{midiStatus.code}</StatusChip>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  className="accent-violet-600"
                  checked={midiConfig.enabled}
                  onChange={(event) => handleMidiConfigure({ enabled: event.target.checked })}
                />
                Enable
              </label>
            </div>
          </header>

          <div className="p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
              <Field
                label="MIDI output port"
                hint="QMidiNet / RTP-MIDI virtual ports appear in this list exactly like a hardware port — enable the network MIDI driver in the OS first, then press Refresh."
              >
                <select
                  className={selectClass}
                  value={midiConfig.portId}
                  onChange={(event) => handleMidiConfigure({ portId: event.target.value })}
                  disabled={midiStatus.ports.length === 0}
                >
                  <option value="">
                    {midiStatus.ports.length === 0 ? 'no output ports found' : 'first available port'}
                  </option>
                  {midiStatus.ports.map((port) => (
                    <option key={port.id} value={port.id}>
                      {port.name}
                      {port.manufacturer ? ` — ${port.manufacturer}` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => refreshMidi(midiConfig)}
                  disabled={midiBusy}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${midiBusy ? 'animate-spin' : ''}`} />
                  Refresh ports
                </button>
                <button type="button" className={`${primaryButton} !border-rose-600 !bg-rose-600 hover:!bg-rose-700`} onClick={handlePanic}>
                  <CircleSlash className="w-3.5 h-3.5" />
                  Panic
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={midiTone}>
                {midiStatus.code === 'ready' ? <Plug className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                {midiStatus.message}
              </StatusChip>
              {midiStatus.activePortName && (
                <span className="text-[10px] font-mono text-slate-400">active: {midiStatus.activePortName}</span>
              )}
              <span className="text-[10px] font-mono text-slate-400">
                {midiStatus.pendingNotes} note(s) sounding
              </span>
            </div>

            {midiNote && <p className="text-[11px] text-slate-400">{midiNote}</p>}

            {midiStatus.code === 'unsupported' && (
              <p className="text-[11px] text-slate-400">
                Web MIDI needs a Chromium-based browser and a secure context (or <code className="font-mono">localhost</code>).
                Firefox and Safari do not expose it. The OSC section above still works there.
              </p>
            )}

            {midiStatus.code === 'no-ports' && (
              <p className="text-[11px] text-slate-400">
                Create a virtual MIDI port first: <strong>IAC Driver</strong> (macOS Audio MIDI Setup),{' '}
                <strong>loopMIDI</strong> (Windows) or <strong>QMidiNet / RTP-MIDI</strong> for a port on another
                machine — then press <strong>Refresh ports</strong>.
              </p>
            )}

            {/* Mapping table */}
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-950 border-b border-slate-800">
                <ListPlus className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[11px] font-semibold text-slate-300">Mapping</span>
                <span className="text-[10px] text-slate-400">
                  {midiConfig.rules.length} rule(s) · min/max are the metric's real range, scaled to MIDI 0–127
                  (14-bit rules use an MSB/LSB CC pair on <em>number</em> and <em>number + 1</em>)
                </span>
                <button type="button" className={`${secondaryButton} ml-auto`} onClick={addRule}>
                  <ListPlus className="w-3.5 h-3.5" />
                  Add rule
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-slate-900 text-left text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Metric</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Type</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">No.</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Channel mode</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Ch.</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Min</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Max</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Resolution</th>
                      <th className="px-2 py-1.5 font-semibold border-b border-slate-800">Live / preview</th>
                      <th className="px-2 py-1.5 border-b border-slate-800" />
                    </tr>
                  </thead>
                  <tbody>
                    {midiConfig.rules.map((rule) => {
                      const ruleValue =
                        previewNode && typeof previewNode.latest[rule.metric] === 'number'
                          ? (previewNode.latest[rule.metric] as number)
                          : null;
                      let live = '—';
                      if (ruleValue !== null) {
                        live =
                          rule.type === 'note'
                            ? `note ${rule.number} · vel ${scaleToMidi(ruleValue, rule.min, rule.max)}`
                            : rule.resolution === '14bit'
                            ? `CC ${rule.number}/${Math.min(127, rule.number + 1)} = ${to14BitPair(
                                scaleToMidi14(ruleValue, rule.min, rule.max)
                              ).join('/')}`
                            : `CC ${rule.number} = ${scaleToMidi(ruleValue, rule.min, rule.max)}`;
                      }
                      const bytes = ruleValue === null ? [] : ruleToMidiBytes(rule, rule.channelMode === 'fixed' ? rule.channel : 1, ruleValue);
                      return (
                        <tr key={rule.id} className="odd:bg-slate-950/60">
                          <td className="px-2 py-1 border-b border-slate-800">
                            <select
                              className={`${selectClass} min-w-[150px]`}
                              value={rule.metric}
                              onChange={(event) => updateRule(rule.id, { metric: event.target.value })}
                            >
                              {!metricOptions.includes(rule.metric) && (
                                <option value={rule.metric}>{rule.metric}</option>
                              )}
                              {metricOptions.map((metric) => (
                                <option key={metric} value={metric}>
                                  {metric}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <select
                              className={selectClass}
                              value={rule.type}
                              onChange={(event) =>
                                updateRule(rule.id, { type: event.target.value as MidiRule['type'] })
                              }
                            >
                              <option value="cc">CC</option>
                              <option value="note">Note</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <input
                              type="number"
                              min={0}
                              max={127}
                              className={`${inputClass} w-16`}
                              value={rule.number}
                              onChange={(event) => updateRule(rule.id, { number: Number(event.target.value) })}
                            />
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <select
                              className={selectClass}
                              value={rule.channelMode}
                              onChange={(event) =>
                                updateRule(rule.id, {
                                  channelMode: event.target.value as MidiRule['channelMode'],
                                })
                              }
                            >
                              <option value="perNode">per node</option>
                              <option value="fixed">fixed</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <input
                              type="number"
                              min={1}
                              max={MIDI_CHANNELS}
                              className={`${inputClass} w-14 disabled:opacity-50`}
                              value={rule.channel}
                              disabled={rule.channelMode !== 'fixed'}
                              onChange={(event) => updateRule(rule.id, { channel: Number(event.target.value) })}
                            />
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <input
                              type="number"
                              step="any"
                              className={`${inputClass} w-20`}
                              value={rule.min}
                              onChange={(event) => updateRule(rule.id, { min: Number(event.target.value) })}
                            />
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <input
                              type="number"
                              step="any"
                              className={`${inputClass} w-20`}
                              value={rule.max}
                              onChange={(event) => updateRule(rule.id, { max: Number(event.target.value) })}
                            />
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <select
                              className={`${selectClass} disabled:opacity-50`}
                              value={rule.resolution}
                              disabled={rule.type === 'note'}
                              onChange={(event) =>
                                updateRule(rule.id, { resolution: event.target.value as MidiRule['resolution'] })
                              }
                            >
                              <option value="7bit">7-bit</option>
                              <option value="14bit">14-bit pair</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800 font-mono text-slate-400 whitespace-nowrap">
                            {live}
                            {bytes.length > 0 && (
                              <span className="ml-1 text-slate-400">
                                [{bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}]
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 border-b border-slate-800">
                            <button
                              type="button"
                              className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                              title="Remove this rule"
                              aria-label={`Remove rule for ${rule.metric}`}
                              onClick={() => removeRule(rule.id)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {midiConfig.rules.length === 0 && (
                      <tr>
                        <td colSpan={10} className="px-3 py-4 text-center text-slate-400">
                          No mapping rules — press <strong>Add rule</strong> to map a metric onto a CC or note.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Per-node channels + the >16 node caveat */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[11px] font-semibold text-slate-300">Per-node channels</span>
                <span className="text-[10px] text-slate-400">
                  assigned in first-seen order; beyond {MIDI_CHANNELS} nodes the assignment wraps (node 17 shares
                  channel 1)
                </span>
              </div>
              {Object.keys(midiStatus.channelMap).length === 0 ? (
                <p className="text-[10px] text-slate-400">
                  No channels assigned yet — they appear as soon as MIDI output is enabled and telemetry arrives.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(midiStatus.channelMap)
                    .sort((a, b) => a[1] - b[1])
                    .map(([nodeId, channel]) => (
                      <span
                        key={nodeId}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-[10px] font-mono text-slate-300"
                      >
                        <span className="text-violet-600">ch{channel}</span>
                        {nodeId}
                      </span>
                    ))}
                </div>
              )}
            </div>

            {previewNode && Object.keys(previewNode.latest).length > 0 && (
              <p className="text-[10px] text-slate-400">
                “Live / preview” uses <span className="font-mono">{previewNode.nodeId}</span> —{' '}
                {Object.entries(previewNode.latest)
                  .filter(([, value]) => typeof value === 'number')
                  .slice(0, 6)
                  .map(([name, value]) => `${name}=${formatMetricValue(value)}`)
                  .join(', ')}
                …
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

/** One labelled counter tile. */
const Counter: React.FC<{ label: string; value: number; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = ({
  label,
  value,
  tone,
}) => {
  const tones: Record<typeof tone, string> = {
    ok: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-rose-700',
    idle: 'text-slate-300',
  };
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5">
      <dt className="text-[10px] text-slate-400 leading-snug">{label}</dt>
      <dd className={`font-mono font-semibold ${tones[tone]}`}>{value.toLocaleString('en-US')}</dd>
    </div>
  );
};
