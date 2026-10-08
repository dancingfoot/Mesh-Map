/**
 * Pure helpers for the Leaflet map: popup/marker HTML, trace geometry, legend
 * data and the "what should the map show" decisions.
 *
 * Nothing here touches `L.*`, the DOM or React state — every function takes
 * plain data and returns plain data, which keeps the popular-but-hairy HTML
 * escaping and coordinate plumbing unit-testable and out of `FoliumMap.tsx`.
 */

import { GpsPoint } from '../types';
import { NodeSummary, TIME_WINDOWS } from './nodes';

/** Escapes user/serial supplied text before it is injected into a Leaflet popup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `'123 m'` / `'N/A'` for a packet's altitude. */
export function formatAltitude(pt: GpsPoint): string {
  return pt.altitude != null ? `${pt.altitude} m` : 'N/A';
}

/** `'42 km/h'` / `'N/A'` for a packet's speed. */
export function formatSpeed(pt: GpsPoint): string {
  return pt.speed_kmh != null ? `${pt.speed_kmh} km/h` : 'N/A';
}

/** Popup for a node's latest packet (colour-matched to the node trace). */
export function currentPopupHtml(node: NodeSummary, pt: GpsPoint): string {
  return `
    <div style="font-family: system-ui, sans-serif; min-width: 210px; padding: 2px;">
      <div style="font-size: 11px; font-weight: 700; color: ${node.color}; text-transform: uppercase; margin-bottom: 4px;">
        ● ${escapeHtml(node.label)} · LATEST
      </div>
      <div style="font-size: 13px; font-weight: 600; color: #0f172a; margin-bottom: 4px;">
        ${pt.latitude.toFixed(6)}°, ${pt.longitude.toFixed(6)}°
      </div>
      <div style="font-size: 12px; color: #475569; line-height: 1.5;">
        <strong>Time:</strong> ${new Date(pt.timestamp).toLocaleTimeString()}<br/>
        <strong>Altitude:</strong> ${formatAltitude(pt)}<br/>
        <strong>Speed:</strong> ${formatSpeed(pt)}<br/>
        <strong>Source:</strong> ${escapeHtml(pt.source)}<br/>
        <strong>Node:</strong> ${escapeHtml(node.key)}<br/>
        <strong>Packets:</strong> ${node.count}<br/>
        ${
          node.isStale
            ? '<strong style="color: #B45309;">&#9888; Last known position</strong> (from the node database)<br/>'
            : ''
        }
      </div>
    </div>
  `;
}

/** Popup for a node's first packet. */
export function startPopupHtml(node: NodeSummary, pt: GpsPoint): string {
  return `
    <div style="font-family: system-ui, sans-serif; min-width: 190px; padding: 2px;">
      <div style="font-size: 11px; font-weight: 700; color: ${node.color}; text-transform: uppercase; margin-bottom: 4px;">
        ▶ ${escapeHtml(node.label)} · START
      </div>
      <div style="font-size: 13px; font-weight: 600; color: #0f172a; margin-bottom: 2px;">
        ${pt.latitude.toFixed(6)}°, ${pt.longitude.toFixed(6)}°
      </div>
      <div style="font-size: 12px; color: #64748b; line-height: 1.4;">
        Time: ${new Date(pt.timestamp).toLocaleTimeString()}<br/>
        Alt: ${formatAltitude(pt)}<br/>
        Source: ${escapeHtml(pt.source)}<br/>
        Packets from node: ${node.count}
        ${
          node.isStale
            ? '<br/><strong style="color: #B45309;">&#9888; Last known position</strong> (from the node database)'
            : ''
        }
      </div>
    </div>
  `;
}

/** Inner HTML of the round "start of trace" divIcon. */
export function startMarkerHtml(node: NodeSummary): string {
  // A last-known fix gets a hollow, dashed marker so it cannot be mistaken for a
  // live one (see `NodeSummary.isStale`).
  const stale = node.isStale;
  return `
          <div style="
            width: 22px; height: 22px; border-radius: 50%;
            background: ${stale ? 'transparent' : node.color};
            border: 3px ${stale ? 'dashed' : 'solid'} ${stale ? node.color : '#FFFFFF'};
            box-shadow: ${stale ? 'none' : '0 2px 6px rgba(0,0,0,0.35)'};
            opacity: ${stale ? '0.75' : '1'};
            display: flex; align-items: center; justify-content: center;
            color: ${stale ? node.color : '#FFFFFF'}; font-size: 9px; font-weight: 700;
          ">▶</div>
        `;
}

/** Inner HTML of the pulsing "current position" divIcon. */
export function currentMarkerHtml(node: NodeSummary): string {
  const stale = node.isStale;
  // The pulsing halo means "live"; a last-known fix gets a static dashed ring.
  const halo = stale
    ? ''
    : `<div style="
              position: absolute; inset: 0; border-radius: 50%;
              background: ${node.color}; opacity: 0.35;
              animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
            "></div>`;
  return `
          <div style="position: relative; width: 30px; height: 30px;">
            ${halo}
            <div style="
              position: relative; width: 30px; height: 30px; border-radius: 50%;
              background: ${stale ? 'transparent' : node.color};
              border: 3px ${stale ? 'dashed' : 'solid'} ${stale ? node.color : '#FFFFFF'};
              box-shadow: ${stale ? 'none' : '0 4px 12px rgba(0,0,0,0.35)'};
              opacity: ${stale ? '0.8' : '1'};
            "></div>
          </div>
        `;
}

/** Sticky tooltip shown on a node's route polyline. */
export function traceTooltipHtml(node: NodeSummary): string {
  const suffix = node.isStale ? ' · last known position' : '';
  return `${escapeHtml(node.label)} — ${node.count} pts · ${node.distanceKm.toFixed(2)} km${suffix}`;
}

/** `[lat, lon]` pairs (Leaflet's order) for a packet list. */
export function toLatLngs(points: GpsPoint[]): [number, number][] {
  return points.map((p) => [p.latitude, p.longitude]);
}

/** Initial center/zoom for a fresh map instance (San Francisco when empty). */
export function initialMapView(points: GpsPoint[]): { center: [number, number]; zoom: number } {
  const initialLat = points.length > 0 ? points[points.length - 1].latitude : 37.7749;
  const initialLon = points.length > 0 ? points[points.length - 1].longitude : -122.4194;
  const initialZoom = points.length > 0 ? 15 : 13;
  return { center: [initialLat, initialLon], zoom: initialZoom };
}

/** Label of the selected time window (`'All'` when unset/unknown). */
export function timeWindowLabel(ms: number | null | undefined): string {
  return TIME_WINDOWS.find((w) => w.ms === ms)?.label ?? 'All';
}

/** One legend row per visible node, colour-matched to its trace. */
export interface LegendEntry {
  key: string;
  label: string;
  color: string;
  count: number;
}

/** Plain-data legend model rendered by the map legend. */
export function buildLegendData(nodes: NodeSummary[]): LegendEntry[] {
  return nodes.map((node) => ({
    key: node.key,
    label: node.label,
    color: node.color,
    count: node.count,
  }));
}
