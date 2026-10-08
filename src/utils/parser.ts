import { GpsPoint } from '../types';

/**
 * Converts NMEA coordinate format (ddmm.mmmm or dddmm.mmmm) to decimal degrees.
 * E.g., '4807.038', 'N' -> 48.117300
 *       '01131.000', 'E' -> 11.516667
 */
export function parseNmeaCoordinate(rawVal: string, direction: string): number | null {
  try {
    const rawFloat = parseFloat(rawVal);
    if (isNaN(rawFloat)) return null;

    const degrees = Math.floor(rawFloat / 100);
    const minutes = rawFloat - degrees * 100;
    let decimal = degrees + minutes / 60.0;

    const dir = direction.trim().toUpperCase();
    if (dir === 'S' || dir === 'W') {
      decimal = -decimal;
    }
    return Number(decimal.toFixed(6));
  } catch {
    return null;
  }
}

/**
 * Parse standard NMEA sentences ($GPGGA, $GNGGA, $GPRMC, $GNRMC).
 */
export function parseNmeaSentence(line: string): GpsPoint | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('$')) return null;

  // Extract content before checksum
  let content = trimmed.substring(1);
  if (content.includes('*')) {
    content = content.split('*')[0];
  }

  const parts = content.split(',');
  const sentenceType = parts[0]?.toUpperCase() || '';

  // GGA - Global Positioning System Fix Data
  if (['GPGGA', 'GNGGA', 'GAGGA'].includes(sentenceType)) {
    if (parts.length >= 10 && parts[2] && parts[3] && parts[4] && parts[5]) {
      const lat = parseNmeaCoordinate(parts[2], parts[3]);
      const lon = parseNmeaCoordinate(parts[4], parts[5]);
      if (lat !== null && lon !== null) {
        const altitude = parts[9] ? parseFloat(parts[9]) : null;
        const satellites = parts[7] ? parseInt(parts[7], 10) : null;
        return {
          id: `nmea-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          latitude: lat,
          longitude: lon,
          altitude: isNaN(altitude as number) ? null : altitude,
          satellites: isNaN(satellites as number) ? null : satellites,
          source: `NMEA (${sentenceType})`,
          timestamp: new Date().toISOString(),
          raw: trimmed,
        };
      }
    }
  }

  // RMC - Recommended Minimum Specific GNSS Data
  if (['GPRMC', 'GNRMC', 'GARMC'].includes(sentenceType)) {
    if (parts.length >= 7 && parts[2] === 'A' && parts[3] && parts[4] && parts[5] && parts[6]) {
      const lat = parseNmeaCoordinate(parts[3], parts[4]);
      const lon = parseNmeaCoordinate(parts[5], parts[6]);
      if (lat !== null && lon !== null) {
        const speedKnots = parts[7] ? parseFloat(parts[7]) : null;
        // `speedKnots !== null` (not truthiness) so a genuine 0 kt -> 0.0 km/h.
        const speedKmh =
          speedKnots !== null && !isNaN(speedKnots) ? Number((speedKnots * 1.852).toFixed(1)) : null;
        return {
          id: `nmea-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          latitude: lat,
          longitude: lon,
          speed_kmh: speedKmh,
          source: `NMEA (${sentenceType})`,
          timestamp: new Date().toISOString(),
          raw: trimmed,
        };
      }
    }
  }

  return null;
}

/**
 * Parse Meshtastic serial JSON packets.
 * Supports:
 * 1) {"type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":42}}
 * 2) {"from":"!28a9df12","type":"position","lat":37.7749,"lon":-122.4194}
 * 3) {"sender":"^all","decoded":{"position":{"latitudeI":377749000,"longitudeI":-1224194000}}}
 */
export function parseMeshtasticJson(line: string): GpsPoint | null {
  const match = line.match(/\{.*\}/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[0]);
    if (typeof data !== 'object' || data === null) return null;

    let lat: number | null = null;
    let lon: number | null = null;
    let alt: number | null = null;
    const nodeId = data.from || data.sender || data.node_id || null;

    // Check root level
    if (typeof data.lat === 'number' && typeof data.lon === 'number') {
      lat = data.lat;
      lon = data.lon;
    } else if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
      lat = data.latitude;
      lon = data.longitude;
    } else if (typeof data.latitude_i === 'number' && typeof data.longitude_i === 'number') {
      lat = data.latitude_i / 1e7;
      lon = data.longitude_i / 1e7;
    } else if (typeof data.latitudeI === 'number' && typeof data.longitudeI === 'number') {
      lat = data.latitudeI / 1e7;
      lon = data.longitudeI / 1e7;
    }

    // Check payload object
    if (data.payload && typeof data.payload === 'object') {
      const p = data.payload;
      if (typeof p.lat === 'number' && typeof p.lon === 'number') {
        lat = p.lat;
        lon = p.lon;
      } else if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        lat = p.latitude;
        lon = p.longitude;
      } else if (typeof p.latitude_i === 'number' && typeof p.longitude_i === 'number') {
        lat = p.latitude_i / 1e7;
        lon = p.longitude_i / 1e7;
      } else if (typeof p.latitudeI === 'number' && typeof p.longitudeI === 'number') {
        lat = p.latitudeI / 1e7;
        lon = p.longitudeI / 1e7;
      }
      if (typeof p.altitude === 'number') alt = p.altitude;
    }

    // Check decoded.position
    if (data.decoded?.position && typeof data.decoded.position === 'object') {
      const pos = data.decoded.position;
      if (typeof pos.latitudeI === 'number' && typeof pos.longitudeI === 'number') {
        lat = pos.latitudeI / 1e7;
        lon = pos.longitudeI / 1e7;
      } else if (typeof pos.latitude === 'number' && typeof pos.longitude === 'number') {
        lat = pos.latitude;
        lon = pos.longitude;
      }
      if (typeof pos.altitude === 'number') alt = pos.altitude;
    }

    if (alt === null && typeof data.altitude === 'number') {
      alt = data.altitude;
    }

    // Validate geographic limits
    if (lat !== null && lon !== null) {
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        // Discard (0, 0) default no-fix
        if (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001) {
          return {
            id: `mesh-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            latitude: Number(lat.toFixed(6)),
            longitude: Number(lon.toFixed(6)),
            altitude: alt !== null ? Number(alt.toFixed(1)) : null,
            node_id: nodeId,
            source: 'Meshtastic JSON',
            timestamp: new Date().toISOString(),
            raw: line.trim(),
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Strips ANSI/VT100 colour escapes from a serial line.
 *
 * Meshtastic firmware colourises its console log even over USB serial, so raw
 * lines look like "\u001b[34mDEBUG \u001b[0m| ... [GPS] ...".
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Meshtastic firmware console position lines, e.g.
 *   DEBUG | 11:36:30 67 [Router] POSITION node=a1d7631c l=33 lat=386993383 lon=-92322000 msl=105 hae=0 ...
 *   INFO  | 11:36:30 67 [Router] updatePosition REMOTE node=0xa1d7631c time=1790681791 lat=386993383 lon=-92322000
 *
 * Latitude/longitude are 1e7-scaled integers; a value containing a decimal
 * point is already in degrees.
 */
export function parseMeshtasticLogLine(line: string): GpsPoint | null {
  const text = stripAnsi(line);

  const fix = text.match(/\blat=(-?\d+(?:\.\d+)?)[\s,;]+lon=(-?\d+(?:\.\d+)?)/);
  if (!fix) return null;

  const toDegrees = (raw: string): number => {
    const value = Number(raw);
    if (raw.includes('.') || /e/i.test(raw)) return value;
    return Math.abs(value) > 180 ? value / 1e7 : value;
  };

  const lat = toDegrees(fix[1]);
  const lon = toDegrees(fix[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Discard the (0, 0) placeholder a node reports before it has a fix.
  if (Math.abs(lat) <= 0.0001 && Math.abs(lon) <= 0.0001) return null;

  // `msl` (mean sea level) is the altitude Meshtastic logs; `hae` is ellipsoid.
  const altMatch = text.match(/\b(?:msl|alt|altitude)=(-?\d+(?:\.\d+)?)/);
  const nodeMatch = text.match(/\bnode=(0x[0-9a-fA-F]+|[0-9a-fA-F]{4,})/);

  return {
    id: `meshlog-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    altitude: altMatch ? Number(Number(altMatch[1]).toFixed(1)) : null,
    node_id: nodeMatch ? `!${nodeMatch[1].toLowerCase().replace(/^0x/, '')}` : null,
    source: 'Meshtastic Log',
    timestamp: new Date().toISOString(),
    raw: text.trim(),
  };
}

/**
 * Unified stream line parser.
 */
export function parseSerialStreamLine(line: string): GpsPoint | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.includes('{') && trimmed.includes('}')) {
    const jsonParsed = parseMeshtasticJson(trimmed);
    if (jsonParsed) return jsonParsed;
  }

  if (trimmed.includes('$')) {
    const nmeaParsed = parseNmeaSentence(trimmed);
    if (nmeaParsed) return nmeaParsed;
  }

  // Firmware console log lines carry `lat=`/`lon=` key/value pairs.
  const logParsed = parseMeshtasticLogLine(trimmed);
  if (logParsed) return logParsed;

  return null;
}
