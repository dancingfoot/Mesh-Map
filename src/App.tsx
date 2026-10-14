import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import { GpsPoint, ConnectionStatus, SerialSettings, SimulationRoute, AvailablePort } from './types';
import { parseSerialStreamLine, stripAnsi } from './utils/parser';
import { filterByWindow, nodeKey, summariseNodes } from './utils/nodes';
import { FoliumMap } from './components/FoliumMap';
import { MetricsBar } from './components/MetricsBar';
import { SerialTerminal } from './components/SerialTerminal';
import { PointsTable } from './components/PointsTable';
import { Sidebar } from './components/Sidebar';
import { MapNodeOverlay } from './components/MapNodeOverlay';
import { Panel, PanelResetContext, clearPanelLayout } from './components/Panel';
import { parseTelemetryLine, summariseTelemetry, TelemetrySample } from './utils/telemetry';
import { loadOscConfig, type OscClientConfig } from './utils/oscClient';
import { loadMidiConfig, type MidiConfig } from './utils/midi';
import { loadMqttConfig, type MqttConfig } from './utils/mqttClient';
import { configureOsc, ingestOutputs } from './utils/outputs';
import { releaseSerialSession } from './utils/serialSession';
import {
  MeshtasticStreamScanner,
  encodeWantConfigRequest,
  normaliseNodeId as normaliseProtoNodeId,
} from './utils/meshtasticProtocol';
import { appendPoints, devicePositionToPoint } from './utils/devicePoints';
import { mergeNodeIdentity, parseNodeIdentity, type NodeIdentityMap } from './utils/nodeNames';
import { parseLineToCapturedPacket } from './utils/packetParser';

// MeshDash Feature Components
import { MeshDashOverview } from './components/MeshDashOverview';
import { MeshShark, type CapturedPacket } from './components/MeshShark';
import { MeshChat, type ChatMessage } from './components/MeshChat';
import { MeshTraceroute } from './components/MeshTraceroute';

import {
  Radio,
  Map,
  Terminal,
  List,
  Trash2,
  Info,
  LayoutGrid,
  Activity,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Shield,
  MessageSquare,
  Share2,
  Layers,
  Settings2,
  Compass,
  Cpu,
  X,
} from 'lucide-react';

const TelemetryPanel = lazy(() =>
  import('./components/TelemetryPanel').then((module) => ({ default: module.TelemetryPanel }))
);
const OutputsPanel = lazy(() =>
  import('./components/OutputsPanel').then((module) => ({ default: module.OutputsPanel }))
);
const MqttPanel = lazy(() =>
  import('./components/MqttPanel').then((module) => ({ default: module.MqttPanel }))
);

const TabLoading: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 p-6 text-xs text-slate-400 font-mono" role="status">
    <span className="w-3 h-3 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
    Loading {label}…
  </div>
);

const SIMULATION_ROUTES: SimulationRoute[] = [
  {
    name: 'San Francisco Urban Walk',
    description: 'Civic Center to Hayes Valley Meshtastic mesh node relay',
    baseLat: 37.7749,
    baseLon: -122.4194,
    baseAlt: 42.0,
  },
  {
    name: 'Rocky Mountain Alpine Ridge',
    description: 'High elevation VHF/UHF LoRa repeaters in Colorado',
    baseLat: 39.7392,
    baseLon: -104.9903,
    baseAlt: 1609.0,
  },
  {
    name: 'Munich City Mesh Node',
    description: 'Marienplatz to English Garden tracking',
    baseLat: 48.1371,
    baseLon: 11.5754,
    baseAlt: 519.0,
  },
];

const TELEMETRY_SAMPLE_CAP = 5000;
const RAIL_WIDTH_KEY = 'meshmap:rail-width:v1';
const RAIL_HIDDEN_KEY = 'meshmap:rail-hidden:v1';
const RAIL_MIN_WIDTH = 260;
const RAIL_MAX_WIDTH = 580;
const RAIL_DEFAULT_WIDTH = 320;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readStoredRailWidth(): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (!raw) return RAIL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return RAIL_DEFAULT_WIDTH;
    return clampNumber(parsed, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH);
  } catch {
    return RAIL_DEFAULT_WIDTH;
  }
}

function readStoredRailHidden(): boolean {
  try {
    return window.localStorage.getItem(RAIL_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function getUsbDeviceLabel(info: any, index: number): { label: string; description: string } {
  const vid = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0').toUpperCase() : '';
  const pid = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0').toUpperCase() : '';

  let chip = 'USB Serial Device';
  if (vid === '10C4') chip = 'Silicon Labs CP210x (ESP32/T-Beam)';
  else if (vid === '1A86') chip = 'WCH CH340 / CH9102 (Heltec V3)';
  else if (vid === '303A') chip = 'Espressif USB JTAG/CDC (ESP32-S3)';
  else if (vid === '1915') chip = 'Nordic nRF52840 (RAK4631)';
  else if (vid === '2E8A') chip = 'Raspberry Pi Pico';
  else if (vid === '0403') chip = 'FTDI USB Serial';

  return {
    label: `USB Port #${index + 1} · ${chip} [${vid}:${pid}]`,
    description: `${chip} (Vendor: 0x${vid}, Product: 0x${pid})`,
  };
}

export type ActiveTabType =
  | 'overview'
  | 'map'
  | 'meshshark'
  | 'chat'
  | 'traceroute'
  | 'telemetry'
  | 'terminal'
  | 'points'
  | 'outputs'
  | 'mqtt';

export default function App() {
  // GPS State
  const [points, setPoints] = useState<GpsPoint[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('overview');
  const [autoCenter, setAutoCenter] = useState(true);

  // Telemetry state
  const [telemetrySamples, setTelemetrySamples] = useState<TelemetrySample[]>([]);
  const [oscConfig, setOscConfig] = useState<OscClientConfig>(() => loadOscConfig());
  const [midiConfig, setMidiConfig] = useState<MidiConfig>(() => loadMidiConfig());
  const [mqttConfig, setMqttConfig] = useState<MqttConfig>(() => loadMqttConfig());
  const telemetryRef = useRef<TelemetrySample[]>([]);

  // Per-node view state
  const [hiddenNodeKeys, setHiddenNodeKeys] = useState<string[]>([]);
  const [soloNodeKey, setSoloNodeKey] = useState<string | null>(null);
  const [nodeIdentities, setNodeIdentities] = useState<NodeIdentityMap>({});
  const [timeWindowMs, setTimeWindowMs] = useState<number | null>(null);

  // Layout state
  const [railWidth, setRailWidth] = useState<number>(() => readStoredRailWidth());
  const [railHidden, setRailHidden] = useState<boolean>(() => readStoredRailHidden());
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [isRadioDrawerOpen, setIsRadioDrawerOpen] = useState(false);

  // MeshShark Captured Packets State
  const [capturedPackets, setCapturedPackets] = useState<CapturedPacket[]>([
    {
      id: 'pkt-init-1',
      number: 1,
      timestamp: '11:30:15',
      timeEpoch: Date.now() - 60000,
      from: '!28a9df12',
      fromName: 'Sim Ridge Relay',
      to: '^all',
      portnum: 'NODEINFO_APP',
      rxSNR: 7.2,
      rxRSSI: -65,
      hopLimit: 3,
      hopStart: 3,
      hopsTraversed: 0,
      sizeBytes: 42,
      summary: 'NodeInfo: Sim Ridge Relay [HELTEC_V3]',
      decoded: {
        id: '!28a9df12',
        longName: 'Sim Ridge Relay',
        shortName: 'SIM1',
        hwModel: 'HELTEC_V3',
        role: 'ROUTER',
      },
      raw: '{"from":"!28a9df12","type":"nodeinfo","payload":{"id":"!28a9df12","longName":"Sim Ridge Relay","shortName":"SIM1","hwModel":"HELTEC_V3","role":"ROUTER"}}',
    },
    {
      id: 'pkt-init-2',
      number: 2,
      timestamp: '11:30:18',
      timeEpoch: Date.now() - 55000,
      from: '!28a9df12',
      fromName: 'Sim Ridge Relay',
      to: '^all',
      portnum: 'TELEMETRY_APP',
      rxSNR: 6.8,
      rxRSSI: -68,
      hopLimit: 3,
      hopStart: 3,
      hopsTraversed: 0,
      sizeBytes: 68,
      summary: 'DeviceMetrics: bat=88% volt=4.02V chUtil=3.2%',
      decoded: {
        batteryLevel: 88,
        voltage: 4.02,
        channelUtilization: 3.2,
        airUtilTx: 0.51,
        uptimeSeconds: 120,
      },
      raw: '{"sender":"!28a9df12","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":88,"voltage":4.02,"channelUtilization":3.2,"airUtilTx":0.51,"uptimeSeconds":120},"time":1728560000}}',
    },
    {
      id: 'pkt-init-3',
      number: 3,
      timestamp: '11:30:22',
      timeEpoch: Date.now() - 40000,
      from: '!28a9df12',
      fromName: 'Sim Ridge Relay',
      to: '^all',
      portnum: 'POSITION_APP',
      rxSNR: 6.4,
      rxRSSI: -71,
      hopLimit: 3,
      hopStart: 3,
      hopsTraversed: 0,
      sizeBytes: 36,
      summary: 'Position: lat=37.77490 lon=-122.41940 alt=42m',
      decoded: {
        latitude: 37.7749,
        longitude: -122.4194,
        altitude: 42,
        precision_bits: 32,
      },
      raw: '{"from":"!28a9df12","type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":42,"time":1728560022}}',
    },
  ]);

  // MeshChat Messages State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-1',
      timestamp: '11:32:10',
      channel: 0,
      fromNodeId: '!28a9df12',
      fromName: 'Sim Ridge Relay',
      fromColor: '#38bdf8',
      text: 'Relay station online · LoRa 915MHz SF11 BW250 CR4/5 active',
      status: 'acked',
      hopCount: 1,
      snr: 6.8,
    },
    {
      id: 'msg-2',
      timestamp: '11:34:25',
      channel: 0,
      fromNodeId: '!a1d7631c',
      fromName: 'Peak Repeater East',
      fromColor: '#a855f7',
      text: 'Beacon check received, battery 92% nominal. Mesh clear.',
      status: 'acked',
      hopCount: 2,
      snr: 4.5,
    },
  ]);

  // Available Ports State
  const [availablePorts, setAvailablePorts] = useState<AvailablePort[]>([]);
  const [settings, setSettings] = useState<SerialSettings>({
    port: '',
    baudRate: 115200,
    autoRefresh: true,
    refreshInterval: 2.0,
  });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [statusMessage, setStatusMessage] = useState('Disconnected');
  const [serialLogs, setSerialLogs] = useState<string[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);

  // Web Serial references
  const serialPortRef = useRef<any>(null);
  const serialReaderRef = useRef<any>(null);
  const isReadingRef = useRef<boolean>(false);
  const lastKnownCountRef = useRef<number>(0);
  const simulationTimerRef = useRef<any>(null);
  const simStepRef = useRef<number>(0);
  const simTelemetryRef = useRef<{ uptime: number; battery: number }>({ uptime: 0, battery: 87 });
  const simCoordsRef = useRef<{ lat: number; lon: number; alt: number }>({
    lat: SIMULATION_ROUTES[0].baseLat,
    lon: SIMULATION_ROUTES[0].baseLon,
    alt: SIMULATION_ROUTES[0].baseAlt,
  });

  const railResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  const windowPoints = useMemo(
    () => filterByWindow(points, timeWindowMs),
    [points, timeWindowMs]
  );

  const visiblePoints = useMemo(() => {
    return windowPoints.filter((pt) => {
      const key = nodeKey(pt);
      if (soloNodeKey !== null) return key === soloNodeKey;
      return !hiddenNodeKeys.includes(key);
    });
  }, [windowPoints, hiddenNodeKeys, soloNodeKey]);

  const nodeSummaries = useMemo(
    () => summariseNodes(windowPoints, nodeIdentities),
    [windowPoints, nodeIdentities]
  );

  const outputNodeTelemetry = useMemo(
    () => summariseTelemetry(telemetrySamples, 240),
    [telemetrySamples]
  );

  const seenMetrics = useMemo(() => {
    const rolled = summariseTelemetry(telemetrySamples, 240);
    const set = new Set<string>();
    for (const summary of rolled) {
      for (const key of Object.keys(summary.latest)) set.add(key);
      for (const key of Object.keys(summary.series)) set.add(key);
    }
    return [...set].sort();
  }, [telemetrySamples]);

  // Node filter callbacks
  const handleToggleNodeVisible = useCallback((key: string) => {
    setHiddenNodeKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }, []);

  const handleToggleSoloNode = useCallback((key: string) => {
    setSoloNodeKey((prev) => (prev === key ? null : key));
  }, []);

  const handleShowAllNodes = useCallback(() => {
    setHiddenNodeKeys([]);
    setSoloNodeKey(null);
  }, []);

  const handleHideAllNodes = useCallback(() => {
    setHiddenNodeKeys(nodeSummaries.map((n) => n.key));
    setSoloNodeKey(null);
  }, [nodeSummaries]);

  // Output config change handlers
  const handleOscConfigChange = useCallback((patch: Partial<OscClientConfig>) => {
    setOscConfig((prev) => {
      const next = { ...prev, ...patch };
      configureOsc(next);
      return next;
    });
  }, []);

  const handleMidiConfigChange = useCallback((patch: Partial<MidiConfig>) => {
    setMidiConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleMqttConfigChange = useCallback((patch: Partial<MqttConfig>) => {
    setMqttConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  // Rail resizing
  const handleRailResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    railResizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: railWidth,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    setIsRailResizing(true);
  };

  const handleRailResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = railResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setRailWidth(
      clampNumber(drag.startWidth + (e.clientX - drag.startX), RAIL_MIN_WIDTH, RAIL_MAX_WIDTH)
    );
  };

  const handleRailResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = railResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    railResizeRef.current = null;
    setIsRailResizing(false);
  };

  useEffect(() => {
    if (isRailResizing) return;
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
    } catch {}
  }, [railWidth, isRailResizing]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_HIDDEN_KEY, String(railHidden));
    } catch {}
  }, [railHidden]);

  const handleResetLayout = useCallback(() => {
    clearPanelLayout();
    try {
      window.localStorage.removeItem(RAIL_WIDTH_KEY);
    } catch {}
    setRailWidth(RAIL_DEFAULT_WIDTH);
    setLayoutResetNonce((n) => n + 1);
  }, []);

  const logSerial = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSerialLogs((prev) => {
      const next = [...prev, `[${timestamp}] ${msg}`];
      return next.length > 250 ? next.slice(-250) : next;
    });
  }, []);

  const refreshSerialPortInventory = useCallback(
    async (opts: { announce?: boolean } = {}) => {
      const authorised: AvailablePort[] = [];
      if (hasWebSerial) {
        try {
          const ports: any[] = await (navigator as any).serial.getPorts();
          ports.forEach((port: any, idx: number) => {
            const info = port.getInfo ? port.getInfo() : {};
            const { label, description } = getUsbDeviceLabel(info, idx);
            authorised.push({
              id: `web-serial-${idx}`,
              label,
              category: 'Authorized devices (Web Serial)',
              description,
              isWebSerial: true,
              portRef: port,
            });
          });
        } catch {}
      }

      let system: AvailablePort[] = [];
      try {
        const response = await fetch(`${oscConfig.url}/serial/ports`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            ports?: Array<{ path?: string; byId?: string | null; description?: string }>;
          };
          system = (body.ports ?? [])
            .filter((port) => typeof port.path === 'string' && port.path)
            .map((port) => ({
              id: `system:${port.path}`,
              label: `${port.path} — ${port.description ?? 'serial device'}`,
              category: 'On this system (bridge)',
              description: port.byId ? `stable id: ${port.byId}` : (port.description ?? ''),
            }));
        }
      } catch {}

      const next = [...authorised, ...system];
      setAvailablePorts(next);
      setSettings((prev) => {
        if (next.some((p) => p.id === prev.port)) return prev;
        const preferred = authorised[0] ?? system[0];
        return preferred ? { ...prev, port: preferred.id } : prev;
      });

      if (opts.announce) {
        logSerial(
          `Port scan: ${authorised.length} authorized device(s), ${system.length} reported by the local bridge.`
        );
      }
    },
    [hasWebSerial, logSerial, oscConfig.url]
  );

  useEffect(() => {
    void refreshSerialPortInventory({ announce: false });
  }, [refreshSerialPortInventory]);

  // Process incoming line from real Web Serial, simulator, or manual inject
  const processIncomingLine = useCallback(
    (line: string) => {
      const clean = stripAnsi(line);
      logSerial(`RX: ${clean}`);

      // Capture packet for MeshShark
      const captured = parseLineToCapturedPacket(clean);
      setCapturedPackets((prev) => [...prev.slice(-999), captured]);

      // Check for incoming text chat messages
      if (clean.includes('"type":"text"') || clean.includes('"type": "text"') || clean.includes('"text"')) {
        try {
          const obj = JSON.parse(clean);
          if (obj.payload?.text) {
            setChatMessages((prev) => [
              ...prev,
              {
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                timestamp: new Date().toLocaleTimeString(),
                channel: obj.channel ?? 0,
                fromNodeId: obj.from || '!unknown',
                fromName: obj.from === '!28a9df12' ? 'Sim Ridge Relay' : (obj.from || 'Mesh Node'),
                fromColor: '#38bdf8',
                text: obj.payload.text,
                status: 'acked',
                hopCount: 1,
                snr: 6.2,
              },
            ]);
          }
        } catch {}
      }

      // Node names identity merge
      const identity = parseNodeIdentity(clean);
      if (identity) {
        setNodeIdentities((prev) => mergeNodeIdentity(prev, identity));
      }

      // Telemetry capture
      const samples = parseTelemetryLine(clean);
      if (samples.length > 0) {
        setTelemetrySamples((prev) => {
          const next = [...prev, ...samples];
          return next.length > TELEMETRY_SAMPLE_CAP ? next.slice(-TELEMETRY_SAMPLE_CAP) : next;
        });

        const merged = [...telemetryRef.current, ...samples];
        const capped =
          merged.length > TELEMETRY_SAMPLE_CAP ? merged.slice(-TELEMETRY_SAMPLE_CAP) : merged;
        telemetryRef.current = capped;
        try {
          ingestOutputs(samples, summariseTelemetry(capped, 240));
        } catch {}
      }

      // GPS Position parse
      const parsed = parseSerialStreamLine(clean);
      if (parsed) {
        logSerial(
          `✓ Parsed ${parsed.source}: [Lat ${parsed.latitude.toFixed(6)}, Lon ${parsed.longitude.toFixed(6)}${
            parsed.altitude != null ? `, Alt ${parsed.altitude}m` : ''
          }]`
        );
        setPoints((prev) => appendPoints(prev, [parsed]));
      }
    },
    [logSerial]
  );

  // Send message in MeshChat
  const handleSendMessage = useCallback((channel: number, text: string, toNodeId?: string) => {
    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      channel,
      fromNodeId: 'local',
      fromName: 'My Radio (Heltec V3)',
      fromColor: '#00e87a',
      toNodeId,
      text,
      status: 'sent',
      hopCount: 0,
    };
    setChatMessages((prev) => [...prev, newMsg]);

    processIncomingLine(
      JSON.stringify({
        from: '!local',
        to: toNodeId || '^all',
        type: 'text',
        channel,
        payload: { text },
      })
    );

    setTimeout(() => {
      setChatMessages((prev) =>
        prev.map((m) => (m.id === newMsg.id ? { ...m, status: 'acked' } : m))
      );
    }, 700);

    if (connectionStatus === 'simulated' || connectionStatus === 'connected') {
      setTimeout(() => {
        const replies = [
          '10-4 Copy that loud and clear on mesh channel.',
          'Acknowledged. Tracking position fix on tactical map.',
          'Signal report: +7.2 dB SNR link quality.',
          'Copy station. Standing by on Channel 0.',
        ];
        const replyText = replies[Math.floor(Math.random() * replies.length)];
        const simReply: ChatMessage = {
          id: `msg-${Date.now() + 1}`,
          timestamp: new Date().toLocaleTimeString(),
          channel,
          fromNodeId: '!28a9df12',
          fromName: 'Sim Ridge Relay',
          fromColor: '#38bdf8',
          text: replyText,
          status: 'acked',
          hopCount: 1,
          snr: 6.4,
        };
        setChatMessages((prev) => [...prev, simReply]);
        logSerial(`RX TEXT [!28a9df12 -> Ch${channel}]: "${replyText}"`);
      }, 2200);
    }
  }, [connectionStatus, logSerial, processIncomingLine]);

  // Update simulation route base
  useEffect(() => {
    const route = SIMULATION_ROUTES[selectedRouteIndex];
    if (route) {
      simCoordsRef.current = { lat: route.baseLat, lon: route.baseLon, alt: route.baseAlt };
      simStepRef.current = 0;
    }
  }, [selectedRouteIndex]);

  // Start Hardware Simulation
  const handleStartSimulation = useCallback(() => {
    if (connectionStatus === 'connected') return;

    setConnectionStatus('simulated');
    setStatusMessage(`Demo Sim: ${SIMULATION_ROUTES[selectedRouteIndex].name}`);
    logSerial(`Starting hardware simulation (${SIMULATION_ROUTES[selectedRouteIndex].name})...`);

    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
    }

    simulationTimerRef.current = setInterval(() => {
      simStepRef.current += 1;
      const step = simStepRef.current;

      const angle = (step * 0.08) % (2 * Math.PI);
      const radius = 0.0035 + 0.001 * Math.sin(step * 0.02);

      const route = SIMULATION_ROUTES[selectedRouteIndex];
      const newLat = route.baseLat + radius * Math.cos(angle);
      const newLon = route.baseLon + radius * Math.sin(angle);
      const newAlt = route.baseAlt + 15 * Math.sin(step * 0.05);

      simCoordsRef.current = { lat: newLat, lon: newLon, alt: newAlt };

      if (step % 2 === 0) {
        processIncomingLine(
          JSON.stringify({
            from: '!28a9df12',
            type: 'position',
            payload: {
              latitude_i: Math.round(newLat * 1e7),
              longitude_i: Math.round(newLon * 1e7),
              altitude: Math.round(newAlt),
              time: Math.floor(Date.now() / 1000),
            },
          })
        );
      } else {
        const dLat = Math.floor(Math.abs(newLat));
        const mLat = (Math.abs(newLat) - dLat) * 60;
        const ns = newLat >= 0 ? 'N' : 'S';

        const dLon = Math.floor(Math.abs(newLon));
        const mLon = (Math.abs(newLon) - dLon) * 60;
        const ew = newLon >= 0 ? 'E' : 'W';

        const latStr = `${dLat.toString().padStart(2, '0')}${mLat.toFixed(3).padStart(6, '0')}`;
        const lonStr = `${dLon.toString().padStart(3, '0')}${mLon.toFixed(3).padStart(6, '0')}`;
        const timeStr = new Date().toISOString().replace(/[-:T]/g, '').slice(8, 14);

        const body = `GPGGA,${timeStr},${latStr},${ns},${lonStr},${ew},1,09,0.9,${newAlt.toFixed(1)},M,0.0,M,,`;
        let checksum = 0;
        for (let i = 0; i < body.length; i++) {
          checksum ^= body.charCodeAt(i);
        }
        const checksumHex = checksum.toString(16).toUpperCase().padStart(2, '0');
        const nmeaSentence = `$${body}*${checksumHex}`;

        processIncomingLine(nmeaSentence);
      }

      // Telemetry interleaving
      if (step % 3 === 0) {
        const drift = simTelemetryRef.current;
        drift.uptime += 10;
        drift.battery = Math.max(20, drift.battery - 0.02);

        const epoch = Math.floor(Date.now() / 1000);
        const ambient = 21.4 + 1.2 * Math.sin(step / 9);
        const secondNode = (step & 4) === 0;

        if (secondNode) {
          processIncomingLine(
            JSON.stringify({
              sender: '!a1d7631c',
              type: 'telemetry',
              payload: {
                environmentMetrics: {
                  temperature: Number(ambient.toFixed(2)),
                  relativeHumidity: Number((48.2 + 3.5 * Math.sin(step / 7)).toFixed(1)),
                  barometricPressure: Number((1013.2 + 0.9 * Math.cos(step / 11)).toFixed(1)),
                },
                time: epoch,
              },
            })
          );
        } else {
          processIncomingLine(
            JSON.stringify({
              sender: '!28a9df12',
              type: 'telemetry',
              payload: {
                deviceMetrics: {
                  batteryLevel: Math.round(drift.battery),
                  voltage: Number((4.02 - (90 - drift.battery) * 0.004).toFixed(2)),
                  channelUtilization: Number((3.2 + 0.9 * Math.sin(step / 5)).toFixed(2)),
                  airUtilTx: Number((0.51 + 0.08 * Math.cos(step / 6)).toFixed(2)),
                  uptimeSeconds: drift.uptime,
                },
                time: epoch,
              },
            })
          );
        }

        if (step % 9 === 0) {
          const snr = (6.25 + 1.5 * Math.sin(step / 4)).toFixed(2);
          const rssi = Math.round(-69 - 4 * Math.sin(step / 6));
          processIncomingLine(
            `INFO  | 11:36:30 67 [Router] Lora RX (node=!28a9df12 Ch=0x41 len=93 rxSNR=${snr} rxRSSI=${rssi} hopStart=3 hopLimit=3)`
          );
        }

        if (step % 15 === 0) {
          processIncomingLine(
            JSON.stringify({
              from: '!28a9df12',
              type: 'nodeinfo',
              payload: {
                id: '!28a9df12',
                longName: 'Sim Ridge Relay',
                shortName: 'SIM1',
                hwModel: 'HELTEC_V3',
                role: 'ROUTER',
              },
            })
          );
        }

        // Periodic text message chatter
        if (step % 21 === 0) {
          const chatter = [
            'Beacon verified · 915MHz LoRa SF11',
            'Routing check: 3 mesh nodes responsive',
            'Relay operational, air utilization 2.8%',
          ];
          const textMsg = chatter[Math.floor(Math.random() * chatter.length)];
          processIncomingLine(
            JSON.stringify({
              from: '!28a9df12',
              type: 'text',
              channel: 0,
              payload: { text: textMsg },
            })
          );
        }
      }
    }, settings.refreshInterval * 1000);
  }, [connectionStatus, selectedRouteIndex, settings.refreshInterval, logSerial, processIncomingLine]);

  // Stop Simulation
  const handleStopSimulation = useCallback(() => {
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    setConnectionStatus('disconnected');
    setStatusMessage('Disconnected');
    logSerial('Hardware simulation stopped.');
  }, [logSerial]);

  // Web Serial Connection
  const handleConnectSerial = useCallback(async () => {
    if (!hasWebSerial) {
      logSerial('Error: Web Serial API not supported in this browser.');
      return;
    }
    if (connectionStatus === 'connected') return;

    if (connectionStatus === 'simulated') {
      handleStopSimulation();
    }

    try {
      setConnectionStatus('connecting');
      setStatusMessage('Connecting via Web Serial...');
      logSerial(`Requesting Web Serial port authorization (baud: ${settings.baudRate})...`);

      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: settings.baudRate });

      serialPortRef.current = port;
      setConnectionStatus('connected');
      setStatusMessage(`Connected: ${settings.baudRate} baud`);
      logSerial(`Connected to serial hardware at ${settings.baudRate} baud.`);

      void refreshSerialPortInventory({ announce: true });

      const reader = port.readable.getReader();
      serialReaderRef.current = reader;

      const scanner = new MeshtasticStreamScanner();
      let buffer = '';

      (async () => {
        try {
          while (isReadingRef.current) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value || !value.length) continue;

            const {
              text,
              nodeInfos,
              positions,
              lastKnownPositions,
              configComplete,
              knownNodeNames,
            } = scanner.push(value);

            if (lastKnownPositions.length > 0) {
              const remembered = lastKnownPositions.map((position: any) =>
                devicePositionToPoint(position, Date.now(), true)
              );
              setPoints((prev) => appendPoints(prev, remembered));
              lastKnownCountRef.current += remembered.length;
            }

            if (positions.length > 0) {
              const incoming = positions.map((position: any) => devicePositionToPoint(position));
              setPoints((prev) => appendPoints(prev, incoming));
              incoming.forEach((point: any) => {
                logSerial(
                  `✓ Parsed ${point.source}: [Lat ${point.latitude.toFixed(6)}, Lon ${point.longitude.toFixed(6)}${
                    point.altitude != null ? `, Alt ${point.altitude}m` : ''
                  }]`
                );
              });
            }

            if (nodeInfos.length > 0) {
              setNodeIdentities((prev) => {
                let next = prev;
                for (const info of nodeInfos) {
                  const nodeId = normaliseProtoNodeId(info.nodeId);
                  if (!nodeId) continue;
                  next = mergeNodeIdentity(next, {
                    nodeId,
                    longName: info.longName,
                    shortName: info.shortName,
                  });
                }
                return next;
              });
            }

            if (configComplete) {
              const mapped = lastKnownCountRef.current;
              logSerial(
                `Device finished sending its node database — ${knownNodeNames} node name${
                  knownNodeNames === 1 ? '' : 's'
                } learned, ${mapped} last-known position${mapped === 1 ? '' : 's'} mapped.`
              );
              lastKnownCountRef.current = 0;
            }

            if (!text) continue;
            buffer += text;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.trim()) {
                processIncomingLine(line);
              }
            }
          }
        } catch (readErr: any) {
          logSerial(`Serial reader error: ${readErr.message}`);
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      })();
    } catch (err: any) {
      setConnectionStatus('disconnected');
      setStatusMessage('Connection failed');
      logSerial(`Serial Connection failed: ${err.message}`);
    }
  }, [
    hasWebSerial,
    connectionStatus,
    settings.baudRate,
    logSerial,
    handleStopSimulation,
    refreshSerialPortInventory,
    processIncomingLine,
  ]);

  const handleDisconnect = useCallback(async () => {
    isReadingRef.current = false;
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    if (serialReaderRef.current) {
      try {
        await serialReaderRef.current.cancel();
      } catch {}
      serialReaderRef.current = null;
    }
    if (serialPortRef.current) {
      try {
        await releaseSerialSession(serialPortRef.current);
      } catch {}
      serialPortRef.current = null;
    }
    setConnectionStatus('disconnected');
    setStatusMessage('Disconnected');
    logSerial('Serial disconnected.');
  }, [logSerial]);

  const handleScanNewPort = useCallback(async () => {
    if (!hasWebSerial) {
      logSerial('Error: Web Serial not supported in this browser.');
      return;
    }
    try {
      logSerial('Opening browser device selector...');
      await (navigator as any).serial.requestPort();
      await refreshSerialPortInventory({ announce: true });
    } catch (err: any) {
      logSerial(`Scan cancelled: ${err.message}`);
    }
  }, [hasWebSerial, logSerial, refreshSerialPortInventory]);

  const requestNodeDatabase = useCallback(async () => {
    const port = serialPortRef.current;
    if (!port || !port.writable) {
      logSerial('Cannot request node names: no hardware port connected.');
      return;
    }
    try {
      const writer = port.writable.getWriter();
      const payload = encodeWantConfigRequest();
      await writer.write(payload);
      writer.releaseLock();
      logSerial('Sent wantConfig request to radio.');
    } catch (err: any) {
      logSerial(`Error requesting node names: ${err.message}`);
    }
  }, [logSerial]);

  const handleClearPath = useCallback(() => {
    setPoints([]);
    setCapturedPackets([]);
    logSerial('Purged recorded coordinates and packet buffer.');
  }, [logSerial]);

  // Navigate to map and solo a specific node from Fleet Overview
  const handleNavigateToMap = useCallback((nodeKeyToSolo?: string) => {
    setActiveTab('map');
    if (nodeKeyToSolo) {
      setSoloNodeKey(nodeKeyToSolo);
    }
  }, []);

  return (
    <PanelResetContext.Provider value={layoutResetNonce}>
      <div className="flex h-screen w-screen overflow-hidden bg-[#070B12] text-slate-100 font-sans select-none antialiased">
        {/* ── OPTIONAL DOCKED LEFT RAIL (can be toggled from topbar) ── */}
        {!railHidden && (
          <aside
            style={{ width: `${railWidth}px` }}
            className="flex flex-col border-r border-slate-800/90 bg-[#0A0F19] shrink-0 z-30 transition-all select-none"
          >
            {/* Rail Header */}
            <div className="p-3 border-b border-slate-800/80 bg-[#0E1524] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold font-mono tracking-wider text-slate-200">Radio &amp; Bus Config</span>
              </div>
              <button
                type="button"
                onClick={() => setRailHidden(true)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                title="Hide left panel (expand workspace)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <Sidebar
                settings={settings}
                onUpdateSettings={(newVals) => setSettings((prev) => ({ ...prev, ...newVals }))}
                status={connectionStatus}
                statusMessage={statusMessage}
                availablePorts={availablePorts}
                onScanNewPort={handleScanNewPort}
                onRequestNodeNames={() => {
                  void requestNodeDatabase();
                }}
                onConnectSerial={handleConnectSerial}
                onDisconnect={handleDisconnect}
                onStartSimulation={handleStartSimulation}
                onStopSimulation={handleStopSimulation}
                onClearPath={handleClearPath}
                selectedRouteIndex={selectedRouteIndex}
                onSelectRouteIndex={setSelectedRouteIndex}
              />
            </div>

            <div className="p-2.5 border-t border-slate-800/80 bg-[#0B101B] text-[10px] text-slate-500 font-mono flex items-center justify-between">
              <span>Mesh-Map v1.5 · MeshDash C2</span>
              <button
                type="button"
                onClick={handleResetLayout}
                className="text-slate-400 hover:text-slate-200 hover:underline flex items-center gap-1"
              >
                <LayoutGrid className="w-3 h-3" />
                <span>Reset</span>
              </button>
            </div>
          </aside>
        )}

        {/* Resizer for Rail */}
        {!railHidden && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handleRailResizePointerDown}
            onPointerMove={handleRailResizePointerMove}
            onPointerUp={handleRailResizeEnd}
            onPointerCancel={handleRailResizeEnd}
            onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
            className={`w-1 cursor-col-resize shrink-0 transition-colors ${
              isRailResizing ? 'bg-cyan-500' : 'bg-slate-800 hover:bg-cyan-500/60'
            }`}
          />
        )}

        {/* ── MAIN WORKSPACE CONTENT ── */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-[#070B12]">
          {/* ── MESHDASH COMPACT HEADER (Signature Compact C2 Top Bar) ── */}
          <header className="h-12 px-3 sm:px-4 bg-[#0E1524] border-b border-slate-800/90 flex items-center justify-between gap-3 shrink-0 select-none z-20">
            {/* Left Zone: Brand + Live State */}
            <div className="flex items-center gap-2.5 shrink-0">
              {railHidden && (
                <button
                  type="button"
                  onClick={() => setRailHidden(false)}
                  title="Open radio & serial sidebar"
                  className="p-1.5 rounded-lg bg-[#121B2C] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-cyan-400 transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )}

              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white shadow-sm shadow-cyan-950">
                  <Radio className="w-4 h-4" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs sm:text-sm font-bold font-mono tracking-tight text-white">
                      Mesh-Map
                    </span>
                    <span className="text-[9px] font-mono font-semibold px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/80">
                      MeshDash C2
                    </span>
                  </div>
                </div>
              </div>

              {/* Status Badge */}
              <div
                className={`hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium border ${
                  connectionStatus === 'connected'
                    ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                    : connectionStatus === 'simulated'
                    ? 'bg-purple-950/70 border-purple-800 text-purple-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    connectionStatus === 'connected'
                      ? 'bg-emerald-400 animate-pulse'
                      : connectionStatus === 'simulated'
                      ? 'bg-purple-400 animate-pulse'
                      : 'bg-slate-500'
                  }`}
                />
                <span>
                  {connectionStatus === 'connected'
                    ? 'Radio Active'
                    : connectionStatus === 'simulated'
                    ? 'Demo Sim'
                    : 'Radio Offline'}
                </span>
              </div>
            </div>

            {/* Center Zone: Compact Nav Tabs */}
            <nav className="flex items-center gap-1 bg-[#090D16] p-1 rounded-xl border border-slate-800/80 overflow-x-auto">
              <button
                onClick={() => setActiveTab('overview')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'overview'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Fleet ({nodeSummaries.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('map')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'map'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Map className="w-3.5 h-3.5" />
                <span>Map</span>
              </button>

              <button
                onClick={() => setActiveTab('meshshark')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'meshshark'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Shield className="w-3.5 h-3.5" />
                <span>MeshShark</span>
                {capturedPackets.length > 0 && (
                  <span className="text-[10px] px-1 rounded bg-[#0A101A] text-cyan-300">
                    {capturedPackets.length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('chat')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'chat'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Messages</span>
                {chatMessages.length > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                )}
              </button>

              <button
                onClick={() => setActiveTab('traceroute')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'traceroute'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>Traceroute</span>
              </button>

              <button
                onClick={() => setActiveTab('telemetry')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'telemetry'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Telemetry</span>
              </button>

              <button
                onClick={() => setActiveTab('terminal')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'terminal'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Console</span>
              </button>

              <button
                onClick={() => setActiveTab('points')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'points'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                <span>Points</span>
              </button>

              <button
                onClick={() => setActiveTab('outputs')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'outputs'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Outputs</span>
              </button>

              <button
                onClick={() => setActiveTab('mqtt')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-lg transition-all ${
                  activeTab === 'mqtt'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm shadow-cyan-900/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
                title="MQTT telemetry stream ingest"
              >
                <Radio className="w-3.5 h-3.5" />
                <span>MQTT</span>
              </button>
            </nav>

            {/* Right Zone: Primary Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Clear Trace Button */}
              <button
                type="button"
                onClick={handleClearPath}
                title="Purge recorded coordinates and packets"
                className="p-1.5 rounded-lg bg-[#121B2C] border border-slate-800 hover:bg-rose-950/40 hover:text-rose-400 text-slate-400 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* Radio Config Drawer Button */}
              <button
                type="button"
                onClick={() => setIsRadioDrawerOpen(true)}
                title="Open Radio & Serial Configuration"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#121B2C] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-cyan-400 text-xs font-mono transition-colors"
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">Radio Settings</span>
              </button>
            </div>
          </header>

          {/* ── WORKSPACE BODY ── */}
          <main className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
            {/* Compact HUD Metrics Bar on top of all views except fullscreen map */}
            <MetricsBar points={visiblePoints} totalCount={points.length} />

            {/* 1. Fleet Dashboard (MeshDash Style Node Cards & KPIs) */}
            {activeTab === 'overview' && (
              <MeshDashOverview
                summaries={nodeSummaries}
                points={visiblePoints}
                telemetrySamples={telemetrySamples}
                hiddenNodeKeys={hiddenNodeKeys}
                soloNodeKey={soloNodeKey}
                onToggleVisible={handleToggleNodeVisible}
                onToggleSolo={handleToggleSoloNode}
                onNavigateToMap={handleNavigateToMap}
                onStartDemo={handleStartSimulation}
                onConnectSerial={handleConnectSerial}
              />
            )}

            {/* 2. Tactical Live Map */}
            {activeTab === 'map' && (
              <div className="space-y-3">
                <Panel
                  id="map-live"
                  title="Live Tactical Map"
                  icon={<Map className="w-3.5 h-3.5 text-cyan-400" />}
                  variant="dark"
                  defaultWidth={1040}
                  defaultHeight={760}
                  minWidth={380}
                  minHeight={320}
                  bodyClassName="p-0 overflow-hidden flex flex-col"
                  actions={
                    <span className="text-[10px] font-mono text-cyan-400 whitespace-nowrap">
                      {visiblePoints.length}/{points.length} fixes
                    </span>
                  }
                >
                  <FoliumMap
                    points={visiblePoints}
                    totalCount={points.length}
                    timeWindowMs={timeWindowMs}
                    onTimeWindowChange={setTimeWindowMs}
                    autoCenter={autoCenter}
                    onToggleAutoCenter={() => setAutoCenter(!autoCenter)}
                    identities={nodeIdentities}
                    onStartSimulation={handleStartSimulation}
                    onConnectSerial={handleConnectSerial}
                    overlay={
                      <MapNodeOverlay
                        summaries={nodeSummaries}
                        hiddenKeys={hiddenNodeKeys}
                        soloKey={soloNodeKey}
                        shownCount={visiblePoints.length}
                        windowedCount={windowPoints.length}
                        onToggleVisible={handleToggleNodeVisible}
                        onToggleSolo={handleToggleSoloNode}
                        onShowAll={handleShowAllNodes}
                        onHideAll={handleHideAllNodes}
                      />
                    }
                  />
                </Panel>
              </div>
            )}

            {/* 3. MeshShark Packet Analyser */}
            {activeTab === 'meshshark' && (
              <MeshShark
                packets={capturedPackets}
                onClearPackets={() => setCapturedPackets([])}
                onInjectPacket={processIncomingLine}
              />
            )}

            {/* 4. Mesh Messaging & Channel 0 Chat */}
            {activeTab === 'chat' && (
              <MeshChat
                messages={chatMessages}
                nodeSummaries={nodeSummaries}
                onSendMessage={handleSendMessage}
                isRadioConnected={connectionStatus === 'connected' || connectionStatus === 'simulated'}
              />
            )}

            {/* 5. Live Traceroute & RF Links */}
            {activeTab === 'traceroute' && (
              <MeshTraceroute
                nodes={nodeSummaries}
                onTriggerTrace={(targetId) => {
                  logSerial(`Initiating mesh traceroute probe towards ${targetId}...`);
                }}
              />
            )}

            {/* 6. Telemetry Analytics */}
            {activeTab === 'telemetry' && (
              <Panel
                id="telemetry-dashboard"
                title="Node Telemetry Analytics"
                icon={<Activity className="w-3.5 h-3.5 text-violet-400" />}
                variant="dark"
                defaultWidth={1040}
                defaultHeight={700}
                minWidth={420}
                minHeight={320}
                bodyClassName="p-0 overflow-hidden"
                actions={
                  <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                    {telemetrySamples.length} samples
                  </span>
                }
              >
                <Suspense fallback={<TabLoading label="telemetry" />}>
                  <TelemetryPanel samples={telemetrySamples} />
                </Suspense>
              </Panel>
            )}

            {/* 7. Serial Console & Injection */}
            {activeTab === 'terminal' && (
              <Panel
                id="serial-monitor-tab"
                title="Serial Monitor &amp; Protocol Stream"
                icon={<Terminal className="w-3.5 h-3.5 text-emerald-400" />}
                variant="dark"
                defaultWidth={1040}
                defaultHeight={640}
                minWidth={320}
                minHeight={260}
                bodyClassName="p-0 overflow-hidden"
              >
                <SerialTerminal
                  logs={serialLogs}
                  onClearLogs={() => setSerialLogs([])}
                  onInjectLine={processIncomingLine}
                />
              </Panel>
            )}

            {/* 8. Points Log Table */}
            {activeTab === 'points' && (
              <Panel
                id="points-log"
                title="GPS Points Log"
                icon={<List className="w-3.5 h-3.5 text-cyan-400" />}
                variant="dark"
                defaultWidth={1040}
                defaultHeight={640}
                minWidth={380}
                minHeight={260}
                bodyClassName="p-0 overflow-auto"
                actions={
                  <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                    {visiblePoints.length}/{points.length} fixes
                  </span>
                }
              >
                <PointsTable points={visiblePoints} totalCount={points.length} />
              </Panel>
            )}

            {/* 9. Outputs: OSC & MIDI */}
            {activeTab === 'outputs' && (
              <Panel
                id="outputs-dashboard"
                title="Outputs — OSC &amp; MIDI"
                icon={<SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />}
                variant="dark"
                defaultWidth={1040}
                defaultHeight={720}
                minWidth={420}
                minHeight={320}
                bodyClassName="p-0 overflow-y-auto"
                actions={
                  <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                    {oscConfig.enabled ? 'OSC on' : 'OSC off'} · {midiConfig.enabled ? 'MIDI on' : 'MIDI off'}
                  </span>
                }
              >
                <Suspense fallback={<TabLoading label="outputs" />}>
                  <OutputsPanel
                    oscConfig={oscConfig}
                    onOscConfigChange={handleOscConfigChange}
                    midiConfig={midiConfig}
                    onMidiConfigChange={handleMidiConfigChange}
                    nodeSummaries={outputNodeTelemetry}
                    seenMetrics={seenMetrics}
                  />
                </Suspense>
              </Panel>
            )}

            {/* 10. MQTT Ingest */}
            {activeTab === 'mqtt' && (
              <Panel
                id="mqtt-dashboard"
                title="MQTT Ingest"
                icon={<Radio className="w-3.5 h-3.5 text-cyan-400" />}
                variant="dark"
                defaultWidth={1040}
                defaultHeight={720}
                minWidth={420}
                minHeight={320}
                bodyClassName="p-0 overflow-y-auto"
                actions={
                  <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                    {mqttConfig.broker.host}:{mqttConfig.broker.port}
                  </span>
                }
              >
                <Suspense fallback={<TabLoading label="mqtt" />}>
                  <MqttPanel mqttConfig={mqttConfig} onMqttConfigChange={handleMqttConfigChange} />
                </Suspense>
              </Panel>
            )}
          </main>
        </div>

        {/* ── SLIDE-OVER RADIO CONFIGURATION DRAWER ── */}
        {isRadioDrawerOpen && (
          <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-md h-full bg-[#0E1524] border-l border-slate-800 shadow-2xl flex flex-col">
              <div className="p-3.5 border-b border-slate-800 bg-[#111A28] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold text-sm font-mono text-slate-200">Radio Hardware &amp; Serial Bus</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRadioDrawerOpen(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <Sidebar
                  settings={settings}
                  onUpdateSettings={(newVals) => setSettings((prev) => ({ ...prev, ...newVals }))}
                  status={connectionStatus}
                  statusMessage={statusMessage}
                  availablePorts={availablePorts}
                  onScanNewPort={handleScanNewPort}
                  onRequestNodeNames={() => {
                    void requestNodeDatabase();
                  }}
                  onConnectSerial={handleConnectSerial}
                  onDisconnect={handleDisconnect}
                  onStartSimulation={handleStartSimulation}
                  onStopSimulation={handleStopSimulation}
                  onClearPath={handleClearPath}
                  selectedRouteIndex={selectedRouteIndex}
                  onSelectRouteIndex={setSelectedRouteIndex}
                />
              </div>

              <div className="p-3 border-t border-slate-800 bg-[#0B101B] flex items-center justify-between">
                <span className="text-[11px] font-mono text-slate-500">LoRa 915/868MHz Web Serial</span>
                <button
                  type="button"
                  onClick={() => setIsRadioDrawerOpen(false)}
                  className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-mono font-bold transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PanelResetContext.Provider>
  );
}
