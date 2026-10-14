import { CapturedPacket } from '../components/MeshShark';

let packetCounter = 1;

export function parseLineToCapturedPacket(line: string): CapturedPacket {
  const now = new Date();
  const timeStr = now.toLocaleTimeString();
  const num = packetCounter++;
  const id = `pkt-${num}-${Math.random().toString(36).slice(2, 6)}`;
  const sizeBytes = Math.max(18, Math.floor(line.length * 0.75));

  // Default values
  let portnum: CapturedPacket['portnum'] = 'NMEA';
  let from = '!local';
  let fromName: string | undefined = undefined;
  let to = '^all';
  let summary = line.slice(0, 60);
  let decoded: Record<string, any> = {};
  let rxSNR: number | null = null;
  let rxRSSI: number | null = null;
  let hopLimit = 3;
  let hopStart = 3;
  let hopsTraversed = 0;

  if (line.startsWith('$GP') || line.startsWith('$GN')) {
    portnum = 'NMEA';
    from = 'GPS-CHIP';
    fromName = 'NMEA GPS Sensor';
    to = 'HOST';
    const type = line.slice(1, 6);
    summary = `${type} NMEA Navigation sentence`;
    decoded = {
      sentence: type,
      rawNmea: line,
      status: 'VALID_FIX',
    };
  } else if (line.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      decoded = obj;

      if (obj.from || obj.sender) {
        from = obj.from || obj.sender;
      }
      if (obj.to) {
        to = obj.to;
      }

      if (obj.type === 'telemetry' || obj.payload?.deviceMetrics || obj.payload?.environmentMetrics) {
        portnum = 'TELEMETRY_APP';
        if (obj.payload?.deviceMetrics) {
          const dm = obj.payload.deviceMetrics;
          summary = `DeviceMetrics: bat=${dm.batteryLevel ?? '?'}% volt=${dm.voltage ?? '?'}V chUtil=${dm.channelUtilization ?? '?'}%`;
        } else if (obj.payload?.environmentMetrics) {
          const em = obj.payload.environmentMetrics;
          summary = `EnvironmentMetrics: temp=${em.temperature ?? '?'}°C hum=${em.relativeHumidity ?? '?'}%`;
        } else {
          summary = 'Telemetry metrics packet';
        }
      } else if (obj.type === 'nodeinfo' || obj.payload?.longName) {
        portnum = 'NODEINFO_APP';
        fromName = obj.payload?.longName || obj.payload?.shortName;
        summary = `NodeInfo: ${obj.payload?.longName || from} [${obj.payload?.hwModel || 'LORA'}]`;
      } else if (obj.type === 'text' || obj.payload?.text) {
        portnum = 'TEXT_MESSAGE_APP';
        summary = `Text: "${obj.payload?.text || ''}"`;
      } else if (obj.type === 'position' || obj.payload?.latitude_i != null || obj.payload?.latitude != null) {
        portnum = 'POSITION_APP';
        const lat = obj.payload?.latitude ?? (obj.payload?.latitude_i != null ? obj.payload.latitude_i / 1e7 : null);
        const lon = obj.payload?.longitude ?? (obj.payload?.longitude_i != null ? obj.payload.longitude_i / 1e7 : null);
        summary = `Position: lat=${lat?.toFixed(5) ?? '?'} lon=${lon?.toFixed(5) ?? '?'}`;
      } else {
        summary = `Meshtastic ${obj.type || 'packet'}`;
      }
    } catch {
      summary = line.slice(0, 60);
    }
  } else if (line.includes('Lora RX') || line.includes('rxSNR')) {
    portnum = 'ROUTING_APP';
    const snrMatch = line.match(/rxSNR=([-\d.]+)/);
    const rssiMatch = line.match(/rxRSSI=([-\d.]+)/);
    const nodeMatch = line.match(/node=([!a-zA-Z0-9]+)/);
    const hopStartMatch = line.match(/hopStart=(\d+)/);
    const hopLimitMatch = line.match(/hopLimit=(\d+)/);

    if (snrMatch) rxSNR = parseFloat(snrMatch[1]);
    if (rssiMatch) rxRSSI = parseFloat(rssiMatch[1]);
    if (nodeMatch) from = nodeMatch[1];
    if (hopStartMatch) hopStart = parseInt(hopStartMatch[1], 10);
    if (hopLimitMatch) hopLimit = parseInt(hopLimitMatch[1], 10);
    hopsTraversed = Math.max(0, hopStart - hopLimit);

    summary = `LoRa RX from ${from}: SNR=${rxSNR ?? '?'}dB RSSI=${rxRSSI ?? '?'}dBm (${hopsTraversed} hops)`;
    decoded = {
      rxSNR,
      rxRSSI,
      sourceNode: from,
      hopStart,
      hopLimit,
      hopsTraversed,
    };
  }

  return {
    id,
    number: num,
    timestamp: timeStr,
    timeEpoch: now.getTime(),
    from,
    fromName,
    to,
    portnum,
    rxSNR,
    rxRSSI,
    hopLimit,
    hopStart,
    hopsTraversed,
    sizeBytes,
    summary,
    decoded,
    raw: line,
  };
}
