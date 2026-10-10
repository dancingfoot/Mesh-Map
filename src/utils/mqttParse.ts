/**
 * Dynamic classification and field extraction for incoming MQTT payloads.
 *
 * The three sources use different, sometimes vendor-specific JSON shapes, so this
 * is deliberately lenient: it identifies the source from the topic, then pulls
 * the fields each dashboard view wants, tolerating string/number variants and
 * nested objects. Anything it cannot type is still shown as raw JSON.
 */

import type { MqttTopics } from './mqttClient';

export type MqttSource = 'birdnet' | 'meshtastic' | 'weather' | 'other';

export interface MqttField {
  label: string;
  value: string | number;
}

export interface ParsedMqttMessage {
  source: MqttSource;
  /** One-line headline for the feed row, e.g. the bird's common name. */
  title: string;
  fields: MqttField[];
  /** The parsed JSON payload, or null when the payload was not JSON. */
  payload: unknown;
  rawText: string;
  receivedAt: number;
}

/** Matches a topic against the configured Meshtastic topic (which may contain +/#). */
function topicMatches(topic: string, pattern: string): boolean {
  // Translate the MQTT wildcards into a regex; everything else is a literal.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/#/g, '.*').replace(/\\\+/g, '[^/]*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(topic);
}

export function classifyMqtt(topic: string, topics: MqttTopics): MqttSource {
  const t = topic.toLowerCase();
  if (topicMatches(t, topics.birdnet.toLowerCase()) || t.includes('birdnet')) return 'birdnet';
  if (topicMatches(t, topics.meshtastic.toLowerCase()) || t.includes('msh') || t.includes('meshtastic')) return 'meshtastic';
  if (topicMatches(t, topics.weather.toLowerCase()) || t.includes('weather') || t.includes('weewx')) return 'weather';
  return 'other';
}

/** Recursively hunts for a numeric/string value under the given keys. */
function findField(payload: unknown, keys: string[]): string | number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value === 'object') {
      const nested = findField(value, keys);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function findAnyString(payload: unknown, keys: string[]): string | null {
  const value = findField(payload, keys);
  return value === null ? null : String(value);
}

function formatNumber(value: string | number | null, unit = ''): string {
  if (value === null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? `${Math.round(n * 100) / 100}${unit}` : String(value);
}

/** A confidence that arrives as "0.85" or 85 is normalised to a percentage. */
function formatConfidence(value: string | number | null): string {
  if (value === null) return '—';
  const n = typeof value === 'string' ? Number(value.replace('%', '')) : value;
  if (!Number.isFinite(n)) return String(value);
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

function parseBirdnet(payload: Record<string, unknown>): Pick<ParsedMqttMessage, 'title' | 'fields'> {
  const common = findAnyString(payload, ['common_name', 'commonName', 'common name', 'species']);
  const scientific = findAnyString(payload, ['scientific_name', 'scientificName', 'sci_name', 'latin']);
  const confidence = findField(payload, ['confidence', 'conf', 'score', 'probability']);
  const media = findAnyString(payload, ['image', 'image_url', 'audio', 'audio_url', 'file', 'file_name', 'url', 'filename']);

  const fields: MqttField[] = [];
  if (scientific) fields.push({ label: 'Species', value: scientific });
  if (confidence !== null) fields.push({ label: 'Confidence', value: formatConfidence(confidence as string | number) });
  if (media) fields.push({ label: 'Media', value: media });

  return { title: common ?? scientific ?? 'Bird detection', fields };
}

function parseMeshtastic(payload: Record<string, unknown>): Pick<ParsedMqttMessage, 'title' | 'fields'> {
  const node = findAnyString(payload, ['from', 'fromId', 'sender', 'gatewayId', 'node_id', 'nodeId']);
  const type = findAnyString(payload, ['type', 'portnum', 'portNum']);
  const fields: MqttField[] = [];

  const metrics: Array<[string, string[]]> = [
    ['Temperature', ['temperature', 'temp']],
    ['Humidity', ['relative_humidity', 'humidity', 'relativeHumidity']],
    ['Pressure', ['barometric_pressure', 'pressure', 'barometricPressure']],
    ['Battery', ['battery_level', 'battery', 'batteryLevel']],
    ['Voltage', ['voltage']],
    ['Latitude', ['latitude', 'latitude_i']],
    ['Longitude', ['longitude', 'longitude_i']],
    ['Altitude', ['altitude']],
  ];
  for (const [label, keys] of metrics) {
    const value = findField(payload, keys);
    if (value !== null) fields.push({ label, value: typeof value === 'number' ? Math.round(value * 100) / 100 : value });
  }

  const title = node ? `Node ${node}` : type ? `Meshtastic (${type})` : 'Meshtastic';
  return { title, fields };
}

function parseWeather(payload: Record<string, unknown>): Pick<ParsedMqttMessage, 'title' | 'fields'> {
  const fields: MqttField[] = [];
  const metrics: Array<[string, string, string[]]> = [
    ['Temperature', '°C', ['temperature', 'temp_c', 'temp', 'tempf', 'outTemp']],
    ['Humidity', '%', ['humidity', 'relative_humidity', 'humidity_in', 'outHumidity']],
    ['Pressure', ' hPa', ['pressure', 'barometric_pressure', 'barometer', 'pressurerel', 'baro']],
    ['Wind', ' m/s', ['wind_speed', 'windSpeed', 'windspeedmph', 'wind']],
    ['Rain', ' mm', ['rain', 'rain_mm', 'precipitation', 'rainfall']],
  ];
  for (const [label, unit, keys] of metrics) {
    const value = findField(payload, keys);
    if (value !== null) fields.push({ label, value: `${formatNumber(value as string | number, unit)}` });
  }
  return { title: 'Weather', fields };
}

export function parseMqttMessage(topic: string, payloadText: string, topics: MqttTopics, receivedAt = Date.now()): ParsedMqttMessage {
  const source = classifyMqtt(topic, topics);
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = null;
  }

  let title: string;
  let fields: MqttField[] = [];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (source === 'birdnet') ({ title, fields } = parseBirdnet(record));
    else if (source === 'meshtastic') ({ title, fields } = parseMeshtastic(record));
    else if (source === 'weather') ({ title, fields } = parseWeather(record));
    else {
      title = topic;
      fields = Object.entries(record).slice(0, 8).map(([k, v]) => ({ label: k, value: typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v) }));
    }
  } else {
    title = topic;
  }

  return { source, title, fields, payload, rawText: payloadText, receivedAt };
}
