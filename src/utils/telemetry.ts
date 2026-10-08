/**
 * Generic telemetry capture for everything arriving from the Meshtastic network.
 *
 * Design goal: **never drop a field**. Meshtastic ships a growing set of packet
 * types (device, environment, air-quality, health, power, local stats, position
 * quality, node info, link/radio counters, ...), and firmware builds differ in
 * what they print. So this module does not model a fixed schema: it flattens
 * whatever key/value data a line carries into metrics, tags the sample with a
 * coarse {@link TelemetryKind}, and lets the UI render whatever showed up.
 *
 * Two input families are understood:
 *
 *  1. The firmware's colourised console log, e.g.
 *       POSITION node=a1d7631c l=33 lat=386993383 lon=-92322000 msl=105 ... siv=8
 *       Lora RX (fr=0xc931be04 ... Ch=0x41 len=93 rxSNR=6.25 rxRSSI=-69 hopStart=3)
 *       Node status update: 4 online, 80 total
 *       Corrected frequency offset: -105.593750
 *  2. Meshtastic JSON packets, e.g.
 *       {"sender":"!a1d7631c","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":87,...}}}
 *       {"from":"!a1d7631c","type":"position","payload":{"latitudeI":...,"longitudeI":...}}
 *
 * Nothing in here throws: unparseable input yields an empty result.
 */

import { stripAnsi } from './parser';

/** Coarse bucket used for grouping/colouring metrics in the UI. */
export type TelemetryKind =
  | 'device'
  | 'environment'
  | 'airQuality'
  | 'health'
  | 'power'
  | 'localStats'
  | 'position'
  | 'link'
  | 'nodeinfo'
  | 'network'
  | 'unknown';

/** Every kind, in display order. */
export const TELEMETRY_KINDS: readonly TelemetryKind[] = [
  'device',
  'power',
  'environment',
  'airQuality',
  'health',
  'localStats',
  'position',
  'link',
  'nodeinfo',
  'network',
  'unknown',
];

export type TelemetryValue = number | string | boolean;

/** One parsed batch of metrics from one node, from one line/packet. */
export interface TelemetrySample {
  id: string;
  /** Normalised node address (`!a1d7631c`) or `null` for network-wide lines. */
  nodeId: string | null;
  /** ISO time at which the dashboard received it. */
  receivedAt: string;
  /** Device-provided epoch seconds when the source carried one. */
  sourceTime: number | null;
  kind: TelemetryKind;
  /** Flattened `name -> value` metrics; names are the source's own field names. */
  metrics: Record<string, TelemetryValue>;
  /** ANSI-free source text, for the packet log and debugging. */
  raw: string;
}

/** JSON container names Meshtastic uses, mapped to our kinds. */
const JSON_CONTAINERS: Record<string, TelemetryKind> = {
  deviceMetrics: 'device',
  powerMetrics: 'power',
  environmentMetrics: 'environment',
  airQualityMetrics: 'airQuality',
  healthMetrics: 'health',
  localStats: 'localStats',
  positionMetrics: 'position',
};

/** Log markers that decide the kind, checked in order. */
const LOG_KIND_MARKERS: ReadonlyArray<readonly [RegExp, TelemetryKind]> = [
  [/\bPOSITION\b|updatePosition/i, 'position'],
  [/\brxSNR\b|\brxRSSI\b|[Ll]ora\s+RX|[Ll]ora\s+TX/, 'link'],
  [/\bReceived\s+nodeinfo\b|NodeInfo/, 'nodeinfo'],
  [/\bNode status update\b|nodes and \d+ bytes free|Adding node to database/i, 'network'],
];

/** Field names that are counters/link quality rather than a specific metric. */
const NODE_ID_KEYS = ['node', 'from', 'fr', 'sender', 'node_id', 'nodeId'];

let sampleSeq = 0;
const nextId = () => `tm-${Date.now().toString(36)}-${(sampleSeq++).toString(36)}`;

/**
 * Normalises a Meshtastic node address to `!<lowercase hex>`.
 *
 * Deliberately does NOT zero-pad: the position parser (`parser.ts`) builds ids
 * straight from the source token, and the Nodes panel and the Telemetry panel
 * must agree on one identity per physical node. Real hardware always reports 8
 * hex digits, so in practice both forms are identical; short synthetic ids from
 * tests or hand-written payloads stay consistent instead of splitting into two
 * aliases for the same node.
 */
export function normaliseNodeId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return `!${(raw >>> 0).toString(16)}`;
  }
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('!')) value = value.slice(1);
  if (value.startsWith('0x')) value = value.slice(2);
  if (!/^[0-9a-f]{1,8}$/.test(value)) return null;
  return `!${value}`;
}

/** Parses `123`, `-1.5`, `0x41`, `true`/`false`; otherwise returns the string. */
export function coerceValue(raw: string): TelemetryValue {
  const value = raw.trim();
  if (!value) return '';
  if (/^-?\d+$/.test(value)) {
    const asInt = Number(value);
    // Keep huge integers exact-looking rather than losing precision silently.
    return Number.isSafeInteger(asInt) ? asInt : value;
  }
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

/**
 * Meshtastic logs latitude/longitude as 1e7-scaled integers; values with a
 * decimal point are already degrees. Mirrors the rule in `parser.ts`.
 */
const SCALED_DEGREE_KEYS = /^(latitude_i|longitude_i|latitudeI|longitudeI)$/;
const PLAIN_DEGREE_KEYS = /^(lat|lon|latitude|longitude)$/i;

function scaleCoordinate(name: string, value: TelemetryValue): TelemetryValue {
  if (typeof value !== 'number') return value;
  if (SCALED_DEGREE_KEYS.test(name)) return value / 1e7;
  if (PLAIN_DEGREE_KEYS.test(name)) return Math.abs(value) > 180 ? value / 1e7 : value;
  return value;
}

/**
 * Flattens a nested object to `leafName -> value`.
 *
 * Only the first level of nesting is flattened (that is all Meshtastic uses);
 * deeper structures are JSON-encoded so nothing is lost.
 */
export function flattenMetrics(source: Record<string, unknown>): Record<string, TelemetryValue> {
  const out: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = JSON.stringify(value);
    } else if (typeof value === 'object') {
      const nested = flattenMetrics(value as Record<string, unknown>);
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        out[nestedKey] = nestedValue;
      }
    }
  }
  return out;
}

/** Pulls the node address out of a set of metrics, removing the id keys. */
function takeNodeId(metrics: Record<string, TelemetryValue>): string | null {
  for (const key of NODE_ID_KEYS) {
    if (key in metrics) {
      const nodeId = normaliseNodeId(metrics[key]);
      delete metrics[key];
      if (nodeId) return nodeId;
    }
  }
  return null;
}

/** All `key=value` pairs in a log line (values may be quoted or hex). */
const KEY_VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s,)]+)/g;

/** `Label: number` fragments the firmware prints without an `=`. */
const COLON_METRICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Corrected frequency offset:\s*(-?\d+(?:\.\d+)?)/i, 'frequencyOffsetHz'],
  [/Setting tx delay:\s*(\d+)/i, 'txDelayMs'],
  [/Packet RX:\s*(\d+)\s*ms/i, 'packetRxMs'],
  [/Packet TX:\s*(\d+)\s*ms/i, 'packetTxMs'],
  [/Sort took\s+(\d+)\s+milliseconds/i, 'sortMs'],
  [/(\d+)\s+online,\s*(\d+)\s+total/i, '__nodeStatus'],
  [/(\d+)\s+nodes and\s+(\d+)\s+bytes free/i, '__nodeDb'],
  [/(\d+)\s+packets remain in the TX queue/i, 'txQueue'],
];

/** Turns one firmware log line into at most one sample. */
export function parseTelemetryLogLine(line: string, receivedAt = new Date().toISOString()): TelemetrySample | null {
  const text = stripAnsi(line);
  if (!text.trim()) return null;

  const metrics: Record<string, TelemetryValue> = {};

  for (const match of text.matchAll(KEY_VALUE_RE)) {
    const key = match[1];
    // Groups: 2 = raw value (quotes included), 3 = double-quoted inner,
    // 4 = single-quoted inner. Prefer the inner form so quotes are dropped,
    // and fall back to the raw token for unquoted values (the common case in
    // real firmware logs, e.g. `node=a1d7631c lat=386993383`).
    const raw = match[3] ?? match[4] ?? match[2] ?? '';
    metrics[key] = scaleCoordinate(key, coerceValue(raw));
  }

  for (const [pattern, name] of COLON_METRICS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (name === '__nodeStatus') {
      metrics.nodesOnline = Number(match[1]);
      metrics.nodesTotal = Number(match[2]);
    } else if (name === '__nodeDb') {
      metrics.nodeDbNodes = Number(match[1]);
      metrics.nodeDbBytesFree = Number(match[2]);
    } else {
      metrics[name] = Number(match[1]);
    }
  }

  if (Object.keys(metrics).length === 0) return null;

  const nodeId = takeNodeId(metrics);

  let kind: TelemetryKind = 'unknown';
  for (const [pattern, candidate] of LOG_KIND_MARKERS) {
    if (pattern.test(text)) {
      kind = candidate;
      break;
    }
  }
  if (kind === 'unknown' && (metrics.rxSNR !== undefined || metrics.rxRSSI !== undefined)) {
    kind = 'link';
  }

  const sourceTime =
    typeof metrics.time === 'number' && metrics.time > 1_000_000_000 ? metrics.time : null;
  if (sourceTime !== null) delete metrics.time;

  return {
    id: nextId(),
    nodeId,
    receivedAt,
    sourceTime,
    kind,
    metrics,
    raw: text.trim(),
  };
}

/** Maps a Meshtastic JSON packet to one sample per metrics container it carries. */
export function parseTelemetryJson(line: string, receivedAt = new Date().toISOString()): TelemetrySample[] {
  const match = line.match(/\{.*\}/);
  if (!match) return [];

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    data = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const payload = (data.payload && typeof data.payload === 'object' ? data.payload : data) as Record<string, unknown>;
  const nodeId =
    normaliseNodeId(data.from) ??
    normaliseNodeId(data.sender) ??
    normaliseNodeId(data.node_id) ??
    normaliseNodeId(payload.from);

  const sourceTimeRaw = payload.time ?? data.time;
  const sourceTime = typeof sourceTimeRaw === 'number' && sourceTimeRaw > 1_000_000_000 ? sourceTimeRaw : null;

  const samples: TelemetrySample[] = [];

  for (const [container, kind] of Object.entries(JSON_CONTAINERS)) {
    const value = payload[container] ?? data[container];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const metrics = flattenMetrics(value as Record<string, unknown>);
    if (Object.keys(metrics).length === 0) continue;
    samples.push({ id: nextId(), nodeId, receivedAt, sourceTime, kind, metrics, raw: line.trim() });
  }

  if (samples.length > 0) return samples;

  // Position packets and anything else flat: keep everything we did not model.
  const flat = flattenMetrics(payload);
  const metrics: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key === 'time') continue;
    metrics[key] = scaleCoordinate(key, value);
  }
  if (Object.keys(metrics).length === 0) return [];

  const type = typeof data.type === 'string' ? data.type.toLowerCase() : '';
  let kind: TelemetryKind = 'unknown';
  if (type === 'position' || 'latitudeI' in metrics || 'latitude_i' in metrics || 'lat' in metrics) kind = 'position';
  else if (type === 'nodeinfo' || type === 'user' || 'longName' in metrics || 'shortName' in metrics) kind = 'nodeinfo';
  else if (type === 'routing' || type === 'packet') kind = 'link';

  samples.push({ id: nextId(), nodeId, receivedAt, sourceTime, kind, metrics, raw: line.trim() });
  return samples;
}

/** Unified telemetry entry point: JSON first, then firmware log. */
export function parseTelemetryLine(line: string, receivedAt = new Date().toISOString()): TelemetrySample[] {
  if (!line || !line.trim()) return [];
  if (line.includes('{') && line.includes('}')) {
    const json = parseTelemetryJson(line, receivedAt);
    if (json.length > 0) return json;
  }
  const log = parseTelemetryLogLine(line, receivedAt);
  return log ? [log] : [];
}

/** Per-node roll-up used by the telemetry dashboard, OSC and MIDI outputs. */
export interface NodeTelemetry {
  nodeId: string;
  /** Newest sample time (ISO). */
  lastSeen: string;
  /** Total samples retained for this node. */
  sampleCount: number;
  /** Latest value of every metric seen, keyed by metric name. */
  latest: Record<string, TelemetryValue>;
  /** Latest values grouped by kind. */
  byKind: Partial<Record<TelemetryKind, Record<string, TelemetryValue>>>;
  /** Numeric metric histories, oldest first, capped at `maxSeriesPoints`. */
  series: Record<string, Array<{ t: number; v: number }>>;
}

/**
 * Rolls samples up per node.
 *
 * @param maxSeriesPoints how many numeric history points to keep per metric
 *        (older points are dropped) — the dashboard only needs recent history.
 * @returns nodes sorted by most-recently-heard first.
 */
export function summariseTelemetry(samples: TelemetrySample[], maxSeriesPoints = 240): NodeTelemetry[] {
  const nodes = new Map<string, NodeTelemetry>();

  for (const sample of samples) {
    const key = sample.nodeId ?? 'local';
    let node = nodes.get(key);
    if (!node) {
      node = { nodeId: key, lastSeen: sample.receivedAt, sampleCount: 0, latest: {}, byKind: {}, series: {} };
      nodes.set(key, node);
    }

    node.sampleCount += 1;
    if (Date.parse(sample.receivedAt) >= Date.parse(node.lastSeen)) node.lastSeen = sample.receivedAt;

    const bucket = (node.byKind[sample.kind] ??= {});
    for (const [metric, value] of Object.entries(sample.metrics)) {
      node.latest[metric] = value;
      bucket[metric] = value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const series = (node.series[metric] ??= []);
        series.push({ t: Date.parse(sample.receivedAt), v: value });
        if (series.length > maxSeriesPoints) series.splice(0, series.length - maxSeriesPoints);
      }
    }
  }

  return [...nodes.values()].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

/** Flat CSV of every sample, for spreadsheets and external analysis. */
export function telemetryToCsv(samples: TelemetrySample[]): string {
  const metricNames = [...new Set(samples.flatMap((s) => Object.keys(s.metrics)))].sort();
  const header = ['receivedAt', 'sourceTime', 'nodeId', 'kind', ...metricNames];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = samples.map((sample) =>
    [
      sample.receivedAt,
      sample.sourceTime ?? '',
      sample.nodeId ?? '',
      sample.kind,
      ...metricNames.map((name) => (name in sample.metrics ? sample.metrics[name] : '')),
    ]
      .map(escape)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}
