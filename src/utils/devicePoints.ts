/**
 * Turning device data into map points.
 *
 * A fix can now reach the dashboard by two routes, and both describe the same
 * physical packet:
 *
 *  1. the ASCII firmware log (`POSITION node=… lat=… lon=…`, and the
 *     `updatePosition REMOTE …` line the firmware prints for the same packet);
 *  2. a protobuf `MeshPacket` frame once the dashboard is attached as a
 *     phone-API client.
 *
 * They interleave, so a naive append would stack two or three copies of one fix.
 * Everything here is pure, which keeps the de-duplication rule testable.
 */

import type { GpsPoint } from '../types';
import type { DevicePosition } from './meshtasticProtocol';

/**
 * How far back to look for the same fix.
 *
 * The duplicate lines for one packet are emitted back-to-back, but the API frame
 * for it can land a few points later, so a small window is enough — and a
 * bounded one, so a long track stays O(1) per insert.
 */
const DEDUPE_WINDOW = 12;

/**
 * Two fixes count as the same when they are the same node at the same spot.
 *
 * Staleness is part of the identity on purpose: a node's last-known position
 * from the database must never mask the live packet that follows it, otherwise
 * a node would stay marked stale forever.
 */
function sameFix(a: GpsPoint, b: GpsPoint): boolean {
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    (a.node_id ?? '') === (b.node_id ?? '') &&
    Boolean(a.isStale) === Boolean(b.isStale)
  );
}

/**
 * True when an identical fix (same node, same coordinates) is already among the
 * most recent points.
 */
export function isDuplicateFix(previous: GpsPoint[], candidate: GpsPoint): boolean {
  const from = Math.max(0, previous.length - DEDUPE_WINDOW);
  for (let i = previous.length - 1; i >= from; i -= 1) {
    if (sameFix(previous[i], candidate)) return true;
  }
  return false;
}

/**
 * Appends fixes, skipping any that duplicate a recent one.
 *
 * @returns the same array reference when nothing was added, so React can skip
 *          the re-render.
 */
export function appendPoints(previous: GpsPoint[], incoming: GpsPoint[]): GpsPoint[] {
  let next = previous;
  for (const point of incoming) {
    if (isDuplicateFix(next, point)) continue;
    if (next === previous) next = [...previous, point];
    else next = [...next, point];
  }
  return next;
}

/**
 * Converts a `MeshPacket` position into the dashboard's point shape.
 *
 * @param position decoded from the phone-API stream.
 * @param fallbackNow used for `timestamp` when the packet carries no time.
 */
export function devicePositionToPoint(
  position: DevicePosition,
  fallbackNow = Date.now(),
  stale = false
): GpsPoint {
  const timestamp =
    position.time && position.time > 0
      ? new Date(position.time * 1000).toISOString()
      : new Date(fallbackNow).toISOString();

  return {
    id: `${stale ? 'db' : 'api'}-${position.nodeId}-${position.time ?? fallbackNow}`,
    latitude: position.latitude,
    longitude: position.longitude,
    altitude: position.altitude,
    satellites: position.satellites,
    speed_kmh: null,
    node_id: position.nodeId,
    source: stale ? 'Node DB (last known)' : 'Meshtastic API',
    timestamp,
    raw: stale
      ? `Last known position from the node database (${position.nodeId})`
      : `MeshPacket position from ${position.nodeId}`,
    isStale: stale,
  };
}
