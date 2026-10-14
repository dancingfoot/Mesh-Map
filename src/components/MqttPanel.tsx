import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bird, CloudSun, Play, Plug, Radio, RefreshCw, Sparkles, Square, Trash2, Unplug } from 'lucide-react';
import { mqttClient, type MqttConfig, type MqttMessage, type MqttStatus } from '../utils/mqttClient';
import { parseMqttMessage, type ParsedMqttMessage, type MqttSource } from '../utils/mqttParse';
import { formatRelativeTime } from '../utils/nodes';

/** How many recent messages each feed keeps in the panel. */
const FEED_LIMIT = 12;

const SAMPLE_BIRDS = [
  { common: 'Eurasian Blue Tit', scientific: 'Cyanistes caeruleus', confidence: 0.92 },
  { common: 'European Robin', scientific: 'Erithacus rubecula', confidence: 0.88 },
  { common: 'Common Blackbird', scientific: 'Turdus merula', confidence: 0.95 },
  { common: 'Great Spotted Woodpecker', scientific: 'Dendrocopos major', confidence: 0.84 },
  { common: 'Barn Owl', scientific: 'Tyto alba', confidence: 0.79 },
];

const SAMPLE_NODES = [
  { node: '!4a9b81f0', temp: 21.4, humidity: 58.2, battery: 94, voltage: 4.15, alt: 142 },
  { node: '!2c7e09a4', temp: 19.8, humidity: 64.0, battery: 82, voltage: 3.98, alt: 98 },
  { node: '!8f11d402', temp: 23.1, humidity: 52.5, battery: 71, voltage: 3.86, alt: 210 },
];

const SAMPLE_WEATHER = [
  { temp: 18.5, humidity: 62, pressure: 1014.2, wind: 3.8, rain: 0.0 },
  { temp: 19.1, humidity: 60, pressure: 1013.8, wind: 4.2, rain: 0.2 },
  { temp: 17.8, humidity: 68, pressure: 1015.0, wind: 2.9, rain: 0.0 },
];

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
const primaryButton = `${buttonClass} border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-500 disabled:hover:bg-cyan-600`;
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
  const [isSimulatingStream, setIsSimulatingStream] = useState(false);
  const simIntervalRef = useRef<number | null>(null);

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

  // Test Simulation Injectors
  const injectSampleBirdnet = useCallback(() => {
    const item = SAMPLE_BIRDS[Math.floor(Math.random() * SAMPLE_BIRDS.length)];
    mqttClient.simulateMessage(
      config.topics.birdnet || 'birdnet/detections',
      JSON.stringify({
        common_name: item.common,
        scientific_name: item.scientific,
        confidence: item.confidence,
        time: new Date().toISOString(),
      })
    );
  }, [config.topics.birdnet]);

  const injectSampleMeshtastic = useCallback(() => {
    const item = SAMPLE_NODES[Math.floor(Math.random() * SAMPLE_NODES.length)];
    mqttClient.simulateMessage(
      config.topics.meshtastic.replace('+', item.node) || `msh/${item.node}/json`,
      JSON.stringify({
        from: item.node,
        type: 'telemetry',
        temperature: Number((item.temp + (Math.random() * 2 - 1)).toFixed(1)),
        relative_humidity: Number((item.humidity + (Math.random() * 4 - 2)).toFixed(1)),
        battery_level: item.battery,
        voltage: item.voltage,
        altitude: item.alt,
      })
    );
  }, [config.topics.meshtastic]);

  const injectSampleWeather = useCallback(() => {
    const item = SAMPLE_WEATHER[Math.floor(Math.random() * SAMPLE_WEATHER.length)];
    mqttClient.simulateMessage(
      config.topics.weather.replace('#', 'sensors') || 'weather/sensors',
      JSON.stringify({
        temperature: Number((item.temp + (Math.random() * 2 - 1)).toFixed(1)),
        humidity: Number((item.humidity + (Math.random() * 4 - 2)).toFixed(1)),
        pressure: Number((item.pressure + (Math.random() * 1 - 0.5)).toFixed(1)),
        wind_speed: Number((item.wind + (Math.random() * 1.5 - 0.7)).toFixed(1)),
        rain: item.rain,
      })
    );
  }, [config.topics.weather]);

  // Toggle Continuous Simulated Stream
  const toggleSimStream = useCallback(() => {
    if (isSimulatingStream) {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
      setIsSimulatingStream(false);
    } else {
      setIsSimulatingStream(true);
      // Immediately fire one of each
      injectSampleBirdnet();
      injectSampleMeshtastic();
      injectSampleWeather();

      let turn = 0;
      simIntervalRef.current = window.setInterval(() => {
        turn = (turn + 1) % 3;
        if (turn === 0) injectSampleMeshtastic();
        else if (turn === 1) injectSampleBirdnet();
        else injectSampleWeather();
      }, 2000);
    }
  }, [isSimulatingStream, injectSampleBirdnet, injectSampleMeshtastic, injectSampleWeather]);

  useEffect(() => {
    return () => {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
      }
    };
  }, []);

  const handleClearFeeds = () => {
    setMessages([]);
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header / status */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
          <Radio className="w-4 h-4 text-cyan-500" /> MQTT Ingest Subsystem
        </h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] ${
            status.connected
              ? 'border-emerald-500/30 bg-emerald-950/60 text-emerald-300'
              : status.error
              ? 'border-rose-500/30 bg-rose-950/60 text-rose-300'
              : 'border-slate-700 bg-slate-800 text-slate-400'
          }`}
        >
          {status.connected ? `connected · ${status.host}:${status.port}` : status.error ?? 'not connected'}
        </span>
        <span className="text-[11px] font-mono text-slate-400">{status.messages} messages</span>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button type="button" onClick={applyConfig} disabled={busy} className={primaryButton}>
            <Plug className="w-3.5 h-3.5" /> Connect Bridge
          </button>
          <button type="button" onClick={disconnect} className={secondaryButton}>
            <Unplug className="w-3.5 h-3.5" /> Disconnect
          </button>
          <button type="button" onClick={check} disabled={busy} className={secondaryButton} title="Re-check the bridge and broker">
            <RefreshCw className="w-3.5 h-3.5" /> Check
          </button>
        </div>
      </div>

      {/* Interactive Testing & In-Browser Simulator */}
      <section className="rounded-xl border border-cyan-800/60 bg-gradient-to-r from-cyan-950/30 via-slate-900/60 to-slate-900/60 p-3 space-y-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold text-cyan-200 uppercase tracking-wide">
              Test & Simulation Lab
            </span>
            <span className="text-[10px] text-slate-400">
              (Test in-browser packet parsing without running a local broker)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSimStream}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono font-semibold transition-all border ${
                isSimulatingStream
                  ? 'bg-purple-950/80 border-purple-500 text-purple-200 hover:bg-purple-900'
                  : 'bg-cyan-950/80 border-cyan-600 text-cyan-200 hover:bg-cyan-900/80'
              }`}
            >
              {isSimulatingStream ? (
                <>
                  <Square className="w-3.5 h-3.5 text-purple-400 fill-purple-400" />
                  <span>Stop Auto Stream</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 text-cyan-400 fill-cyan-400" />
                  <span>Start Live Test Stream</span>
                </>
              )}
            </button>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClearFeeds}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-400 hover:text-rose-300 border border-slate-700/80 hover:border-rose-800/80 bg-slate-900/80 rounded-md transition-colors"
                title="Clear current message list"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear ({messages.length})</span>
              </button>
            )}
          </div>
        </div>

        {/* Instant Packet Triggers */}
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-slate-800/80">
          <span className="text-[11px] font-mono text-slate-400">Inject single packet:</span>
          <button
            type="button"
            onClick={injectSampleMeshtastic}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono bg-blue-950/70 border border-blue-700/60 hover:bg-blue-900/80 text-blue-200 rounded-md transition-colors"
          >
            <Radio className="w-3 h-3 text-blue-400" />
            <span>+ Meshtastic Telemetry</span>
          </button>
          <button
            type="button"
            onClick={injectSampleBirdnet}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono bg-emerald-950/70 border border-emerald-700/60 hover:bg-emerald-900/80 text-emerald-200 rounded-md transition-colors"
          >
            <Bird className="w-3 h-3 text-emerald-400" />
            <span>+ BirdNET Species</span>
          </button>
          <button
            type="button"
            onClick={injectSampleWeather}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono bg-amber-950/70 border border-amber-700/60 hover:bg-amber-900/80 text-amber-200 rounded-md transition-colors"
          >
            <CloudSun className="w-3 h-3 text-amber-400" />
            <span>+ Weather Reading</span>
          </button>
        </div>
      </section>

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
