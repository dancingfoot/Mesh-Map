/**
 * Tests for the MQTT client config sanitisation and the dynamic payload parser.
 *
 * The parser is the interesting part: BirdNET-Pi, Meshtastic and weather stations
 * all use slightly different JSON, so these tests pin the lenient behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MqttClient, sanitiseMqttConfig, DEFAULT_MQTT_CONFIG, type MqttConfig } from './mqttClient';
import { classifyMqtt, parseMqttMessage } from './mqttParse';

const config = (overrides: Partial<MqttConfig> = {}): MqttConfig => ({
  ...DEFAULT_MQTT_CONFIG,
  ...overrides,
  broker: { ...DEFAULT_MQTT_CONFIG.broker, ...(overrides.broker ?? {}) },
  topics: { ...DEFAULT_MQTT_CONFIG.topics, ...(overrides.topics ?? {}) },
});

describe('sanitiseMqttConfig', () => {
  it('keeps a valid broker and topics', () => {
    const clean = sanitiseMqttConfig({ url: 'http://127.0.0.1:9300/', broker: { host: 'mqtt.example.com', port: 8883, tls: true, username: 'u', password: 'p' }, topics: { birdnet: 'b/#', meshtastic: 'msh/+/json', weather: 'w' } });
    expect(clean.broker.host).toBe('mqtt.example.com');
    expect(clean.broker.port).toBe(8883);
    expect(clean.broker.tls).toBe(true);
    expect(clean.topics.birdnet).toBe('b/#');
    expect(clean.url).toBe('http://127.0.0.1:9300'); // trailing slash trimmed
  });

  it('rejects an out-of-range port and a hostile host', () => {
    expect(sanitiseMqttConfig({ broker: { port: 70000 } }).broker.port).toBe(1883);
    expect(sanitiseMqttConfig({ broker: { host: 'host with space' } }).broker.host).toBe('127.0.0.1');
    expect(sanitiseMqttConfig({ broker: { host: 'a..b' } }).broker.host).toBe('127.0.0.1');
  });

  it('falls back to defaults for null/blank input', () => {
    expect(sanitiseMqttConfig(null)).toEqual(DEFAULT_MQTT_CONFIG);
    expect(sanitiseMqttConfig({ topics: { meshtastic: '' } }).topics.meshtastic).toBe('msh/+/json');
  });
});

describe('classifyMqtt', () => {
  const topics = DEFAULT_MQTT_CONFIG.topics;
  it('classifies by configured topic and by keyword', () => {
    expect(classifyMqtt('birdnet/detections', topics)).toBe('birdnet');
    expect(classifyMqtt('msh/US/2/json/!a1d7631c/123', topics)).toBe('meshtastic');
    expect(classifyMqtt('weather/station/1', topics)).toBe('weather');
    expect(classifyMqtt('some/other/topic', topics)).toBe('other');
  });

  it('honours wildcard topics (+ and #)', () => {
    const wild = { birdnet: 'birdnet/+', meshtastic: 'msh/+/json', weather: 'weather/#' };
    expect(classifyMqtt('birdnet/pi1', wild)).toBe('birdnet');
    expect(classifyMqtt('msh/eu/json', wild)).toBe('meshtastic');
    expect(classifyMqtt('weather/a/b/c', wild)).toBe('weather');
  });
});

describe('parseMqttMessage', () => {
  const topics = DEFAULT_MQTT_CONFIG.topics;

  it('parses a BirdNET-Pi detection with a string confidence', () => {
    const parsed = parseMqttMessage('birdnet/detections', JSON.stringify({ common_name: 'Eurasian Wren', scientific_name: 'Troglodytes troglodytes', confidence: '0.83', image: '/img/1.jpg' }), topics);
    expect(parsed.source).toBe('birdnet');
    expect(parsed.title).toBe('Eurasian Wren');
    expect(parsed.fields).toContainEqual({ label: 'Species', value: 'Troglodytes troglodytes' });
    expect(parsed.fields).toContainEqual({ label: 'Confidence', value: '83%' });
    expect(parsed.fields).toContainEqual({ label: 'Media', value: '/img/1.jpg' });
  });

  it('normalises a 0–100 numeric confidence', () => {
    const parsed = parseMqttMessage('birdnet/detections', JSON.stringify({ common_name: 'Robin', confidence: 91 }), topics);
    expect(parsed.fields.find((f) => f.label === 'Confidence')?.value).toBe('91%');
  });

  it('extracts Meshtastic telemetry fields and the node id', () => {
    const payload = { from: 123456, type: 'telemetry', temperature: 21.5, relative_humidity: 44, battery_level: 100, voltage: 4.1 };
    const parsed = parseMqttMessage('msh/US/2/json', JSON.stringify(payload), topics);
    expect(parsed.source).toBe('meshtastic');
    expect(parsed.title).toContain('123456');
    expect(parsed.fields).toContainEqual({ label: 'Temperature', value: 21.5 });
    expect(parsed.fields).toContainEqual({ label: 'Humidity', value: 44 });
    expect(parsed.fields).toContainEqual({ label: 'Battery', value: 100 });
  });

  it('reads weather metrics from a flat payload', () => {
    const parsed = parseMqttMessage('weather/station/1', JSON.stringify({ temperature: 18.4, humidity: 52, pressure: 1015 }), topics);
    expect(parsed.source).toBe('weather');
    expect(parsed.title).toBe('Weather');
    expect(parsed.fields.map((f) => f.label)).toContain('Temperature');
    expect(parsed.fields.find((f) => f.label === 'Pressure')?.value).toContain('1015');
  });

  it('handles a non-JSON payload without throwing', () => {
    const parsed = parseMqttMessage('weather/x', 'not-json', topics);
    expect(parsed.source).toBe('weather');
    expect(parsed.payload).toBeNull();
    expect(parsed.rawText).toBe('not-json');
  });
});

describe('MqttClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('configure persists and POSTs only broker + topics', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true });

    const client = new MqttClient(config());
    await client.configure(config({ url: 'http://127.0.0.1:9300', broker: { host: 'x', port: 1883, tls: false, username: 'u', password: 'p' } }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9300/config');
    const body = JSON.parse(String(init.body));
    expect(body.broker.host).toBe('x');
    expect(body.topics.birdnet).toBe(DEFAULT_MQTT_CONFIG.topics.birdnet);
    // The bridge URL is client-only and never sent.
    expect(body).not.toHaveProperty('url');
  });

  it('checkHealth reports a failed bridge as disconnected', async () => {
    Object.defineProperty(globalThis, 'fetch', { value: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), configurable: true, writable: true });
    const client = new MqttClient(config());
    const status = await client.checkHealth();
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/ECONNREFUSED/);
  });
});
