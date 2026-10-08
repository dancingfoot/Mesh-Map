import { describe, expect, it } from 'vitest';
import { GpsPoint } from '../types';
import {
  NODE_PALETTE,
  TIME_WINDOWS,
  UNKNOWN_NODE_KEY,
  assignNodeColors,
  colorForNode,
  filterByWindow,
  formatRelativeTime,
  nodeKey,
  summariseNodes,
  toEpochMs,
} from './nodes';

let seq = 0;
/** Packet factory: `at` is minutes before "now" unless an explicit timestamp is given. */
function packet(latitude: number, longitude: number, at: string | number, nodeId?: string | null): GpsPoint {
  const timestamp = typeof at === 'string' ? at : new Date(Date.now() - at * 60_000).toISOString();
  return {
    id: `p${seq++}`,
    latitude,
    longitude,
    node_id: nodeId,
    source: 'test',
    timestamp,
    raw: '',
  };
}

describe('nodeKey', () => {
  it('uses the node_id when present', () => {
    expect(nodeKey(packet(1, 2, 0, '!a1d7631c'))).toBe('!a1d7631c');
  });

  it('trims whitespace and falls back to the unknown bucket', () => {
    expect(nodeKey(packet(1, 2, 0, ' !abc '))).toBe('!abc');
    expect(nodeKey(packet(1, 2, 0, null))).toBe(UNKNOWN_NODE_KEY);
    expect(nodeKey(packet(1, 2, 0, '   '))).toBe(UNKNOWN_NODE_KEY);
    expect(nodeKey(packet(1, 2, 0))).toBe(UNKNOWN_NODE_KEY);
  });
});

describe('assignNodeColors', () => {
  const keys = ['unknown', '!28a9df12', '!a1d7631c', '!8ce97125', '!c931be04', '!a1d7631d', '!12345678', '!deadbeef'];

  it('gives every node a distinct colour', () => {
    const colors = assignNodeColors(keys);
    expect(new Set(colors.values()).size).toBe(keys.length);
    for (const color of colors.values()) {
      expect(NODE_PALETTE).toContain(color);
    }
  });

  it('is independent of key order', () => {
    const forward = assignNodeColors(keys);
    const reversed = assignNodeColors([...keys].reverse());
    for (const key of keys) {
      expect(reversed.get(key)).toBe(forward.get(key));
    }
  });

  it('reuses palette entries once there are more nodes than colours', () => {
    const many = Array.from({ length: 30 }, (_, i) => `!node${i}`);
    const colors = assignNodeColors(many);
    expect(colors.size).toBe(30);
    expect(new Set(colors.values()).size).toBeLessThanOrEqual(NODE_PALETTE.length);
  });

  it('colorForNode is deterministic', () => {
    expect(colorForNode('!a1d7631c')).toBe(colorForNode('!a1d7631c'));
    expect(NODE_PALETTE).toContain(colorForNode('!a1d7631c'));
  });
});

describe('summariseNodes', () => {
  it('groups by node and sorts newest first', () => {
    const summaries = summariseNodes([
      packet(37.0, -122.0, 60, '!old'),
      packet(38.0, -9.0, 1, '!new'),
      packet(38.1, -9.1, 2, '!new'),
    ]);
    expect(summaries.map((s) => s.key)).toEqual(['!new', '!old']);
    expect(summaries[0].count).toBe(2);
    expect(summaries[0].label).toBe('!new');
  });

  it('computes distance per node, not across nodes', () => {
    const summaries = summariseNodes([
      packet(37.7749, -122.4194, 3, '!a'),
      packet(37.7759, -122.4194, 2, '!a'),
      packet(48.1371, 11.5754, 1, '!b'),
    ]);
    const a = summaries.find((s) => s.key === '!a')!;
    const b = summaries.find((s) => s.key === '!b')!;
    expect(a.distanceKm).toBeGreaterThan(0.05);
    expect(a.distanceKm).toBeLessThan(0.5);
    expect(b.distanceKm).toBe(0);
  });

  it('exposes first/last seen and the newest packet', () => {
    const summaries = summariseNodes([
      packet(1, 1, 10, '!a'),
      packet(2, 2, 1, '!a'),
    ]);
    const [node] = summaries;
    expect(node.lastSeen).toBeGreaterThan(node.firstSeen);
    expect(node.lastPoint.latitude).toBe(2);
  });

  it('falls back to arrival order when timestamps are unparseable', () => {
    const summaries = summariseNodes([packet(1, 1, 'garbage', '!a'), packet(2, 2, 'garbage', '!a')]);
    expect(summaries[0].count).toBe(2);
    expect(summaries[0].lastPoint.latitude).toBe(2);
  });

  it('returns an empty list for no packets', () => {
    expect(summariseNodes([])).toEqual([]);
  });
});

describe('time windows', () => {
  it('offers exactly the documented windows in order', () => {
    expect(TIME_WINDOWS.map((w) => w.label)).toEqual(['All', '1 min', '30 min', '1 h', '3 h', '6 h', '12 h']);
    expect(TIME_WINDOWS[0].ms).toBeNull();
    expect(TIME_WINDOWS[1].ms).toBe(60_000);
    expect(TIME_WINDOWS[6].ms).toBe(12 * 60 * 60_000);
  });

  it('returns the same array reference for "All"', () => {
    const points = [packet(1, 1, 0)];
    expect(filterByWindow(points, null)).toBe(points);
  });

  it('drops packets older than the window and keeps fresh ones', () => {
    const fresh = packet(1, 1, 0);
    const stale = packet(2, 2, 90);
    const kept = filterByWindow([stale, fresh], 60 * 60_000);
    expect(kept).toEqual([fresh]);
  });

  it('keeps packets whose timestamp cannot be parsed', () => {
    const unknownTime = packet(3, 3, 'garbage');
    expect(filterByWindow([unknownTime], 60_000)).toEqual([unknownTime]);
  });
});

describe('timestamp helpers', () => {
  it('parses ISO timestamps and rejects junk', () => {
    expect(toEpochMs('2026-09-29T11:36:30.000Z')).toBe(Date.parse('2026-09-29T11:36:30.000Z'));
    expect(toEpochMs('garbage')).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
  });

  it('formats relative ages in human units', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 30_000, now)).toBe('30 s ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 m ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3 d ago');
    expect(formatRelativeTime(Number.NaN, now)).toBe('unknown');
  });
});
