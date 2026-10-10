/**
 * Browser half of the MQTT feature.
 *
 * A browser cannot open a raw MQTT socket, so it talks to bridge/mqtt-bridge.mjs
 * over HTTP (configuration) and Server-Sent Events (the live stream). The bridge
 * holds the actual MQTT connection and forwards every message as JSON.
 *
 * Config shape mirrors the bridge's `{broker, topics}` plus the bridge URL the
 * browser itself needs. It is persisted to localStorage, like OSC and MIDI.
 */

/** MQTT broker connection details (used by the bridge). */
export interface MqttBrokerConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export interface MqttTopics {
  birdnet: string;
  meshtastic: string;
  weather: string;
}

export interface MqttConfig {
  /** Base URL of the local bridge, e.g. `http://127.0.0.1:9300`. */
  url: string;
  broker: MqttBrokerConfig;
  topics: MqttTopics;
}

export interface MqttStatus {
  connected: boolean;
  host: string;
  port: number;
  error: string | null;
  messages: number;
}

export interface MqttMessage {
  topic: string;
  payloadText: string;
  receivedAt: number;
}

const STORAGE_KEY = 'meshmap:mqtt-config:v1';

export const DEFAULT_MQTT_CONFIG: MqttConfig = {
  url: 'http://127.0.0.1:9300',
  broker: { host: '127.0.0.1', port: 1883, tls: false, username: '', password: '' },
  topics: { birdnet: 'birdnet/detections', meshtastic: 'msh/+/json', weather: 'weather/#' },
};

const HOST_RE = /^[A-Za-z0-9._:[\-\]]{1,253}$/;

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Normalises arbitrary input (localStorage can hold anything) into a full config. */
export function sanitiseMqttConfig(raw: unknown): MqttConfig {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const broker = value.broker && typeof value.broker === 'object' ? (value.broker as Record<string, unknown>) : {};
  const topics = value.topics && typeof value.topics === 'object' ? (value.topics as Record<string, unknown>) : {};

  const host = pickString(broker.host, DEFAULT_MQTT_CONFIG.broker.host);
  const port = Number.isInteger(broker.port) && (broker.port as number) > 0 && (broker.port as number) < 65536
    ? (broker.port as number)
    : DEFAULT_MQTT_CONFIG.broker.port;
  const url = pickString(value.url, DEFAULT_MQTT_CONFIG.url).replace(/\/+$/, '');

  return {
    url,
    broker: {
      host: HOST_RE.test(host) && !host.includes('..') ? host : DEFAULT_MQTT_CONFIG.broker.host,
      port,
      tls: broker.tls === true,
      username: typeof broker.username === 'string' ? broker.username : '',
      password: typeof broker.password === 'string' ? broker.password : '',
    },
    topics: {
      birdnet: pickString(topics.birdnet, DEFAULT_MQTT_CONFIG.topics.birdnet),
      meshtastic: pickString(topics.meshtastic, DEFAULT_MQTT_CONFIG.topics.meshtastic),
      weather: pickString(topics.weather, DEFAULT_MQTT_CONFIG.topics.weather),
    },
  };
}

export function loadMqttConfig(): MqttConfig {
  try {
    return sanitiseMqttConfig(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_MQTT_CONFIG };
  }
}

export function saveMqttConfig(config: MqttConfig): MqttConfig {
  const clean = sanitiseMqttConfig(config);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* storage unavailable — the panel still works for this session */
  }
  return clean;
}

export type MqttMessageListener = (message: MqttMessage) => void;
export type MqttStatusListener = (status: MqttStatus) => void;

/**
 * Wraps the bridge's HTTP + SSE surface. `configure` pushes `{broker, topics}`
 * to the bridge and persists; `connect` opens the SSE stream.
 */
export class MqttClient {
  private config: MqttConfig;
  private eventSource: EventSource | null = null;
  private messageListeners = new Set<MqttMessageListener>();
  private statusListeners = new Set<MqttStatusListener>();
  private status: MqttStatus = { connected: false, host: '', port: 0, error: null, messages: 0 };

  constructor(config: MqttConfig) {
    this.config = sanitiseMqttConfig(config);
  }

  getConfig(): MqttConfig {
    return { ...this.config };
  }

  getStatus(): MqttStatus {
    return { ...this.status };
  }

  /** Applies + persists config and pushes it to the bridge. */
  async configure(config: MqttConfig): Promise<MqttConfig> {
    this.config = saveMqttConfig(config);
    try {
      const response = await fetch(`${this.config.url}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker: this.config.broker, topics: this.config.topics }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.setStatus({ ...this.status, error: `bridge rejected config (HTTP ${response.status}) ${text}`.trim() });
      }
    } catch (error) {
      // The bridge may be down; the status event will explain it.
      this.setStatus({ ...this.status, error: `could not reach the bridge: ${(error as Error)?.message ?? error}` });
    }
    // Re-open the stream so it follows the (possibly changed) bridge URL.
    this.connect();
    return this.config;
  }

  /** Opens the SSE stream; idempotent for the current bridge URL. */
  connect(): void {
    this.disconnect();
    // Non-browser environments (tests, SSR) have no EventSource; the stream is a
    // browser-only concern, so degrade to fetch/health-only there.
    if (typeof EventSource === 'undefined') return;
    const streamUrl = `${this.config.url}/stream`;
    const source = new EventSource(streamUrl);
    this.eventSource = source;

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as
          | (MqttMessage & { type: 'message' })
          | (MqttStatus & { type: 'status' });
        if (data.type === 'message') {
          const message: MqttMessage = { topic: data.topic, payloadText: data.payloadText, receivedAt: data.receivedAt };
          this.setStatus({ ...this.status, messages: this.status.messages + 1 });
          this.messageListeners.forEach((listener) => listener(message));
        } else if (data.type === 'status') {
          this.setStatus({
            connected: data.connected,
            host: data.host,
            port: data.port,
            error: data.error ?? null,
            messages: this.status.messages,
          });
        }
      } catch {
        /* a keep-alive comment or malformed frame — ignore */
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects; surface it as a status change.
      this.setStatus({ ...this.status, connected: false, error: 'bridge unreachable (retrying…)' });
    };
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  onMessage(listener: MqttMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: MqttStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fetches the bridge's health (used for the status chip refresh button). */
  async checkHealth(): Promise<MqttStatus> {
    try {
      const response = await fetch(`${this.config.url}/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { connected?: boolean; host?: string; port?: number; messages?: number };
      const next: MqttStatus = {
        connected: body.connected === true,
        host: body.host ?? this.config.broker.host,
        port: body.port ?? this.config.broker.port,
        error: null,
        messages: body.messages ?? 0,
      };
      this.setStatus(next);
      return next;
    } catch (error) {
      const next: MqttStatus = { ...this.status, connected: false, error: `health check failed: ${(error as Error)?.message ?? error}` };
      this.setStatus(next);
      return next;
    }
  }

  private setStatus(status: MqttStatus): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener({ ...status }));
  }
}

/**
 * The shared client instance.
 *
 * Module scope on purpose: the panel can unmount/remount as the view switches
 * without the EventSource being garbage-collected mid-stream (a `useRef` inside a
 * remounting component would orphan and close the connection).
 */
export const mqttClient = new MqttClient(typeof window !== 'undefined' ? loadMqttConfig() : { ...DEFAULT_MQTT_CONFIG });
