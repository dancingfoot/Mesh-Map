import { describe, expect, it } from 'vitest';
import { GpsPoint } from '../types';
import {
  parseMeshtasticJson,
  parseMeshtasticLogLine,
  parseNmeaCoordinate,
  parseNmeaSentence,
  parseSerialStreamLine,
  stripAnsi,
} from './parser';

const ESC = '\u001b';

/** Builds a packet with sensible defaults so each case states only what matters. */
function packet(overrides: Partial<GpsPoint> = {}): GpsPoint {
  return {
    id: 'test',
    latitude: 0,
    longitude: 0,
    source: 'test',
    timestamp: new Date().toISOString(),
    raw: '',
    ...overrides,
  };
}

const GGA = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
const RMC = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A';

// Real lines captured from a Meshtastic node's USB serial console.
const LOG_POSITION =
  `${ESC}[34mDEBUG ${ESC}[0m| 11:36:30 67 [Router] ${ESC}[34mPOSITION node=a1d7631c l=33 ` +
  'lat=386993383 lon=-92322000 msl=105 hae=0 geo=0 pdop=253 hdop=0 vdop=0 siv=8 fxq=0 fxt=0 pts=0 time=1790681791';
const LOG_UPDATE =
  `${ESC}[32mINFO  ${ESC}[0m| 11:36:30 67 [Router] ${ESC}[32mupdatePosition REMOTE ` +
  'node=0xa1d7631c time=1790681791 lat=386993383 lon=-92322000';
const LOG_NOISE = [
  `${ESC}[34mDEBUG ${ESC}[0m| 11:35:57 34 [GPS] ${ESC}[34mTrying $PDTINFO (Unicore Family)...`,
  `${ESC}[34mDEBUG ${ESC}[0m| 11:35:58 35 [GPS] ${ESC}[34mTrying $PCAS06,1*1A (ATGM33xx Family)...`,
  `${ESC}[33mWARN  ${ESC}[0m| 11:36:27 64 [GPS] ${ESC}[33mGive up on GPS probe and set to 9600`,
  `${ESC}[32mINFO  ${ESC}[0m| 11:36:11 48 [Router] ${ESC}[32mReceived nodeinfo from=0x8ce97125, id=0x23efcfb2, portnum=4, payloadlen=78`,
  `${ESC}[34mDEBUG ${ESC}[0m| 11:35:59 36 [NodeInfo] ${ESC}[34mSend our nodeinfo to mesh (wantReplies=0)`,
];

describe('NMEA', () => {
  it('converts ddmm.mmmm to decimal degrees', () => {
    expect(parseNmeaCoordinate('4807.038', 'N')).toBeCloseTo(48.1173, 6);
    expect(parseNmeaCoordinate('01131.000', 'E')).toBeCloseTo(11.516667, 6);
  });

  it('negates southern and western hemispheres', () => {
    expect(parseNmeaCoordinate('4807.038', 'S')).toBeLessThan(0);
    expect(parseNmeaCoordinate('01131.000', 'W')).toBeLessThan(0);
  });

  it('returns null for unusable input instead of NaN', () => {
    expect(parseNmeaCoordinate('', 'N')).toBeNull();
    expect(parseNmeaCoordinate('abc', 'N')).toBeNull();
  });

  it('parses a GGA fix', () => {
    const fix = parseNmeaSentence(GGA);
    expect(fix).not.toBeNull();
    expect(fix!.latitude).toBeCloseTo(48.1173, 4);
    expect(fix!.longitude).toBeCloseTo(11.516667, 4);
    expect(fix!.altitude).toBe(545.4);
    expect(fix!.satellites).toBe(8);
    expect(fix!.source).toBe('NMEA (GPGGA)');
  });

  it('parses an RMC fix and converts knots to km/h', () => {
    expect(parseNmeaSentence(RMC)!.speed_kmh).toBe(41.5);
  });

  it('keeps a genuine zero speed as 0, not null', () => {
    const fix = parseNmeaSentence('$GPRMC,123519,A,4807.038,N,01131.000,E,0.0,084.4,230394,003.1,W');
    expect(fix!.speed_kmh).toBe(0);
  });

  it('ignores incomplete or unknown sentences', () => {
    for (const line of ['$GPGGA,,,,,,0,00,,,M,,M,,*00', '$', '$$$', '$GPRMC,1,V,,,,,,,']) {
      expect(parseNmeaSentence(line)).toBeNull();
    }
  });
});

describe('Meshtastic JSON', () => {
  it('parses scaled integers inside payload', () => {
    const fix = parseMeshtasticJson(
      '{"from":"!28a9df12","type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":42}}'
    );
    expect(fix!.latitude).toBeCloseTo(37.7749, 6);
    expect(fix!.longitude).toBeCloseTo(-122.4194, 6);
    expect(fix!.altitude).toBe(42);
    expect(fix!.node_id).toBe('!28a9df12');
  });

  it('accepts the camelCase scaled keys in payload, root and decoded.position', () => {
    const payload = parseMeshtasticJson('{"type":"position","payload":{"latitudeI":377749000,"longitudeI":-1224194000}}');
    const root = parseMeshtasticJson('{"type":"position","latitudeI":377749000,"longitudeI":-1224194000}');
    const decoded = parseMeshtasticJson(
      '{"sender":"^all","decoded":{"position":{"latitudeI":377749000,"longitudeI":-1224194000}}}'
    );
    for (const fix of [payload, root, decoded]) {
      expect(fix!.latitude).toBeCloseTo(37.7749, 6);
    }
    expect(decoded!.node_id).toBe('^all');
  });

  it('accepts plain float degrees', () => {
    const fix = parseMeshtasticJson('{"type":"position","lat":37.7749,"lon":-122.4194}');
    expect(fix!.latitude).toBeCloseTo(37.7749, 6);
  });

  it('keeps a sea-level altitude of 0', () => {
    expect(parseMeshtasticJson('{"type":"position","lat":37.0,"lon":-122.0,"altitude":0}')!.altitude).toBe(0);
  });
});

describe('Meshtastic firmware console log', () => {
  it('strips ANSI escapes', () => {
    expect(stripAnsi(`${ESC}[34mDEBUG ${ESC}[0m| x`)).toBe('DEBUG | x');
  });

  it('parses a POSITION line', () => {
    const fix = parseSerialStreamLine(LOG_POSITION);
    expect(fix).not.toBeNull();
    expect(fix!.latitude).toBeCloseTo(38.699338, 6);
    expect(fix!.longitude).toBeCloseTo(-9.2322, 6);
    expect(fix!.altitude).toBe(105);
    expect(fix!.node_id).toBe('!a1d7631c');
    expect(fix!.source).toBe('Meshtastic Log');
    expect(fix!.raw).not.toContain(ESC);
  });

  it('parses an updatePosition line and normalises the 0x node prefix', () => {
    const fix = parseMeshtasticLogLine(LOG_UPDATE);
    expect(fix!.latitude).toBeCloseTo(38.699338, 6);
    expect(fix!.node_id).toBe('!a1d7631c');
  });

  it('does not rescale values that are already decimal degrees', () => {
    const fix = parseMeshtasticLogLine('INFO | position: lat=38.6993383 lon=-9.2322 alt=105');
    expect(fix!.latitude).toBeCloseTo(38.699338, 6);
    expect(fix!.longitude).toBeCloseTo(-9.2322, 6);
  });

  it('ignores GPS probe, nodeinfo and warning noise', () => {
    for (const line of LOG_NOISE) {
      expect(parseSerialStreamLine(line)).toBeNull();
    }
  });
});

describe('malformed telemetry never throws', () => {
  const malformed = [
    '{"type":"position","lat":null,"lon":null}',
    '{"type":"position","lat":"N/A","lon":"N/A"}',
    '{"type":"position","payload":{"latitude_i":"oops","longitude_i":5}}',
    '{"type":"position","payload":{"latitude":1e400,"longitude":0.5}}',
    '{"lat":true,"lon":false}',
    '{"type":"position","lat":0,"lon":0}',
    '{"type":"position","lat":91,"lon":181}',
    'no json at all',
    '{ unbalanced',
    '',
    '   ',
  ];

  it.each(malformed)('returns null for %j', (line: string) => {
    expect(() => parseSerialStreamLine(line)).not.toThrow();
    expect(parseSerialStreamLine(line)).toBeNull();
  });
});

describe('parseSerialStreamLine dispatch', () => {
  it('routes each family to its own source label', () => {
    expect(parseSerialStreamLine(GGA)!.source).toBe('NMEA (GPGGA)');
    expect(parseSerialStreamLine('{"lat":37.7749,"lon":-122.4194}')!.source).toBe('Meshtastic JSON');
    expect(parseSerialStreamLine(LOG_POSITION)!.source).toBe('Meshtastic Log');
  });

  it('prefers JSON when a line contains both JSON and key/value text', () => {
    const mixed = '{"lat":37.7749,"lon":-122.4194} trailing lat=1 lon=2';
    expect(parseSerialStreamLine(mixed)!.source).toBe('Meshtastic JSON');
  });

  it('builds packets that satisfy the GpsPoint shape', () => {
    const fix = parseSerialStreamLine(LOG_POSITION)!;
    expect(packet({ ...fix }).latitude).toBeCloseTo(38.699338, 6);
    expect(typeof fix.id).toBe('string');
    expect(typeof fix.timestamp).toBe('string');
  });
});
