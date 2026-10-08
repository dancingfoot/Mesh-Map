import { GpsPoint } from '../types';
import { calculateTotalDistanceKm } from './haversine';
import { displayLongName, resolveNodeLabel, type NodeIdentityMap } from './nodeNames';

/**
 * Per-node helpers.
 *
 * All functions in this module are pure (no React, no DOM side effects) so they
 * can be unit-tested and memoised cheaply from the UI. A "node" is one
 * Meshtastic mesh address (`!a1d7631c`); packets without an address are grouped
 * under the synthetic {@link UNKNOWN_NODE_KEY} bucket ("local" NMEA fixes and
 * firmware log lines without a `node=` field).
 */

/** Bucket key used for packets that carry no `node_id`. */
export const UNKNOWN_NODE_KEY = 'unknown';

/**
 * Stable identity for the node that produced a GPS fix.
 *
 * Uses `node_id` when it is a non-empty string, otherwise `'unknown'`.
 * The value is used both as a grouping key and as a colour hash input, so it
 * must stay stable across reloads.
 */
export function nodeKey(p: GpsPoint): string {
  const id = p.node_id;
  if (typeof id === 'string' && id.trim().length > 0) return id.trim();
  return UNKNOWN_NODE_KEY;
}

/**
 * 12 visually distinct line/marker colours.
 *
 * Chosen mid-to-dark saturated tones so they stay legible on the light UI and
 * remain distinguishable on top of the grey/green Esri satellite imagery.
 * Every trace is drawn with a white halo underneath, which supplies contrast
 * against dark imagery.
 */
export const NODE_PALETTE: readonly string[] = [
  '#2563EB', // blue-600
  '#DC2626', // red-600
  '#059669', // emerald-600
  '#D97706', // amber-600
  '#7C3AED', // violet-600
  '#0891B2', // cyan-600
  '#DB2777', // pink-600
  '#65A30D', // lime-600
  '#EA580C', // orange-600
  '#4F46E5', // indigo-600
  '#0D9488', // teal-600
  '#9333EA', // purple-600
];

/**
 * FNV-1a 32-bit string hash finished with a murmur3-style avalanche.
 *
 * The avalanche step is essential: FNV-1a's low bits are weakly mixed, so
 * taking `hash % 12` straight from FNV made unrelated node ids collide —
 * measured, 10 realistic ids produced only 6 distinct colours and the two live
 * nodes both came out red.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Finalizer (murmur3): spread the entropy into the high and low bits.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Deterministic colour for a single node key.
 *
 * Prefer {@link assignNodeColors} whenever several keys are known at once —
 * hashing alone can still map two keys onto the same palette entry. This form
 * is for previews/tests where no sibling keys exist.
 */
export function colorForNode(key: string): string {
  return NODE_PALETTE[hashString(key) % NODE_PALETTE.length];
}

/**
 * A distinct colour for every key, deterministic for a given set of keys.
 *
 * Each key starts at its hash slot and probes forward to the first unused
 * palette entry, so up to `NODE_PALETTE.length` (12) nodes always get visually
 * distinct colours. Keys are processed in sorted order, which makes the result
 * independent of packet arrival order and therefore stable across reloads.
 */
export function assignNodeColors(keys: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(keys)].sort();
  const taken = new Set<number>();
  const colors = new Map<string, string>();

  for (const key of distinct) {
    const start = hashString(key) % NODE_PALETTE.length;
    let slot = start;
    for (let step = 0; step < NODE_PALETTE.length; step++) {
      const candidate = (start + step) % NODE_PALETTE.length;
      if (!taken.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    taken.add(slot);
    colors.set(key, NODE_PALETTE[slot]);
  }

  return colors;
}

/** A short `'2h'`-style note about how long a node has been tracked. */
export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs)) return 'unknown';
  const delta = Math.max(0, now - epochMs);
  if (delta < 10_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)} s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  return `${Math.floor(delta / 86_400_000)} d ago`;
}

/** Parses an ISO timestamp, returning `null` when it is missing/unparseable. */
export function toEpochMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Aggregated per-node view of a packet list. */
export interface NodeSummary {
  /** {@link nodeKey} of the node (also the grouping identity). */
  key: string;
  /** Short display label: the Meshtastic short name, else the address. */
  label: string;
  /** Descriptive name (Meshtastic long name) when known, else null. */
  longLabel: string | null;
  /**
   * True when every fix for this node came from the device's node database, so
   * the map is showing a last-known position rather than a live one.
   */
  isStale: boolean;
  /** Stable {@link colorForNode} colour for this key. */
  color: string;
  /** That node's packets, in the order they were supplied. */
  points: GpsPoint[];
  /** `points.length` (pre-computed for tables/tooltips). */
  count: number;
  /** Epoch ms of the node's earliest packet (0 when timestamps are unusable). */
  firstSeen: number;
  /** Epoch ms of the node's latest packet; the sort key of this list. */
  lastSeen: number;
  /** Great-circle distance travelled by that node, kilometres. */
  distanceKm: number;
  /** The node's newest packet. */
  lastPoint: GpsPoint;
}

/**
 * Groups packets by node and aggregates count / first + last seen / distance.
 *
 * @param identities optional node-name map; when supplied, each summary's
 *        `label` is the node's human name instead of its raw address.
 * @returns summaries sorted by `lastSeen` descending (most recent node first).
 *          Ties fall back to the node key so the order is deterministic.
 */
export function summariseNodes(points: GpsPoint[], identities?: NodeIdentityMap): NodeSummary[] {
  const groups = new Map<string, GpsPoint[]>();

  for (const point of points) {
    const key = nodeKey(point);
    const bucket = groups.get(key);
    if (bucket) bucket.push(point);
    else groups.set(key, [point]);
  }

  const summaries: NodeSummary[] = [];
  // One distinct palette slot per node, so no two traces share a colour.
  const colors = assignNodeColors(groups.keys());

  for (const [key, nodePoints] of groups) {
    let firstSeen = Number.POSITIVE_INFINITY;
    let lastSeen = Number.NEGATIVE_INFINITY;
    let firstPoint: GpsPoint | null = null;
    let lastPoint: GpsPoint | null = null;

    for (const point of nodePoints) {
      const time = toEpochMs(point.timestamp);
      if (time === null) continue;
      if (time < firstSeen) {
        firstSeen = time;
        firstPoint = point;
      }
      // `>=` so that on identical timestamps the later packet wins.
      if (time >= lastSeen) {
        lastSeen = time;
        lastPoint = point;
      }
    }

    // Fall back to arrival order when the stream carries no usable timestamps.
    if (!firstPoint) {
      firstPoint = nodePoints[0];
      firstSeen = toEpochMs(firstPoint.timestamp) ?? 0;
    }
    if (!lastPoint) {
      lastPoint = nodePoints[nodePoints.length - 1];
      lastSeen = toEpochMs(lastPoint.timestamp) ?? 0;
    }

    summaries.push({
      key,
      label: resolveNodeLabel(key, identities),
      longLabel: displayLongName(key, identities),
      isStale: nodePoints.every((point) => Boolean(point.isStale)),
      color: colors.get(key) ?? colorForNode(key),
      points: nodePoints,
      count: nodePoints.length,
      firstSeen,
      lastSeen,
      distanceKm: calculateTotalDistanceKm(nodePoints),
      lastPoint,
    });
  }

  summaries.sort((a, b) => b.lastSeen - a.lastSeen || a.key.localeCompare(b.key));
  return summaries;
}

/** One entry of the map/table time-window segmented control. */
export interface TimeWindow {
  /** Button label, e.g. `30 min`. */
  label: string;
  /** Window length in ms, or `null` for "All". */
  ms: number | null;
}

/** Time windows offered by the map header selector. `ms: null` = no filtering. */
export const TIME_WINDOWS: readonly TimeWindow[] = [
  { label: 'All', ms: null },
  { label: '1 min', ms: 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: '1 h', ms: 60 * 60_000 },
  { label: '3 h', ms: 3 * 60 * 60_000 },
  { label: '6 h', ms: 6 * 60 * 60_000 },
  { label: '12 h', ms: 12 * 60 * 60_000 },
];

/**
 * Keeps only packets newer than `now - ms`.
 *
 * `ms === null` returns the input array untouched (identity, so React memo
 * consumers stay referentially stable). Packets whose timestamp cannot be
 * parsed are kept rather than silently dropped.
 */
export function filterByWindow(
  points: GpsPoint[],
  ms: number | null,
  now: number = Date.now()
): GpsPoint[] {
  if (ms === null) return points;
  const cutoff = now - ms;
  return points.filter((p) => {
    const time = toEpochMs(p.timestamp);
    if (time === null) return true;
    return time >= cutoff;
  });
}
