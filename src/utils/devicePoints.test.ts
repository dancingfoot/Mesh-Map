/**
 * Fixes that arrive over the phone-API stream (protobuf `MeshPacket` frames),
 * and the de-duplication that keeps them from doubling the text log's copy of
 * the same packet.
 *
 * Field numbers are the ones verified against `meshtastic/protobufs`:
 *   FromRadio.packet = 2 · MeshPacket.from = 1 (fixed32) · MeshPacket.decoded = 4
 *   Data.portnum = 1 · Data.payload = 2
 *   Position.latitude_i = 1 (sfixed32) · longitude_i = 2 (sfixed32)
 *   Position.altitude = 3 (int32) · time = 4 (fixed32) · sats_in_view = 19
 */
import { describe, expect, it } from 'vitest';
import { decodeFromRadioPacket, MeshtasticStreamScanner } from './meshtasticProtocol';
import { appendPoints, devicePositionToPoint, isDuplicateFix } from './devicePoints';
import { decodeFromRadioLastKnownPosition } from './meshtasticProtocol';
import type { GpsPoint } from '../types';

/* -------------------------------------------------------------------------- */
/* protobuf builders (hand-rolled: no protobuf dependency)                     */
/* -------------------------------------------------------------------------- */

const varint = (value: number): number[] => {
  // Negatives use protobuf's 10-byte two's-complement form (as a device below
  // sea level really sends them), so this mirrors the wire format exactly.
  // BigInt keeps the 10-byte two's-complement form exact (a float64 cannot).
  let v = value < 0 ? BigInt(value) & 0xffffffffffffffffn : BigInt(value);
  const out: number[] = [];
  while (v > 127n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};

const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);

const le32 = (value: number): number[] => {
  const u = value < 0 ? value + 0x100000000 : value;
  return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
};

const bytesField = (field: number, bytes: number[]): number[] => [
  ...tag(field, 2),
  ...varint(bytes.length),
  ...bytes,
];

const positionPayload = (opts: {
  latI: number;
  lonI: number;
  altitude?: number;
  time?: number;
  sats?: number;
}): number[] => {
  const out: number[] = [...tag(1, 5), ...le32(opts.latI), ...tag(2, 5), ...le32(opts.lonI)];
  if (opts.altitude !== undefined) out.push(...tag(3, 0), ...varint(opts.altitude));
  if (opts.time !== undefined) out.push(...tag(4, 5), ...le32(opts.time));
  if (opts.sats !== undefined) out.push(...tag(19, 0), ...varint(opts.sats));
  return out;
};

/** A `FromRadio.node_info` frame, optionally carrying that node's last fix. */
const nodeInfoFrame = (opts: {
  num: number;
  id: string;
  longName: string;
  shortName: string;
  position?: { latI: number; lonI: number; altitude?: number; time?: number } | null;
}): number[] => {
  const user = [
    ...bytesField(1, [...new TextEncoder().encode(opts.id)]),
    ...bytesField(2, [...new TextEncoder().encode(opts.longName)]),
    ...bytesField(3, [...new TextEncoder().encode(opts.shortName)]),
  ];
  const nodeInfo = [...tag(1, 0), ...varint(opts.num), ...bytesField(2, user)];
  if (opts.position) {
    nodeInfo.push(...bytesField(3, positionPayload(opts.position)));
  }
  const fromRadio = bytesField(4, nodeInfo);
  return [0x94, 0xc3, (fromRadio.length >> 8) & 0xff, fromRadio.length & 0xff, ...fromRadio];
};

/** A whole `FromRadio.packet` frame carrying a position. */
const positionFrame = (opts: {
  from: number;
  latI: number;
  lonI: number;
  altitude?: number;
  time?: number;
  sats?: number;
  portnum?: number;
}): number[] => {
  const data = [
    ...tag(1, 0),
    ...varint(opts.portnum ?? 3), // 3 = POSITION_APP
    ...bytesField(
      2,
      positionPayload({
        latI: opts.latI,
        lonI: opts.lonI,
        altitude: opts.altitude,
        time: opts.time,
        sats: opts.sats,
      })
    ),
  ];
  const meshPacket = [...tag(1, 5), ...le32(opts.from), ...bytesField(4, data)];
  const fromRadio = bytesField(2, meshPacket);
  return [0x94, 0xc3, (fromRadio.length >> 8) & 0xff, fromRadio.length & 0xff, ...fromRadio];
};

/* -------------------------------------------------------------------------- */

describe('positions from the phone-API stream', () => {
  it('decodes a real-looking Lisbon fix', () => {
    // 38.6994523, -9.2322213 as the firmware sends them (degrees * 1e7)
    const payload = positionFrame({
      from: 0x4058f711,
      latI: 386994523,
      lonI: -92322213,
      altitude: 28,
      time: 1790862711,
      sats: 16,
    }).slice(4);

    expect(decodeFromRadioPacket(Uint8Array.from(payload))).toEqual({
      nodeId: '!4058f711',
      latitude: 38.6994523,
      longitude: -9.2322213,
      altitude: 28,
      satellites: 16,
      time: 1790862711,
    });
  });

  it('is surfaced by the scanner alongside node names', () => {
    const scanner = new MeshtasticStreamScanner();
    const result = scanner.push(
      Uint8Array.from(positionFrame({ from: 0x4058f711, latI: 386994523, lonI: -92322213, altitude: 28 }))
    );

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].nodeId).toBe('!4058f711');
    expect(result.positions[0].latitude).toBeCloseTo(38.6994523, 6);
    expect(result.positions[0].longitude).toBeCloseTo(-9.2322213, 6);
  });

  it('ignores a MeshPacket that is not a position', () => {
    // portnum 67 = TELEMETRY_APP, as seen in the field log
    const frame = positionFrame({ from: 0xa1d7631c, latI: 1, lonI: 2, portnum: 67 });
    const scanner = new MeshtasticStreamScanner();
    expect(scanner.push(Uint8Array.from(frame)).positions).toHaveLength(0);
  });

  it('rejects the (0,0) "no fix" placeholder', () => {
    const frame = positionFrame({ from: 0x4058f711, latI: 0, lonI: 0 });
    expect(decodeFromRadioPacket(Uint8Array.from(frame.slice(4)))).toBeNull();
  });

  it('survives a frame split across chunks', () => {
    const frame = positionFrame({ from: 0x8ce97125, latI: 387000000, lonI: -92330000, altitude: 12 });
    const scanner = new MeshtasticStreamScanner();
    const seen: number[] = [];
    for (const byte of frame) {
      const r = scanner.push(Uint8Array.from([byte]));
      r.positions.forEach((p) => seen.push(p.latitude));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(38.7, 6);
  });

  it('handles negative altitude and southern/western hemispheres', () => {
    const payload = positionFrame({
      from: 0xdeadbeef,
      latI: -338688000, // -33.8688 (Sydney)
      lonI: 1512093000, // 151.2093
      altitude: -7,
    }).slice(4);
    const decoded = decodeFromRadioPacket(Uint8Array.from(payload));
    expect(decoded?.latitude).toBeCloseTo(-33.8688, 6);
    expect(decoded?.longitude).toBeCloseTo(151.2093, 6);
    expect(decoded?.altitude).toBe(-7);
  });

  it('counts unique node names for diagnostics', () => {
    const scanner = new MeshtasticStreamScanner();
    const nameless = scanner.push(Uint8Array.from(positionFrame({ from: 0x4058f711, latI: 1, lonI: 2 })));
    expect(nameless.knownNodeNames).toBe(0); // a position is not a name
  });
});

describe('last known positions from the node database', () => {
  const frame = nodeInfoFrame({
    num: 0x4058f711,
    id: '!4058f711',
    longName: 'Lisboa Relay',
    shortName: 'LIS',
    position: { latI: 386994523, lonI: -92322213, altitude: 28, time: 1790862711 },
  });

  it('decodes the position embedded in a NodeInfo', () => {
    expect(decodeFromRadioLastKnownPosition(Uint8Array.from(frame.slice(4)))).toEqual({
      nodeId: '!4058f711',
      latitude: 38.6994523,
      longitude: -9.2322213,
      altitude: 28,
      satellites: null,
      time: 1790862711,
    });
  });

  it('surfaces it separately from live fixes, so it can be marked stale', () => {
    const result = new MeshtasticStreamScanner().push(Uint8Array.from(frame));
    expect(result.positions).toHaveLength(0); // nothing live
    expect(result.lastKnownPositions).toHaveLength(1);
    expect(result.lastKnownPositions[0].nodeId).toBe('!4058f711');
    expect(result.nodeInfos[0].longName).toBe('Lisboa Relay'); // names still work
  });

  it('ignores a database entry whose position is the (0,0) placeholder', () => {
    const noFix = nodeInfoFrame({
      num: 0x8ce97125,
      id: '!8ce97125',
      longName: 'No Fix Yet',
      shortName: 'NFY',
      position: { latI: 0, lonI: 0 },
    });
    expect(new MeshtasticStreamScanner().push(Uint8Array.from(noFix)).lastKnownPositions).toHaveLength(0);
  });

  it('ignores a NodeInfo that carries no position at all', () => {
    const nameOnly = nodeInfoFrame({ num: 1, id: '!00000001', longName: 'A', shortName: 'A' });
    expect(new MeshtasticStreamScanner().push(Uint8Array.from(nameOnly)).lastKnownPositions).toHaveLength(0);
  });

  it('marks the converted point as stale with a distinct source', () => {
    const stale = devicePositionToPoint(
      { nodeId: '!4058f711', latitude: 38.6994523, longitude: -9.2322213, altitude: 28, satellites: null, time: 1790862711 },
      0,
      true
    );
    expect(stale.isStale).toBe(true);
    expect(stale.source).toBe('Node DB (last known)');
    expect(stale.id.startsWith('db-')).toBe(true);
  });

  it('lets a live fix replace a stale one at the same coordinates', () => {
    // Critical: if the database fix blocked the live packet at the same spot,
    // the node would stay marked stale forever.
    const stale = devicePositionToPoint(
      { nodeId: '!4058f711', latitude: 38.6994523, longitude: -9.2322213, altitude: 28, satellites: null, time: 1790862711 },
      0,
      true
    );
    const live = devicePositionToPoint(
      { nodeId: '!4058f711', latitude: 38.6994523, longitude: -9.2322213, altitude: 28, satellites: 9, time: 1790862999 },
      0,
      false
    );

    const withStale = appendPoints([], [stale]);
    const withBoth = appendPoints(withStale, [live]);
    expect(withBoth).toHaveLength(2);
    expect(withBoth.some((p) => !p.isStale)).toBe(true);
  });

  it('still de-duplicates repeats within the same class', () => {
    const stale = devicePositionToPoint(
      { nodeId: '!a', latitude: 1, longitude: 2, altitude: null, satellites: null, time: 5 },
      0,
      true
    );
    expect(appendPoints(appendPoints([], [stale]), [stale])).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

const point = (over: Partial<GpsPoint> = {}): GpsPoint => ({
  id: 'p',
  latitude: 38.6994523,
  longitude: -9.2322213,
  altitude: 28,
  node_id: '!4058f711',
  source: 'Meshtastic Log',
  timestamp: '2026-10-01T13:51:51.000Z',
  raw: '',
  ...over,
});

describe('de-duplicating one fix that arrives twice', () => {
  it('drops the immediate text duplicate (POSITION + updatePosition)', () => {
    const first = appendPoints([], [point()]);
    const second = appendPoints(first, [point({ id: 'p2', altitude: null })]);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // same reference => no re-render
  });

  it('drops an API copy that landed a few points later', () => {
    const others = Array.from({ length: 3 }, (_, i) =>
      point({ id: `p${i}`, latitude: 20 + i, longitude: 30 + i, node_id: '!other' })
    );
    const withFix = appendPoints(others, [point()]);
    expect(withFix).toHaveLength(4);

    // The same fix arriving again from the API stream must not add a point.
    const apiCopy = appendPoints(withFix, [
      point({ id: 'api', source: 'Meshtastic API', altitude: null }),
    ]);
    expect(apiCopy).toHaveLength(4);
    expect(apiCopy).toBe(withFix);
  });

  it('only looks back a bounded window, so a track cannot grow forever', () => {
    // A repeated fix older than the window is treated as new — bounded memory
    // matters more than catching a duplicate that far back.
    const previous = Array.from({ length: 20 }, (_, i) =>
      point({ id: `p${i}`, latitude: 20 + i, longitude: 30 + i, node_id: '!other' })
    );
    const repeated = appendPoints(previous, [point({ id: 'old-copy' })]);
    expect(repeated).toHaveLength(21);
  });

  it('still adds a genuinely new fix from the same node', () => {
    const first = appendPoints([], [point()]);
    const moved = appendPoints(first, [point({ id: 'p2', latitude: 38.69955, longitude: -9.232145 })]);
    expect(moved).toHaveLength(2);
  });

  it('treats the same coordinates from a different node as distinct', () => {
    const first = appendPoints([], [point()]);
    const other = appendPoints(first, [point({ id: 'p2', node_id: '!8ce97125' })]);
    expect(other).toHaveLength(2);
  });

  it('reports duplicates without mutating the input', () => {
    const previous = [point()];
    expect(isDuplicateFix(previous, point({ id: 'again' }))).toBe(true);
    expect(previous).toHaveLength(1);
  });

  it('converts an API position into a map point', () => {
    const converted = devicePositionToPoint(
      {
        nodeId: '!4058f711',
        latitude: 38.6994523,
        longitude: -9.2322213,
        altitude: 28,
        satellites: 16,
        time: 1790862711,
      },
      0
    );

    expect(converted.node_id).toBe('!4058f711');
    expect(converted.source).toBe('Meshtastic API');
    expect(converted.satellites).toBe(16);
    expect(converted.timestamp).toBe(new Date(1790862711 * 1000).toISOString());
  });

  it('falls back to now when the packet carries no time', () => {
    const when = Date.parse('2026-10-01T12:00:00.000Z');
    const converted = devicePositionToPoint(
      { nodeId: '!a', latitude: 1, longitude: 2, altitude: null, satellites: null, time: null },
      when
    );
    expect(converted.timestamp).toBe(new Date(when).toISOString());
  });
});
