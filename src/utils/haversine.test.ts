import { describe, expect, it } from 'vitest';
import { GpsPoint } from '../types';
import {
  calculateDistanceMeters,
  calculateTotalDistanceKm,
  exportToCsv,
  exportToGeoJson,
  exportToGpx,
} from './haversine';

function point(over: Partial<GpsPoint> = {}): GpsPoint {
  return {
    id: 'p',
    latitude: 37.7749,
    longitude: -122.4194,
    altitude: 42,
    source: 'Meshtastic JSON',
    node_id: '!28a9df12',
    timestamp: '2026-09-30T12:00:00.000Z',
    raw: '{"lat":37.7749,"lon":-122.4194}',
    ...over,
  };
}

describe('distance maths', () => {
  it('is zero for an identical coordinate', () => {
    expect(calculateDistanceMeters(37.7749, -122.4194, 37.7749, -122.4194)).toBe(0);
  });

  it('matches the known length of one degree of latitude', () => {
    // ~111.2 km per degree of latitude on a sphere of radius 6371 km.
    const meters = calculateDistanceMeters(0, 0, 1, 0);
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it('sums consecutive segments and needs at least two points', () => {
    expect(calculateTotalDistanceKm([])).toBe(0);
    expect(calculateTotalDistanceKm([point()])).toBe(0);
    const km = calculateTotalDistanceKm([
      point({ latitude: 37.7749, longitude: -122.4194 }),
      point({ latitude: 37.7849, longitude: -122.4194 }),
      point({ latitude: 37.7949, longitude: -122.4194 }),
    ]);
    // Two segments of ~1.11 km each.
    expect(km).toBeGreaterThan(2.1);
    expect(km).toBeLessThan(2.4);
  });
});

describe('GeoJSON export', () => {
  it('emits a parseable FeatureCollection with lon/lat order', () => {
    const parsed = JSON.parse(exportToGeoJson([point(), point({ latitude: 38 })]));
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features).toHaveLength(3); // LineString + 2 points
    expect(parsed.features[0].geometry.type).toBe('LineString');
    expect(parsed.features[0].properties.pointsCount).toBe(2);
    // RFC 7946: [longitude, latitude, altitude]
    expect(parsed.features[0].geometry.coordinates[0]).toEqual([-122.4194, 37.7749, 42]);
  });

  it('defaults a missing altitude to 0 instead of null', () => {
    const parsed = JSON.parse(exportToGeoJson([point({ altitude: null })]));
    expect(parsed.features[1].geometry.coordinates[2]).toBe(0);
  });

  it('handles an empty track', () => {
    const parsed = JSON.parse(exportToGeoJson([]));
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].geometry.coordinates).toEqual([]);
  });
});

describe('GPX export', () => {
  it('produces a well-formed track with 6-decimal coordinates', () => {
    const gpx = exportToGpx([point()]);
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('lat="37.774900" lon="-122.419400"');
    expect(gpx).toContain('<ele>42</ele>');
    expect(gpx).toContain('<time>2026-09-30T12:00:00.000Z</time>');
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
  });

  /**
   * Regression: source/node id used to be interpolated raw, so a `&` or `<`
   * produced a file QGIS/Garmin refuse to open.
   */
  it('escapes XML metacharacters in source and node id', () => {
    const gpx = exportToGpx([point({ source: 'A & B <bad>', node_id: '!"<x>"' })]);
    expect(gpx).not.toContain('<bad>');
    expect(gpx).toContain('A &amp; B &lt;bad&gt;');
    expect(gpx).toContain('&quot;&lt;x&gt;&quot;');
    expect(gpx).not.toMatch(/<desc>[^<]*<bad>/);
  });

  it('handles an empty track', () => {
    const gpx = exportToGpx([]);
    expect(gpx).toContain('<trkseg>');
    expect(gpx).not.toContain('<trkpt');
  });
});

describe('CSV export', () => {
  it('writes a header plus one row per point', () => {
    const lines = exportToCsv([point(), point()]).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Index,Timestamp,Latitude,Longitude,Altitude_m,Source,Node_ID,Raw');
    expect(lines[1].startsWith('1,')).toBe(true);
    expect(lines[2].startsWith('2,')).toBe(true);
  });

  it('leaves altitude blank when it is unknown', () => {
    const row = exportToCsv([point({ altitude: null })]).split('\n')[1];
    expect(row.split(',')[4]).toBe('');
  });

  it('doubles embedded quotes so the file stays parseable', () => {
    const csv = exportToCsv([point({ source: 'say "hi"', raw: '{"a":"b"}' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"say ""hi"""');
    expect(row).toContain('"{""a"":""b""}"');
    // No field may contain a lone (undoubled) quote pair boundary issue: count
    // quotes is always even across the row.
    expect((row.match(/"/g) || []).length % 2).toBe(0);
  });

  it('handles a null node id', () => {
    expect(exportToCsv([point({ node_id: null })])).toContain(',"",');
  });
});
