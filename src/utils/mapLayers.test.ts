import { describe, expect, it } from 'vitest';
import { GpsPoint } from '../types';
import { NODE_PALETTE, summariseNodes } from './nodes';
import {
  buildLegendData,
  currentMarkerHtml,
  currentPopupHtml,
  escapeHtml,
  formatAltitude,
  formatSpeed,
  initialMapView,
  startMarkerHtml,
  startPopupHtml,
  timeWindowLabel,
  toLatLngs,
  traceTooltipHtml,
} from './mapLayers';

// ------------------------------------------------------------------ helpers ---

let seq = 0;
/** Packet factory with monotonically increasing, parseable timestamps. */
function packet(
  latitude: number,
  longitude: number,
  nodeId?: string | null,
  overrides: Partial<GpsPoint> = {}
): GpsPoint {
  const second = seq++;
  return {
    id: `p${second}`,
    latitude,
    longitude,
    node_id: nodeId,
    source: 'serial',
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, second)).toISOString(),
    raw: '',
    ...overrides,
  };
}

const HOSTILE_ID = '!<script>alert(1)</script>';

// ---------------------------------------------------------------- escapeHtml ---

describe('escapeHtml', () => {
  it('neutralises every HTML metacharacter', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a full hostile payload', () => {
    expect(escapeHtml('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });

  it('escapes ampersands first so already-escaped text stays literal', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('!a1d7631c')).toBe('!a1d7631c');
  });
});

// ------------------------------------------------------------------- popups ---

describe('popup HTML', () => {
  it('escapes a hostile node id in the latest popup', () => {
    const node = summariseNodes([packet(37.7749, -122.4194, HOSTILE_ID)])[0];
    const html = currentPopupHtml(node, node.lastPoint);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(node.color);
    expect(html).toContain('LATEST');
  });

  it('escapes a hostile node id in the start popup', () => {
    const node = summariseNodes([packet(37.7749, -122.4194, HOSTILE_ID)])[0];
    const html = startPopupHtml(node, node.points[0]);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('START');
  });

  it('escapes the packet source', () => {
    const hostileSource = '<img src=x onerror="alert(1)">';
    const node = summariseNodes([
      packet(1, 2, '!abc', { source: hostileSource, altitude: 42, speed_kmh: null }),
    ])[0];
    const html = currentPopupHtml(node, node.lastPoint);

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('42 m');
    expect(html).toContain('N/A');
  });
});

// ------------------------------------------------------------ marker HTML ---

describe('marker HTML', () => {
  it('paints the start marker with the node colour', () => {
    const node = summariseNodes([packet(1, 2, '!abc')])[0];
    const html = startMarkerHtml(node);
    expect(html).toContain(node.color);
    expect(html).toContain('▶');
  });

  it('paints the current marker with the node colour and pulse', () => {
    const node = summariseNodes([packet(1, 2, '!abc')])[0];
    const html = currentMarkerHtml(node);
    expect(html).toContain(node.color);
    expect(html).toContain('ping');
  });
});

// ---------------------------------------------------------------- tooltips ---

describe('traceTooltipHtml', () => {
  it('escapes the label and reports count + distance', () => {
    const node = summariseNodes([
      packet(0, 0, HOSTILE_ID),
      packet(0.001, 0.001, HOSTILE_ID),
    ])[0];
    const tip = traceTooltipHtml(node);
    expect(tip).toContain('&lt;script&gt;');
    expect(tip).not.toContain('<script>');
    expect(tip).toContain('2 pts');
    expect(tip).toMatch(/\d+\.\d{2} km$/);
  });
});

// ---------------------------------------------------------------- geometry ---

describe('toLatLngs', () => {
  it('maps packets to [lat, lon] pairs in input order', () => {
    const points = [packet(1.5, 2.5, '!a'), packet(-3.25, 4.75, '!a')];
    expect(toLatLngs(points)).toEqual([
      [1.5, 2.5],
      [-3.25, 4.75],
    ]);
  });

  it('returns an empty list for no packets', () => {
    expect(toLatLngs([])).toEqual([]);
  });
});

describe('initialMapView', () => {
  it('centres on San Francisco when there are no packets', () => {
    expect(initialMapView([])).toEqual({ center: [37.7749, -122.4194], zoom: 13 });
  });

  it('centres on the newest packet when there are packets', () => {
    const points = [packet(1, 2, '!a'), packet(3, 4, '!a')];
    expect(initialMapView(points)).toEqual({ center: [3, 4], zoom: 15 });
  });
});

// ------------------------------------------------------------- time window ---

describe('timeWindowLabel', () => {
  it('labels known windows and falls back to All', () => {
    expect(timeWindowLabel(null)).toBe('All');
    expect(timeWindowLabel(60_000)).toBe('1 min');
    expect(timeWindowLabel(3 * 3_600_000)).toBe('3 h');
    expect(timeWindowLabel(12_345)).toBe('All');
    expect(timeWindowLabel(undefined)).toBe('All');
  });
});

// ------------------------------------------------------------------ legend ---

describe('buildLegendData', () => {
  it('produces one colour-matched entry per visible node', () => {
    const points = [
      packet(1, 1, '!aaaa1111'),
      packet(2, 2, '!bbbb2222'),
      packet(3, 3, '!aaaa1111'),
    ];
    const nodes = summariseNodes(points);
    const legend = buildLegendData(nodes);

    expect(legend).toHaveLength(2);
    expect(legend).toHaveLength(nodes.length);

    for (const node of nodes) {
      const entry = legend.find((e) => e.key === node.key);
      expect(entry).toBeDefined();
      expect(entry!.color).toBe(node.color);
      expect(entry!.label).toBe(node.label);
      expect(entry!.count).toBe(node.count);
    }

    expect(NODE_PALETTE).toContain(legend[0].color);
    expect(new Set(legend.map((e) => e.color)).size).toBe(2);
  });

  it('is empty when no node is visible', () => {
    expect(buildLegendData([])).toEqual([]);
  });
});

// --------------------------------------------------------------- formatting ---

describe('formatAltitude / formatSpeed', () => {
  it('formats present values and N/A for missing ones', () => {
    expect(formatAltitude(packet(1, 2, '!a', { altitude: 120 }))).toBe('120 m');
    expect(formatAltitude(packet(1, 2, '!a', { altitude: null }))).toBe('N/A');
    expect(formatAltitude(packet(1, 2, '!a'))).toBe('N/A');
    expect(formatSpeed(packet(1, 2, '!a', { speed_kmh: 42.5 }))).toBe('42.5 km/h');
    expect(formatSpeed(packet(1, 2, '!a', { speed_kmh: null }))).toBe('N/A');
  });
});
