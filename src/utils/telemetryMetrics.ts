import type { TelemetryValue } from './telemetry';

/**
 * Presentation metadata for telemetry metrics.
 *
 * Meshtastic carries no units or labels on the wire — fields are raw protobuf
 * names (`batteryLevel`, `rxSNR`, …). This table only adds a human label and a
 * unit; anything not listed still renders (raw name, raw value, no unit) so a
 * field is never hidden just because the firmware/iOS build named it
 * differently.
 */

/** Friendly labels. Keys must match the source field names exactly. */
const LABELS: Record<string, string> = {
  batteryLevel: 'Battery level',
  voltage: 'Voltage',
  channelUtilization: 'Channel utilisation',
  airUtilTx: 'Air utilisation (TX)',
  uptimeSeconds: 'Uptime',
  temperature: 'Temperature',
  relativeHumidity: 'Relative humidity',
  barometricPressure: 'Barometric pressure',
  gasResistance: 'Gas resistance',
  current: 'Current',
  iaq: 'Indoor air quality',
  co2: 'CO₂',
  pm10Standard: 'PM1.0 (standard)',
  pm25Standard: 'PM2.5 (standard)',
  pm100Standard: 'PM10 (standard)',
  pm10Environmental: 'PM1.0 (environmental)',
  pm25Environmental: 'PM2.5 (environmental)',
  pm100Environmental: 'PM10 (environmental)',
  particles03um: 'Particles 0.3 µm',
  particles05um: 'Particles 0.5 µm',
  particles10um: 'Particles 1.0 µm',
  particles25um: 'Particles 2.5 µm',
  particles50um: 'Particles 5.0 µm',
  particles100um: 'Particles 10.0 µm',
  heartRate: 'Heart rate',
  spO2: 'SpO₂',
  bodyTemperature: 'Body temperature',
  weight: 'Weight',
  voltage1: 'Voltage channel 1',
  current1: 'Current channel 1',
  ch1Voltage: 'Channel 1 voltage',
  ch1Current: 'Channel 1 current',
  numOnlineNodes: 'Nodes online',
  numTotalNodes: 'Nodes total',
  numPacketsRx: 'Packets received',
  numPacketsTx: 'Packets transmitted',
  numRxDupe: 'Duplicate packets RX',
  numTxDropped: 'Packets dropped TX',
  numTxRelay: 'Packets relayed',
  numRxRelay: 'Packets relayed RX',
  numRxRelayCanceled: 'Relayed packets cancelled',
  numTxRelayCanceled: 'Relayed TX cancelled',
  heapTotalBytes: 'Heap total',
  heapFreeBytes: 'Heap free',
  nodesOnline: 'Nodes online',
  nodesTotal: 'Nodes total',
  nodeDbNodes: 'Node DB entries',
  nodeDbBytesFree: 'Node DB bytes free',
  latitude: 'Latitude',
  longitude: 'Longitude',
  latitudeI: 'Latitude',
  longitudeI: 'Longitude',
  lat: 'Latitude',
  lon: 'Longitude',
  altitude: 'Altitude',
  altitudeHae: 'Altitude (HAE)',
  altitudeMsl: 'Altitude (MSL)',
  msl: 'Altitude (MSL)',
  hae: 'Altitude (HAE)',
  precisionBits: 'Precision bits',
  satsInView: 'Satellites in view',
  siv: 'Satellites in view',
  gpsAccuracy: 'GPS accuracy',
  groundSpeed: 'Ground speed',
  groundTrack: 'Ground track',
  speed: 'Speed',
  heading: 'Heading',
  rxSNR: 'RX SNR',
  rxRSSI: 'RX RSSI',
  hopStart: 'Hop start',
  hopLimit: 'Hop limit',
  freq: 'Frequency',
  frequencyOffsetHz: 'Frequency offset',
  txDelayMs: 'TX delay',
  packetRxMs: 'Packet RX time',
  packetTxMs: 'Packet TX time',
  sortMs: 'Sort time',
  txQueue: 'Packets in TX queue',
  ch: 'Channel',
  channel: 'Channel',
  len: 'Packet length',
  longName: 'Long name',
  shortName: 'Short name',
  hwModel: 'Hardware model',
  hw_model: 'Hardware model',
  role: 'Role',
  id: 'Node id',
  macaddr: 'MAC address',
  isLicensed: 'Licensed operator',
};

/** Units, only where the Meshtastic field has a fixed, known unit. */
const UNITS: Record<string, string> = {
  batteryLevel: '%',
  voltage: 'V',
  voltage1: 'V',
  current: 'A',
  current1: 'A',
  ch1Voltage: 'V',
  ch1Current: 'A',
  channelUtilization: '%',
  airUtilTx: '%',
  uptimeSeconds: 's',
  temperature: '°C',
  bodyTemperature: '°C',
  relativeHumidity: '%',
  barometricPressure: 'hPa',
  gasResistance: 'kOhm',
  iaq: 'IAQ',
  co2: 'ppm',
  heartRate: 'bpm',
  spO2: '%',
  weight: 'kg',
  rxSNR: 'dB',
  rxRSSI: 'dBm',
  frequencyOffsetHz: 'Hz',
  txDelayMs: 'ms',
  packetRxMs: 'ms',
  packetTxMs: 'ms',
  sortMs: 'ms',
  altitude: 'm',
  altitudeHae: 'm',
  altitudeMsl: 'm',
  msl: 'm',
  hae: 'm',
  distance: 'm',
  lat: '°',
  lon: '°',
  latitude: '°',
  longitude: '°',
  latitudeI: '°',
  longitudeI: '°',
  groundSpeed: 'm/s',
  speed: 'km/h',
  heading: '°',
  groundTrack: '°',
  freq: 'Hz',
  heapTotalBytes: 'B',
  heapFreeBytes: 'B',
  nodeDbBytesFree: 'B',
  precisionBits: 'bits',
};

/** Splits `rxSNR` / `batteryLevel` / `pm25_standard` into words. */
function splitWords(name: string): string[] {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const ACRONYMS = new Set([
  'snr',
  'rssi',
  'tx',
  'rx',
  'gps',
  'hae',
  'msl',
  'iaq',
  'pm',
  'db',
  'dbm',
  'id',
  'mac',
  'siv',
  'sats',
  'hw',
  'usb',
  'voc',
  'eco2',
  'tvoc',
]);

/** Fallback label for a field we have no friendly name for. */
export function friendlyMetricLabel(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  const words = splitWords(name).map((word) =>
    ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()
  );
  if (words.length === 0) return name;
  const [first, ...rest] = words;
  const sentence = [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
  return sentence;
}

/** Unit for a field, or `null` when unknown (raw value is shown as-is). */
export function metricUnit(name: string): string | null {
  return UNITS[name] ?? null;
}

/** Formats a metric value for display: numbers trimmed, booleans spelled out. */
export function formatMetricValue(value: TelemetryValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(1);
    if (abs >= 10) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    // Coordinates and small sensors keep more precision.
    return value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  }
  return value;
}

export type MetricTone = 'number' | 'text';

/** `number` for finite numeric metrics (sparkline-capable), else `text`. */
export function metricTone(value: TelemetryValue): MetricTone {
  return typeof value === 'number' && Number.isFinite(value) ? 'number' : 'text';
}
