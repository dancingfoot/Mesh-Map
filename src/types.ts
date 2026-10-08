export interface GpsPoint {
  id: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  speed_kmh?: number | null;
  satellites?: number | null;
  node_id?: string | null;
  source: string;
  timestamp: string;
  raw: string;
  /**
   * True when this fix came from the device's node database rather than a live
   * packet — it is that node's LAST KNOWN position and may be hours old.
   */
  isStale?: boolean;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'simulated' | 'error';

export interface SerialSettings {
  port: string;
  baudRate: number;
  autoRefresh: boolean;
  refreshInterval: number; // in seconds
}

export interface SimulationRoute {
  name: string;
  description: string;
  baseLat: number;
  baseLon: number;
  baseAlt: number;
}

export interface AvailablePort {
  id: string;
  label: string;
  category: string;
  description?: string;
  isWebSerial?: boolean;
  portRef?: any;
}

