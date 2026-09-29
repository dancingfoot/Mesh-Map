import { GpsPoint } from '../types';

export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function calculateTotalDistanceKm(points: GpsPoint[]): number {
  if (points.length < 2) return 0;
  let totalMeters = 0;
  for (let i = 1; i < points.length; i++) {
    totalMeters += calculateDistanceMeters(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude
    );
  }
  return Number((totalMeters / 1000).toFixed(2));
}

export function exportToGeoJson(points: GpsPoint[]): string {
  const coordinates = points.map((p) => [p.longitude, p.latitude, p.altitude ?? 0]);
  const featureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Meshtastic Node Path',
          pointsCount: points.length,
          recordedAt: new Date().toISOString(),
        },
        geometry: {
          type: 'LineString',
          coordinates,
        },
      },
      ...points.map((p, idx) => ({
        type: 'Feature',
        properties: {
          index: idx + 1,
          time: p.timestamp,
          source: p.source,
          node_id: p.node_id,
          altitude: p.altitude,
        },
        geometry: {
          type: 'Point',
          coordinates: [p.longitude, p.latitude, p.altitude ?? 0],
        },
      })),
    ],
  };
  return JSON.stringify(featureCollection, null, 2);
}

export function exportToGpx(points: GpsPoint[]): string {
  const trkpts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.latitude.toFixed(6)}" lon="${p.longitude.toFixed(6)}">
        <ele>${p.altitude ?? 0}</ele>
        <time>${p.timestamp}</time>
        <desc>${p.source}${p.node_id ? ` - Node: ${p.node_id}` : ''}</desc>
      </trkpt>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mesh Map GIS - Meshtastic Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Meshtastic Route Track</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>Today Path Trace</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function exportToCsv(points: GpsPoint[]): string {
  const headers = ['Index', 'Timestamp', 'Latitude', 'Longitude', 'Altitude_m', 'Source', 'Node_ID', 'Raw'];
  const rows = points.map((p, i) => [
    i + 1,
    `"${p.timestamp}"`,
    p.latitude,
    p.longitude,
    p.altitude ?? '',
    `"${p.source}"`,
    `"${p.node_id ?? ''}"`,
    `"${p.raw.replace(/"/g, '""')}"`,
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
