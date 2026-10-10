import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bird, CloudSun, Plug, Radio, RefreshCw, Unplug } from 'lucide-react';
import { mqttClient, type MqttConfig, type MqttMessage, type MqttStatus } from '../utils/mqttClient';
import { parseMqttMessage, type ParsedMqttMessage, type MqttSource } from '../utils/mqttParse';
import { formatRelativeTime } from '../utils/nodes';

/** How many recent messages each feed keeps in the panel. */
const FEED_LIMIT = 12;

interface MqttPanelProps {
  /** The saved config; the panel edits it through `onChange` (App owns persistence). */
  mqttConfig: MqttConfig;
  onMqttConfigChange: (next: MqttConfig) => void;
}

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-200 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500';

const buttonClass =
  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';
const primaryButton = `${buttonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700 disabled:hover:bg-blue-600`;
const secondaryButton = `${buttonClass} border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800`;

/** Small labelled input used by the configuration card. */
const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ label, hint, children, className = '' }) => (
  <div className={className}>
    <label className="block text-[11px] font-medium text-slate-300 mb-1">
      {label}
      {hint && <span className="ml-1 text-[10px] font-normal text-slate-500">{hint}</span>}
    </label>
    {children}
  </div>
);

/** One parsed message rendered as a compact row. */
function FeedRow({ item }: { item: ParsedMqttMessage }) {
  return (
    <li className="px-2 py-1 border-b border-slate-800 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-slate-200 truncate">{item.title}</span>
        <span className="ml-auto text-[10px] font-mono text-slate-500 shrink-0">
          {formatRelativeTime(item.receivedAt)}
        </span>
      </div>
      {item.fields.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {item.fields.map((field) => (
            <span key={field.label} className="text-[10px] font-mono text-slate-400">
              <span className="text-slate-600">{field.label}:</span>{' '}
              <span className="text-slate-300">{field.value}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function MqttPanel({ mqttConfig, onMqttConfigChange }: MqttPanelProps) {
  const [config, setConfig] = useState<MqttConfig>(mqttConfig);
  const [status, setStatus] = useState<MqttStatus>({ connected: false, host: '', port: 0, error: null, messages: 0 });
  const [messages, setMessages] = useState<ParsedMqttMessage[]>([]);
  const [busy, setBusy] = useState(false);

  // Follow the App-owned config when it changes elsewhere.
  useEffect(() => {
    setConfig(mqttConfig);
  }, [mqttConfig]);

  useEffect(() => {
    const offMessage = mqttClient.onMessage((message: MqttMessage) => {
      const parsed = parseMqttMessage(message.topic, message.payloadText, mqttClient.getConfig().topics, message.receivedAt);
      setMessages((prev) => [parsed, ...prev].slice(0, FEED_LIMIT * 3));
    });
    const offStatus = mqttClient.onStatus(setStatus);
    setStatus(mqttClient.getStatus());
    return () => {
      offMessage();
      offStatus();
    };
  }, []);

  const feeds = useMemo(() => {
    const bySource: Record<Exclude<MqttSource, 'other'>, ParsedMqttMessage[]> = {
      birdnet: messages.filter((m) => m.source === 'birdnet').slice(0, FEED_LIMIT),
      meshtastic: messages.filter((m) => m.source === 'meshtastic').slice(0, FEED_LIMIT),
      weather: messages.filter((m) => m.source === 'weather').slice(0, FEED_LIMIT),
    };
    return bySource;
  }, [messages]);

  const applyConfig = useCallback(async () => {
    setBusy(true);
    try {
      const next = config;
      onMqttConfigChange(next);
      await mqttClient.configure(next);
      await mqttClient.checkHealth();
    } finally {
      setBusy(false);
    }
  }, [config, onMqttConfigChange]);

  const disconnect = useCallback(() => {
    mqttClient.disconnect();
    setStatus({ connected: false, host: '', port: 0, error: 'disconnected', messages: status.messages });
  }, [status.messages]);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      await mqttClient.checkHealth();
    } finally {
      setBusy(false);
    }
  }, []);

  const set = (patch: Partial<MqttConfig>) => setConfig((prev) => ({ ...prev, ...patch }));
  const setBroker = (patch: Partial<MqttConfig['broker']>) => setConfig((prev) => ({ ...prev, broker: { ...prev.broker, ...patch } }));
  const setTopic = (key: keyof MqttConfig['topics'], value: string) => setConfig((prev) => ({ ...prev, topics: { ...prev.topics, [key]: value } }));

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header / status */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
          <Radio className="w-4 h-4 text-cyan-500" /> MQTT Ingest
        </h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] ${
            status.connected ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : status.error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-700 bg-slate-800 text-slate-400'
          }`}
        >
          {status.connected ? `connected · ${status.host}:${status.port}` : status.error ?? 'not connected'}
        </span>
        <span className="text-[11px] font-mono text-slate-500">{status.messages} messages</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={applyConfig} disabled={busy} className={primaryButton}>
            <Plug className="w-3.5 h-3.5" /> Connect
          </button>
          <button type="button" onClick={disconnect} className={secondaryButton}>
            <Unplug className="w-3.5 h-3.5" /> Disconnect
          </button>
          <button type="button" onClick={check} disabled={busy} className={secondaryButton} title="Re-check the bridge and broker">
            <RefreshCw className="w-3.5 h-3.5" /> Check
          </button>
        </div>
      </div>

      {/* Configuration */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Broker</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Bridge URL" hint="where the local MQTT bridge listens (HTTP + SSE)">
            <input type="text" className={inputClass} value={config.url} spellCheck={false} onChange={(e) => set({ url: e.target.value })} placeholder="http://127.0.0.1:9300" />
          </Field>
          <Field label="Broker host">
            <input type="text" className={inputClass} value={config.broker.host} spellCheck={false} onChange={(e) => setBroker({ host: e.target.value })} placeholder="127.0.0.1" />
          </Field>
          <Field label="Broker port" hint="1883 plain, 8883 TLS">
            <input type="number" min={1} max={65535} className={inputClass} value={config.broker.port} onChange={(e) => setBroker({ port: Number(e.target.value) })} />
          </Field>
          <Field label="Username">
            <input type="text" className={inputClass} value={config.broker.username} spellCheck={false} onChange={(e) => setBroker({ username: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Password">
            <input type="password" className={inputClass} value={config.broker.password} onChange={(e) => setBroker({ password: e.target.value })} autoComplete="new-password" />
          </Field>
          <label className="flex items-center gap-2 pt-5">
            <input type="checkbox" className="accent-blue-600" checked={config.broker.tls} onChange={(e) => setBroker({ tls: e.target.checked })} />
            <span className="text-[11px] text-slate-300">TLS (mqtts)</span>
          </label>
        </div>

        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 pt-1">Topic subscriptions</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="BirdNET-Pi">
            <input type="text" className={inputClass} value={config.topics.birdnet} spellCheck={false} onChange={(e) => setTopic('birdnet', e.target.value)} />
          </Field>
          <Field label="Meshtastic">
            <input type="text" className={inputClass} value={config.topics.meshtastic} spellCheck={false} onChange={(e) => setTopic('meshtastic', e.target.value)} />
          </Field>
          <Field label="Weather stations">
            <input type="text" className={inputClass} value={config.topics.weather} spellCheck={false} onChange={(e) => setTopic('weather', e.target.value)} />
          </Field>
        </div>
        <p className="text-[10px] text-slate-500">
          MQTT wildcards <code className="text-slate-400">+</code> (one level) and <code className="text-slate-400">#</code> (everything below) are supported. The broker connection is held by{' '}
          <code className="text-slate-400">npm run bridge:mqtt</code>; run it with <code className="text-slate-400">--launch-mosquitto</code> to also start a local broker if Mosquitto is installed.
        </p>
      </section>

      {/* Live feeds */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <section className="rounded-xl border border-slate-800 bg-slate-900/60">
          <h3 className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 text-[11px] font-semibold text-slate-300">
            <Bird className="w-3.5 h-3.5 text-emerald-500" /> BirdNET detections
          </h3>
          <ul className="divide-y divide-slate-800">{feeds.birdnet.length ? feeds.birdnet.map((m, i) => <FeedRow key={i} item={m} />) : <li className="px-3 py-6 text-center text-[11px] text-slate-500">No detections yet</li>}</ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/60">
          <h3 className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 text-[11px] font-semibold text-slate-300">
            <Radio className="w-3.5 h-3.5 text-blue-500" /> Meshtastic
          </h3>
          <ul className="divide-y divide-slate-800">{feeds.meshtastic.length ? feeds.meshtastic.map((m, i) => <FeedRow key={i} item={m} />) : <li className="px-3 py-6 text-center text-[11px] text-slate-500">No node data yet</li>}</ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/60">
          <h3 className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 text-[11px] font-semibold text-slate-300">
            <CloudSun className="w-3.5 h-3.5 text-amber-500" /> Weather
          </h3>
          <ul className="divide-y divide-slate-800">{feeds.weather.length ? feeds.weather.map((m, i) => <FeedRow key={i} item={m} />) : <li className="px-3 py-6 text-center text-[11px] text-slate-500">No weather readings yet</li>}</ul>
        </section>
      </div>
    </div>
  );
}
