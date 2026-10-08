import { describe, expect, it } from 'vitest';
import { parseSerialStreamLine } from './parser';
import {
  coerceValue,
  flattenMetrics,
  normaliseNodeId,
  parseTelemetryLine,
  parseTelemetryLogLine,
  summariseTelemetry,
  telemetryToCsv,
} from './telemetry';

const ESC = '\u001b';

/**
 * Regression: `KEY_VALUE_RE` keeps the raw value in group 2 and the unquoted
 * inner value in groups 3/4. Reading the wrong group turned EVERY unquoted
 * `key=value` into an empty string and silently lost node attribution — which
 * is precisely the format real firmware logs use. These cases fail if that
 * ordering is ever changed without thought.
 */
describe('unquoted key=value parsing', () => {
  it('reads unquoted values and attributes the node', () => {
    const sample = parseTelemetryLogLine('DEBUG | POSITION node=0x28a9df12 l=33 lat=386993383 rxSNR=6.25');
    expect(sample).not.toBeNull();
    expect(sample!.nodeId).toBe('!28a9df12');
    expect(sample!.metrics.rxSNR).toBe(6.25);
    expect(sample!.metrics.l).toBe(33);
    expect(sample!.metrics.lat).toBeCloseTo(38.699338, 6);
  });

  it('reads double-quoted values without the quotes', () => {
    const sample = parseTelemetryLogLine('Lora RX (node="!a1d7631c" rxSNR="6.25" rxRSSI="-69")');
    expect(sample!.nodeId).toBe('!a1d7631c');
    expect(sample!.metrics.rxSNR).toBe(6.25);
    expect(sample!.metrics.rxRSSI).toBe(-69);
  });

  it('reads single-quoted values without the quotes', () => {
    const sample = parseTelemetryLogLine("frame node='!deadbeef' level='3'");
    expect(sample!.nodeId).toBe('!deadbeef');
    expect(sample!.metrics.level).toBe(3);
  });

  it('handles spaces around the equals sign', () => {
    const sample = parseTelemetryLogLine('Lora RX (transport = 0, WantAck=0, HopLim=3)');
    expect(sample!.metrics.transport).toBe(0);
    expect(sample!.metrics.WantAck).toBe(0);
    expect(sample!.metrics.HopLim).toBe(3);
  });
});

describe('real firmware log lines', () => {
  it('parses a POSITION line from the device console', () => {
    const line =
      `${ESC}[34mDEBUG ${ESC}[0m| 11:36:30 67 [Router] ${ESC}[34mPOSITION node=a1d7631c l=33 ` +
      'lat=386993383 lon=-92322000 msl=105 hae=0 geo=0 pdop=253 hdop=0 vdop=0 siv=8 time=1790681791';
    const [sample] = parseTelemetryLine(line);
    expect(sample.kind).toBe('position');
    expect(sample.nodeId).toBe('!a1d7631c');
    expect(sample.metrics.lat).toBeCloseTo(38.699338, 6);
    expect(sample.metrics.lon).toBeCloseTo(-9.2322, 6);
    expect(sample.metrics.siv).toBe(8);
    expect(sample.sourceTime).toBe(1790681791);
    expect(sample.raw).not.toContain(ESC);
  });

  it('parses a Lora RX line as link telemetry', () => {
    const line =
      'DEBUG | 11:36:30 67 [RadioIf] Lora RX (id=0xda8a127a fr=0xa1d7631c to=0xffffffff, ' +
      'transport = 0, WantAck=0, HopLim=3 Ch=0x41 encrypted len=55 rxSNR=5.75 rxRSSI=-54 hopStart=3 relay=0x1c)';
    const [sample] = parseTelemetryLine(line);
    expect(sample.kind).toBe('link');
    expect(sample.nodeId).toBe('!a1d7631c');
    expect(sample.metrics.rxSNR).toBe(5.75);
    expect(sample.metrics.rxRSSI).toBe(-54);
    expect(sample.metrics.Ch).toBe(0x41);
  });

  it('parses colon-style counters the firmware prints without an equals sign', () => {
    const [status] = parseTelemetryLine('INFO | 11:36:11 48 [Router] Node status update: 4 online, 80 total');
    expect(status.kind).toBe('network');
    expect(status.metrics.nodesOnline).toBe(4);
    expect(status.metrics.nodesTotal).toBe(80);

    const [freq] = parseTelemetryLine('DEBUG | 11:36:04 41 [RadioIf] Corrected frequency offset: -51.343746');
    expect(freq.metrics.frequencyOffsetHz).toBeCloseTo(-51.343746, 6);
  });

  it('ignores GPS probe noise that carries no key=value data', () => {
    for (const line of [
      `${ESC}[34mDEBUG ${ESC}[0m| 11:35:57 34 [GPS] ${ESC}[34mTrying $PDTINFO (Unicore Family)...`,
      `${ESC}[33mWARN  ${ESC}[0m| 11:36:27 64 [GPS] ${ESC}[33mNo GNSS Module (baudrate 9600)`,
      `${ESC}[32mINFO  ${ESC}[0m| 11:36:11 48 [Router] ${ESC}[32mReceived nodeinfo from=0x8ce97125, id=0x23efcfb2, portnum=4, payloadlen=78`,
    ]) {
      const samples = parseTelemetryLine(line);
      // The nodeinfo line legitimately yields portnum/payloadlen — assert that
      // no probe line yields a *position* or bogus empty metric.
      for (const sample of samples) {
        expect(sample.kind).not.toBe('position');
        for (const [key, value] of Object.entries(sample.metrics)) {
          expect(key.length).toBeGreaterThan(0);
          expect(value === '' && key !== 'text').toBe(false);
        }
      }
    }
    expect(parseTelemetryLine('')).toEqual([]);
  });
});

describe('Meshtastic JSON telemetry', () => {
  it('splits one packet into one sample per metrics container', () => {
    const samples = parseTelemetryLine(
      '{"sender":"!a1d7631c","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":87,"voltage":4.02},' +
        '"environmentMetrics":{"temperature":21.4,"relativeHumidity":48.2},"time":1790681791}}'
    );
    expect(samples).toHaveLength(2);
    const kinds = samples.map((s) => s.kind).sort();
    expect(kinds).toEqual(['device', 'environment']);
    for (const sample of samples) expect(sample.nodeId).toBe('!a1d7631c');
    expect(samples.find((s) => s.kind === 'device')!.metrics.batteryLevel).toBe(87);
    expect(samples.find((s) => s.kind === 'environment')!.metrics.temperature).toBe(21.4);
    expect(samples[0].sourceTime).toBe(1790681791);
  });

  it('keeps unknown packet types instead of dropping them', () => {
    const [sample] = parseTelemetryLine('{"from":"!abc","type":"someFutureType","payload":{"weirdField":7,"label":"x"}}');
    expect(sample.metrics.weirdField).toBe(7);
    expect(sample.metrics.label).toBe('x');
    expect(sample.nodeId).toBe('!abc');
  });

  it('scales position integers', () => {
    const [sample] = parseTelemetryLine('{"from":"!abc","type":"position","payload":{"latitudeI":377749000,"longitudeI":-1224194000}}');
    expect(sample.kind).toBe('position');
    expect(sample.metrics.latitudeI).toBeCloseTo(37.7749, 6);
    expect(sample.metrics.longitudeI).toBeCloseTo(-122.4194, 6);
  });

  it('never throws on adversarial JSON', () => {
    for (const line of ['{ unbalanced', '{"a":', '[]', 'null', '{"payload":null}', '{"payload":[1,2]}']) {
      expect(() => parseTelemetryLine(line)).not.toThrow();
    }
  });
});

describe('roll-up and export', () => {
  const samples = parseTelemetryLine(
    '{"sender":"!abc","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":90,"voltage":4.1},"time":1790681791}}'
  ).concat(
    parseTelemetryLine(
      '{"sender":"!abc","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":80,"voltage":4.0},"time":1790681800}}',
      new Date(Date.now() + 1000).toISOString()
    )
  );

  it('rolls samples up per node with latest values and numeric series', () => {
    const [node] = summariseTelemetry(samples);
    expect(node.nodeId).toBe('!abc');
    expect(node.sampleCount).toBe(2);
    expect(node.latest.batteryLevel).toBe(80);
    expect(node.byKind.device!.voltage).toBe(4.0);
    expect(node.series.batteryLevel.map((p) => p.v)).toEqual([90, 80]);
  });

  it('caps the numeric history to the requested length', () => {
    const [node] = summariseTelemetry(samples, 1);
    expect(node.series.batteryLevel).toHaveLength(1);
    expect(node.series.batteryLevel[0].v).toBe(80);
  });

  it('exports a CSV with a column per metric', () => {
    const csv = telemetryToCsv(samples);
    const [header, firstRow] = csv.split('\n');
    expect(header).toContain('receivedAt');
    expect(header).toContain('batteryLevel');
    expect(header).toContain('voltage');
    expect(firstRow).toContain('!abc');
    expect(firstRow.split(',')).toHaveLength(header.split(',').length);
  });
});

describe('value helpers', () => {
  it('agrees with the position parser on node identity', () => {
    // The Nodes panel (fed by parser.ts) and the Telemetry panel must resolve a
    // physical node to exactly one id, or the same radio appears twice.
    for (const line of [
      'DEBUG | POSITION node=0x28a9df12 lat=386993383 lon=-92322000',
      'DEBUG | POSITION node=a1d7631c lat=386993383 lon=-92322000',
      'INFO | updatePosition REMOTE node=0x8ce97125 time=1790681791 lat=386993383 lon=-92322000',
    ]) {
      const position = parseSerialStreamLine(line);
      const [telemetry] = parseTelemetryLine(line);
      expect(position!.node_id).toBe(telemetry.nodeId);
    }
  });

  it('coerces numbers, hex and booleans', () => {
    expect(coerceValue('87')).toBe(87);
    expect(coerceValue('-1.5')).toBe(-1.5);
    expect(coerceValue('0x41')).toBe(65);
    expect(coerceValue('true')).toBe(true);
    expect(coerceValue('SIM1')).toBe('SIM1');
    expect(coerceValue('')).toBe('');
  });

  it('normalises node addresses', () => {
    expect(normaliseNodeId('0xa1d7631c')).toBe('!a1d7631c');
    expect(normaliseNodeId('!A1D7631C')).toBe('!a1d7631c');
    expect(normaliseNodeId('a1d7631c')).toBe('!a1d7631c');
    expect(normaliseNodeId(0x8ce97125)).toBe('!8ce97125');
    expect(normaliseNodeId('not-a-node')).toBeNull();
    expect(normaliseNodeId(null)).toBeNull();
  });

  it('flattens one level of nesting and preserves deeper structures', () => {
    const flat = flattenMetrics({ a: 1, nested: { b: 'x' }, list: [1, 2], skip: null });
    expect(flat).toEqual({ a: 1, b: 'x', list: '[1,2]' });
  });
});
