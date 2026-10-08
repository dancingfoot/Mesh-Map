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
import { configureOsc, ingestOutputs } from './utils/outputs';
import { releaseSerialSession } from './utils/serialSession';
import {
  MeshtasticStreamScanner,
  encodeWantConfigRequest,
  normaliseNodeId as normaliseProtoNodeId,
} from './utils/meshtasticProtocol';
import { appendPoints, devicePositionToPoint } from './utils/devicePoints';
import { mergeNodeIdentity, parseNodeIdentity, type NodeIdentityMap } from './utils/nodeNames';

/**
 * The Telemetry and Outputs views are only reachable by clicking their tab, so
 * they are split out of the initial bundle: the map (what you see on load) does
 * not pay for ~400 lines of telemetry card UI or the OSC/MIDI editors.
 */
const TelemetryPanel = lazy(() =>
  import('./components/TelemetryPanel').then((module) => ({ default: module.TelemetryPanel }))
);
const OutputsPanel = lazy(() =>
  import('./components/OutputsPanel').then((module) => ({ default: module.OutputsPanel }))
);

/** Placeholder shown while a split view is fetched (usually one frame). */
const TabLoading: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 p-6 text-xs text-slate-400" role="status">
    <span className="w-3 h-3 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
    Loading {label}…
  </div>
);

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
} from 'lucide-react';

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


/** Newest telemetry samples retained in memory (oldest are dropped). */
const TELEMETRY_SAMPLE_CAP = 5000;

/** Persisted docked left-rail width (the "scalable" rail from the panel spec). */const RAIL_WIDTH_KEY = 'meshmap:rail-width:v1';
/** Persisted "hide the whole left panel" flag. */
const RAIL_HIDDEN_KEY = 'meshmap:rail-hidden:v1';
const RAIL_MIN_WIDTH = 248;
const RAIL_MAX_WIDTH = 620;
const RAIL_DEFAULT_WIDTH = 340;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Reads the stored rail width, falling back to the default on malformed data. */
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

/** Reads the stored "left panel hidden" flag; anything unusable means "shown". */
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

export default function App() {
  // GPS State
  const [points, setPoints] = useState<GpsPoint[]>([]);
  const [activeTab, setActiveTab] = useState<
    'map' | 'terminal' | 'points' | 'telemetry' | 'outputs'
  >('map');
  const [autoCenter, setAutoCenter] = useState(true);

  // Telemetry state: every parsed sample from every source, newest 5000 kept.
  const [telemetrySamples, setTelemetrySamples] = useState<TelemetrySample[]>([]);

  // Outputs (feature: OSC bridge + Web MIDI emission). Config is persisted by
  // the output modules; App only owns the React copy the Outputs tab edits.
  const [oscConfig, setOscConfig] = useState<OscClientConfig>(() => loadOscConfig());
  const [midiConfig, setMidiConfig] = useState<MidiConfig>(() => loadMidiConfig());

  // Mirror of `telemetrySamples` for the output dispatch: the serial read loop
  // must not wait for React to flush before it can roll telemetry up, and the
  // full array is also the source of the OSC address preview.
  const telemetryRef = useRef<TelemetrySample[]>([]);

  // Per-node view state (feature: node list + per-node traces)
  const [hiddenNodeKeys, setHiddenNodeKeys] = useState<string[]>([]);
  const [soloNodeKey, setSoloNodeKey] = useState<string | null>(null);
  /**
   * Node address -> human name, learned from `Send owner …` log lines and
   * nodeinfo packets. Everything that renders a node label reads this, so a
   * node shows as `Inov_Bas` instead of `!c931be04` as soon as its name arrives.
   */
  const [nodeIdentities, setNodeIdentities] = useState<NodeIdentityMap>({});

  // Time-window filter shared by map / legend / table / metrics
  const [timeWindowMs, setTimeWindowMs] = useState<number | null>(null);

  // Layout state (features: movable/resizable panels + resizable left rail)
  const [railWidth, setRailWidth] = useState<number>(() => readStoredRailWidth());
  const [railHidden, setRailHidden] = useState<boolean>(() => readStoredRailHidden());
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);

  // Available Ports State
  /**
   * Every entry here is a REAL device: either one this page has been granted, or
   * one the local bridge found on this machine. There is deliberately no
   * hardcoded fallback list — a guessed `/dev/ttyUSB0` or `COM3` is not a device.
   */
  const [availablePorts, setAvailablePorts] = useState<AvailablePort[]>([]);

  // Serial State
  const [settings, setSettings] = useState<SerialSettings>({
    // Empty until a real device is discovered — there is no default port.
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
  /** Last-known positions loaded in the current database dump (for one summary line). */
  const lastKnownCountRef = useRef<number>(0);
  const simulationTimerRef = useRef<any>(null);
  const simStepRef = useRef<number>(0);
  // Drifting demo telemetry values (battery drains, sensors wander).
  const simTelemetryRef = useRef<{ uptime: number; battery: number }>({ uptime: 0, battery: 87 });
  const simCoordsRef = useRef<{ lat: number; lon: number; alt: number }>({
    lat: SIMULATION_ROUTES[0].baseLat,
    lon: SIMULATION_ROUTES[0].baseLon,
    alt: SIMULATION_ROUTES[0].baseAlt,
  });

  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  // ------------------------------------------------------------------ nodes --
  // Packets inside the selected time window (all nodes in that window).
  const windowPoints = useMemo(() => filterByWindow(points, timeWindowMs), [points, timeWindowMs]);

  // One row per node of the current window (newest activity first).
  const nodeSummaries = useMemo(
    () => summariseNodes(windowPoints, nodeIdentities),
    [windowPoints, nodeIdentities]
  );

  // Per-node telemetry roll-up for the Outputs tab (OSC address preview and the
  // MIDI "live value" column). Derived from the same array the dispatch uses.
  const outputNodeSummaries = useMemo(
    () => summariseTelemetry(telemetryRef.current, 240),
    // `telemetrySamples` is the reactive trigger; the ref holds the same data.
    [telemetrySamples]
  );

  const seenMetrics = useMemo(() => {
    const names = new Set<string>();
    for (const node of outputNodeSummaries) {
      for (const metric of Object.keys(node.latest)) names.add(metric);
    }
    return [...names];
  }, [outputNodeSummaries]);

  const handleOscConfigChange = useCallback((next: OscClientConfig) => {
    setOscConfig(configureOsc(next));
  }, []);

  const handleMidiConfigChange = useCallback((next: MidiConfig) => {
    // `OutputsPanel` persists and applies it through `utils/midi`; App keeps the
    // React copy that both tabs and the panel render from.
    setMidiConfig(next);
  }, []);

  const hiddenNodeSet = useMemo(() => new Set(hiddenNodeKeys), [hiddenNodeKeys]);

  // What every view renders: time filter + per-node visibility (solo wins).
  const visiblePoints = useMemo(
    () =>
      windowPoints.filter((p) =>
        soloNodeKey ? nodeKey(p) === soloNodeKey : !hiddenNodeSet.has(nodeKey(p))
      ),
    [windowPoints, hiddenNodeSet, soloNodeKey]
  );

  const handleToggleNodeVisible = useCallback((key: string) => {
    // Leaving solo mode keeps the eye toggle's effect visible/obvious.
    setSoloNodeKey(null);
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
    setSoloNodeKey(null);
    setHiddenNodeKeys(nodeSummaries.map((s) => s.key));
  }, [nodeSummaries]);

  // ----------------------------------------------------------- rail resizing --
  const railResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null
  );

  const handleRailResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    railResizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: railWidth,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — the drag still tracks via pointermove */
    }
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
    if (isRailResizing) return; // persisted once the drag ends
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
    } catch {
      /* storage unavailable — rail width simply does not persist */
    }
  }, [railWidth, isRailResizing]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_HIDDEN_KEY, String(railHidden));
    } catch {
      /* storage unavailable — the panel still hides for this session */
    }
  }, [railHidden]);

  /** Docks/floats + expands every panel and clears stored sizes/positions. */
  const handleResetLayout = useCallback(() => {
    clearPanelLayout();
    try {
      window.localStorage.removeItem(RAIL_WIDTH_KEY);
    } catch {
      /* ignore */
    }
    setRailWidth(RAIL_DEFAULT_WIDTH);
    setLayoutResetNonce((n) => n + 1);
  }, []);

  // Append a serial log
  const logSerial = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSerialLogs((prev) => {
      const next = [...prev, `[${timestamp}] ${msg}`];
      return next.length > 250 ? next.slice(-250) : next;
    });
  }, []);

  /**
   * Builds the port list from both sources we actually have:
   *
   *  1. `navigator.serial.getPorts()` — devices this page has been granted.
   *     Web Serial exposes nothing else; the rest of the machine's ports are
   *     only visible through Chrome's own picker (the "+ Scan Hardware" button).
   *  2. The local bridge's `GET /serial/ports` — a native process CAN read the
   *     OS (`/dev/ttyUSB*`, …), which is the only way a web page learns what the
   *     machine really has before the user authorizes anything.
   */
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
        } catch {
          /* no Web Serial, or the browser refused — the bridge list still works */
        }
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
      } catch {
        /* bridge not running — that is the normal case for a browser-only setup */
      }

      const next = [...authorised, ...system];
      setAvailablePorts(next);
      setSettings((prev) => {
        // Never move the user off a device they picked; otherwise adopt the
        // first one found.
        if (next.some((p) => p.id === prev.port)) return prev;
        const preferred = authorised[0] ?? system[0];
        return preferred ? { ...prev, port: preferred.id } : prev;
      });

      if (opts.announce) {
        logSerial(
          `Port scan: ${authorised.length} authorized device(s), ${system.length} reported by the local bridge ` +
            `(bridge ${system.length > 0 ? 'reachable' : 'not reachable'}).`
        );
      }
    },
    [hasWebSerial, logSerial, oscConfig.url]
  );

  // Scan on mount so previously authorized devices are offered immediately.
  useEffect(() => {
    void refreshSerialPortInventory({ announce: false });
  }, [refreshSerialPortInventory]);

  // Process incoming raw line (from real Web Serial, simulator, or manual inject)
  const processIncomingLine = useCallback(
    (line: string) => {
      const clean = stripAnsi(line); // the firmware colourises its console output
      logSerial(`RX: ${clean}`);

      // Node names ride along in a few packet shapes (Log lines, nodeinfo JSON).
      const identity = parseNodeIdentity(clean);
      if (identity) {
        setNodeIdentities((prev) => mergeNodeIdentity(prev, identity));
      }

      // Telemetry capture: same funnel, independent of the GPS parser below, so
      // every packet type (device / environment / link / nodeinfo / ...) is kept.
      const samples = parseTelemetryLine(clean);
      if (samples.length > 0) {
        setTelemetrySamples((prev) => {
          const next = [...prev, ...samples];
          return next.length > TELEMETRY_SAMPLE_CAP ? next.slice(-TELEMETRY_SAMPLE_CAP) : next;
        });

        // Outputs (OSC + MIDI) are dispatched from the same place samples are
        // appended. Everything inside `ingestOutputs` is synchronous: OSC work is
        // appended to a throttled in-memory queue and MIDI bytes are written
        // fire-and-forget, so the serial read loop never awaits.
        const merged = [...telemetryRef.current, ...samples];
        const capped =
          merged.length > TELEMETRY_SAMPLE_CAP ? merged.slice(-TELEMETRY_SAMPLE_CAP) : merged;
        telemetryRef.current = capped;
        try {
          ingestOutputs(samples, summariseTelemetry(capped, 240));
        } catch {
          /* an output failure must never break the serial funnel */
        }
      }

      const parsed = parseSerialStreamLine(clean);
      if (parsed) {
        logSerial(
          `✓ Parsed ${parsed.source}: [Lat ${parsed.latitude.toFixed(6)}, Lon ${parsed.longitude.toFixed(6)}${
            parsed.altitude != null ? `, Alt ${parsed.altitude}m` : ''
          }]`
        );
        // The firmware logs one position as both POSITION and updatePosition,
        // and the phone API can deliver the same packet again as a frame, so
        // appending is de-duplicated (see utils/devicePoints.ts).
        setPoints((prev) => appendPoints(prev, [parsed]));
      }
    },
    [logSerial]
  );

  // Update simulation route base when selected
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
      const step = simStepRef.current;
      simStepRef.current += 1;

      // Realistic walk path
      const heading = (step * 25) % 360;
      const distDeg = 0.0003 + 0.00008 * Math.sin(step * 0.3);
      const newLat = simCoordsRef.current.lat + distDeg * Math.cos((heading * Math.PI) / 180);
      const newLon = simCoordsRef.current.lon + distDeg * Math.sin((heading * Math.PI) / 180);
      const newAlt = simCoordsRef.current.alt + 0.8 * Math.sin(step * 0.5);

      simCoordsRef.current = { lat: newLat, lon: newLon, alt: newAlt };

      // Alternate between Meshtastic JSON and NMEA GPGGA
      if (step % 2 === 0) {
        const jsonPayload = {
          from: '!28a9df12',
          type: 'position',
          payload: {
            latitude_i: Math.round(newLat * 1e7),
            longitude_i: Math.round(newLon * 1e7),
            altitude: Number(newAlt.toFixed(1)),
            time: Math.floor(Date.now() / 1000),
          },
        };
        processIncomingLine(JSON.stringify(jsonPayload));
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

      // Interleave non-position telemetry (~1 in 3 ticks) so the Telemetry tab
      // fills up without hardware. Values drift with the tick counter.
      if (step % 3 === 0) {
        const drift = simTelemetryRef.current;
        drift.uptime += 10;
        drift.battery = Math.max(20, drift.battery - 0.02);

        const epoch = Math.floor(Date.now() / 1000);
        const ambient = 21.4 + 1.2 * Math.sin(step / 9);
        const secondNode = (step & 4) === 0; // occasionally the mesh neighbour

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

        // Firmware link-quality log line (rxSNR / rxRSSI + hop counters).
        // Deliberately mirrors real firmware output: UNQUOTED key=value pairs.
        // Keep it that way — this shape is what catches key=value parsing bugs.
        if (step % 9 === 0) {
          const snr = (6.25 + 1.5 * Math.sin(step / 4)).toFixed(2);
          const rssi = Math.round(-69 - 4 * Math.sin(step / 6));
          processIncomingLine(
            `INFO  | 11:36:30 67 [Router] Lora RX (node=!28a9df12 Ch=0x41 len=93 rxSNR=${snr} rxRSSI=${rssi} hopStart=3 hopLimit=3)`
          );
        }

        // Mesh node info (longName / shortName), occasionally.
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

  /**
   * "+ Scan Hardware": opens the browser's port picker (the only way a page can
   * see ports it has not been granted yet) and then rebuilds the list so the new
   * device, the previously authorized ones and the bridge's system scan all show
   * together.
   */
  const handleScanNewPort = async () => {
    // Always re-read the bridge's system list, even without Web Serial.
    await refreshSerialPortInventory({ announce: true });

    if (!hasWebSerial) {
      logSerial(
        'Web Serial is unavailable in this browser (use Chromium). The list above shows the ports this PC reports via the local bridge.'
      );
      return;
    }

    try {
      logSerial('Opening the browser port picker — choose your node from the list...');
      const port = await (navigator as any).serial.requestPort();
      const info = port.getInfo ? port.getInfo() : {};
      const newPortId = `web-serial-${Date.now()}`;
      const { label, description } = getUsbDeviceLabel(info, availablePorts.length);

      const newPortItem: AvailablePort = {
        id: newPortId,
        label,
        category: 'Authorized devices (Web Serial)',
        description,
        isWebSerial: true,
        portRef: port,
      };

      setAvailablePorts((prev) => [newPortItem, ...prev]);
      setSettings((prev) => ({ ...prev, port: newPortId }));
      logSerial(`Added and selected ${label}`);
    } catch (err: any) {
      if (err.name !== 'NotFoundError') {
        logSerial(`Port scan error: ${err.message}`);
      } else {
        logSerial('Port picker closed without choosing a device.');
      }
    }
  };

  /**
   * Fully releases the Web Serial port.
   *
   * Order matters: the reader has to be cancelled AND the `pipeTo` promise has
   * to settle before `port.close()`. While that pipe holds the port's readable
   * the stream stays locked, `close()` rejects, and the port is left open — the
   * next connect then fails with "The port is already open".
   *
   * @param notice optional line to append to the serial log.
   */
  const releaseSerialPort = useCallback(
    async (notice: string) => {
      isReadingRef.current = false;

      // Ordering (cancel → await pipe → close) is enforced by the helper and
      // covered by serialSession.test.ts; getting it wrong is what produced
      // "The port is already open" on the next connect.
      const outcome = await releaseSerialSession({
        reader: serialReaderRef.current,
        // We read raw bytes (no TextDecoderStream pipe), so there is no pipe to
        // await — the helper still supports one for safety.
        pipe: null,
        port: serialPortRef.current,
      });

      serialReaderRef.current = null;
      if (outcome.closed) serialPortRef.current = null;
      if (outcome.error) logSerial(`Could not close the serial port: ${outcome.error}`);

      if (notice) logSerial(notice);
    },
    [logSerial]
  );

  /**
   * Writes a `ToRadio{want_config_id}` request so the device streams its node
   * database (every node's long/short name) back over the same port. The reply
   * is picked up by the frame scanner in the read loop.
   *
   * Best-effort by design: an unpaired/older firmware may not answer, in which
   * case node labels simply stay as addresses.
   */
  const requestNodeDatabase = useCallback(async (): Promise<boolean> => {
    const port = serialPortRef.current;
    if (!port?.writable) return false;

    let acquired: { write(data: Uint8Array): Promise<void>; releaseLock(): void };
    try {
      acquired = port.writable.getWriter();
    } catch {
      return false; // a writer is still held elsewhere — nothing to do
    }
    const writer = acquired;

    try {
      await writer.write(encodeWantConfigRequest());
      logSerial('Requested the node database from the device (names for all known nodes).');
      return true;
    } catch (err: any) {
      logSerial(`Could not request the node database: ${err?.message ?? err}`);
      return false;
    } finally {
      try {
        writer.releaseLock();
      } catch {
        /* already released */
      }
    }
  }, [logSerial]);

  // Real Web Serial API Connection
  const handleConnectSerial = async () => {
    const selectedPortObj = availablePorts.find((p) => p.id === settings.port);

    if (!hasWebSerial) {
      logSerial(`Connecting to virtual port ${settings.port} at ${settings.baudRate} baud.`);
      handleStartSimulation();
      return;
    }

    try {
      setConnectionStatus('connecting');
      setStatusMessage('Opening serial connection...');

      let port = selectedPortObj?.portRef;

      // If user selected a port name (like /dev/ttyUSB0 or COM3) without an active portRef, request authorization
      if (!port) {
        logSerial(`Requesting USB authorization to connect to ${settings.port}...`);
        port = await (navigator as any).serial.requestPort();
      }

      // A previous session may have left the port open (e.g. a failed teardown).
      // Close it before opening again, otherwise open() throws "already open".
      if (port.readable || port.writable || serialPortRef.current) {
        logSerial('Port was still open — releasing it before connecting.');
        await releaseSerialPort('');
      }

      try {
        await port.open({ baudRate: settings.baudRate });
      } catch (openErr: any) {
        if (!/already open/i.test(String(openErr?.message ?? ''))) throw openErr;
        // Belt and braces: release whatever is holding it and retry exactly once.
        logSerial('Port reported as already open — releasing it and retrying once.');
        await releaseSerialPort('');
        await port.open({ baudRate: settings.baudRate });
      }

      serialPortRef.current = port;
      isReadingRef.current = true;
      setConnectionStatus('connected');
      setStatusMessage(`Connected to ${selectedPortObj?.label || settings.port} @ ${settings.baudRate} baud`);
      logSerial(`Connected to ${selectedPortObj?.label || settings.port} at ${settings.baudRate} baud.`);

      // Read the stream as RAW BYTES, not through a TextDecoderStream: the same
      // port carries the ASCII firmware log *and* 0x94C3-framed protobuf (the
      // device's node database). The scanner splits the two apart. Reading raw
      // also avoids `pipeTo`, which used to keep the port locked after a
      // disconnect and break reconnecting.
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

            // Last-known positions from the device's node database: these make
            // every remembered node appear on the map, flagged as stale so an
            // hours-old fix is never mistaken for a live one.
            if (lastKnownPositions.length > 0) {
              const remembered = lastKnownPositions.map((position) =>
                devicePositionToPoint(position, Date.now(), true)
              );
              setPoints((prev) => appendPoints(prev, remembered));
              // Counted, not logged per chunk: a 79-node database arrives as many
              // frames and would otherwise flood the serial log.
              lastKnownCountRef.current += remembered.length;
            }

            // GPS fixes that arrived only as API frames (no text log line).
            if (positions.length > 0) {
              const incoming = positions.map((position) => devicePositionToPoint(position));
              setPoints((prev) => appendPoints(prev, incoming));
              incoming.forEach((point) => {
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
                  // normaliseNodeId returns null for an unusable address.
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
          // releaseLock throws if the stream was already released/cancelled.
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }
      })();

      // Ask the device for its node database so remote nodes show real names
      // instead of addresses like `!4058f711`. Fire-and-forget: a device that
      // ignores the request simply leaves the names as they were.
      void requestNodeDatabase();
    } catch (err: any) {
      logSerial(`Serial port connection failed: ${err.message}`);
      setConnectionStatus('error');
      setStatusMessage(`Connection failed: ${err.message}`);
      // Do not leave a half-open port behind.
      await releaseSerialPort('');
    }
  };

  // Disconnect Web Serial
  const handleDisconnect = async () => {
    handleStopSimulation();
    await releaseSerialPort('Serial port closed.');
    setConnectionStatus('disconnected');
    setStatusMessage('Disconnected');
  };

  // REQUIREMENT: Clear Path button to purge logged coordinates and reset map
  const handleClearPath = () => {
    setPoints([]);
    simStepRef.current = 0;
    const route = SIMULATION_ROUTES[selectedRouteIndex];
    if (route) {
      simCoordsRef.current = { lat: route.baseLat, lon: route.baseLon, alt: route.baseAlt };
    }
    logSerial('Route coordinates cleared. Map reset.');
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current);
      }
      isReadingRef.current = false;
    };
  }, []);

  return (
    <PanelResetContext.Provider value={layoutResetNonce}>
      {/* `dark` forces one theme regardless of the host OS preference. */}
      <div className="dark flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans">
        {/* Left rail: serial controls (node list now lives on the map) */}
        {railHidden ? (
          <button
            type="button"
            onClick={() => setRailHidden(false)}
            aria-label="Show left panel"
            title="Show the left panel"
            className="shrink-0 w-7 h-full bg-slate-900 border-r border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
        <aside
          style={{ width: railWidth }}
          className="shrink-0 bg-slate-900 border-r border-slate-800 text-slate-200 flex flex-col h-full"
        >
          {/* Brand Header */}
          <div className="p-4 border-b border-slate-800 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-900/30">
                <Radio className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-bold text-base tracking-tight text-white">Mesh Map</h1>
                <p className="text-[11px] text-slate-400">Meshtastic Real-Time Tracker</p>
              </div>
              <button
                type="button"
                onClick={() => setRailHidden(true)}
                aria-label="Hide left panel"
                title="Hide the left panel (the node list stays on the map)"
                className="ml-auto p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Existing serial-connection controls */}
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

          {/* Rail Footer */}
          <div className="p-3 border-t border-slate-800 bg-slate-950/60 text-[11px] text-slate-400 flex items-center justify-between shrink-0 gap-2">
            <span className="truncate">Mesh Map v1.2</span>
            <button
              type="button"
              onClick={handleResetLayout}
              title="Dock, expand and reset every panel to its default size and position"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors shrink-0"
            >
              <LayoutGrid className="w-3 h-3" />
              <span>Reset layout</span>
            </button>
          </div>
        </aside>
        )}

        {/* Drag this edge to resize the left rail (hidden with the rail) */}
        {!railHidden && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left rail"
          title="Drag to resize the left rail · double-click to reset"
          onPointerDown={handleRailResizePointerDown}
          onPointerMove={handleRailResizePointerMove}
          onPointerUp={handleRailResizeEnd}
          onPointerCancel={handleRailResizeEnd}
          onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
          className={`w-1.5 shrink-0 cursor-col-resize transition-colors ${
            isRailResizing ? 'bg-blue-500' : 'bg-slate-800 hover:bg-blue-500/60'
          }`}
          style={{ touchAction: 'none' }}
        />
        )}

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-slate-950">
          {/* Top Bar strictly following 3-Zone Top Bar Contract */}
          <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
            {/* Zone 1: Single text element wordmark */}
            <div className="flex items-center gap-3">
              <span className="text-base font-bold tracking-tight text-slate-100 flex items-center gap-2">
                <Radio className="w-5 h-5 text-blue-600" />
                Mesh Map
              </span>
              <span className="hidden sm:inline-block text-xs text-slate-400 font-mono">
                v1.2 · Meshtastic GIS
              </span>
            </div>

            {/* Zone 2: Navigation Links / View Tabs */}
            <nav className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
              <button
                onClick={() => setActiveTab('map')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'map'
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Map className="w-3.5 h-3.5 text-blue-600" />
                <span>Live Map</span>
              </button>

              <button
                onClick={() => setActiveTab('terminal')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'terminal'
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Terminal className="w-3.5 h-3.5 text-emerald-600" />
                <span>Serial Monitor</span>
                {serialLogs.length > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('points')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'points'
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <List className="w-3.5 h-3.5 text-cyan-600" />
                <span>Points Log ({visiblePoints.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('telemetry')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'telemetry'
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Activity className="w-3.5 h-3.5 text-violet-600" />
                <span>Telemetry ({telemetrySamples.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('outputs')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'outputs'
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-amber-600" />
                <span>Outputs</span>
                {oscConfig.enabled && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="OSC output enabled" />
                )}
              </button>
            </nav>

            {/* Zone 3: Primary Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleResetLayout}
                title="Dock, expand and reset every panel to its default size and position"
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800 rounded-lg border border-transparent hover:border-slate-800 transition-colors"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Reset Layout</span>
              </button>

              <button
                onClick={handleClearPath}
                title="Purge all coordinates and reset map"
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 rounded-lg border border-transparent hover:border-rose-200 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Path</span>
              </button>
            </div>
          </header>

          {/* Workspace Body */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            {/* Top Telemetry Metrics (reflects the filtered set) */}
            <MetricsBar points={visiblePoints} totalCount={points.length} />

            {/* Active View Container */}
            {activeTab === 'map' && (
              <div className="space-y-4">
                <Panel
                  id="map-live"
                  title="Live Map"
                  icon={<Map className="w-3.5 h-3.5" />}
                  variant="light"
                  defaultWidth={960}
                  defaultHeight={720}
                  minWidth={380}
                  minHeight={320}
                  bodyClassName="p-0 overflow-hidden flex flex-col"
                  actions={
                    <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                      {visiblePoints.length}/{points.length} pkts
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

                {/* Bottom Quick Console Strip */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2">
                    <Panel
                      id="serial-monitor-map"
                      title="Serial Monitor"
                      icon={<Terminal className="w-3.5 h-3.5 text-emerald-600" />}
                      variant="light"
                      defaultWidth={720}
                      defaultHeight={420}
                      minWidth={320}
                      minHeight={220}
                      bodyClassName="p-0 overflow-hidden"
                    >
                      <SerialTerminal
                        logs={serialLogs}
                        onClearLogs={() => setSerialLogs([])}
                        onInjectLine={processIncomingLine}
                      />
                    </Panel>
                  </div>

                  <Panel
                    id="serial-protocol"
                    title="Meshtastic Serial Protocol"
                    icon={<Info className="w-3.5 h-3.5 text-blue-500" />}
                    variant="light"
                    defaultWidth={420}
                    defaultHeight={380}
                    minWidth={280}
                    minHeight={200}
                    bodyClassName="p-4"
                  >
                    <div className="text-xs flex flex-col gap-3">
                      <p className="text-slate-400 leading-relaxed">
                        This application continuously parses both <strong>Meshtastic JSON outputs</strong>{' '}
                        (scaled integer{' '}
                        <code className="font-mono text-[11px] text-slate-200">latitude_i / 1e7</code>) and
                        standard <strong>NMEA sentences</strong> (
                        <code className="font-mono text-[11px] text-slate-200">$GPGGA</code>,{' '}
                        <code className="font-mono text-[11px] text-slate-200">$GPRMC</code>).
                      </p>
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5 text-[11px]">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-400">Selected Port:</span>
                          <span className="font-mono font-medium text-slate-200 truncate max-w-[160px]">
                            {settings.port}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-400">Connection Mode:</span>
                          <span className="font-mono text-emerald-600 font-medium">
                            {connectionStatus === 'connected'
                              ? 'Web Serial USB (Live)'
                              : connectionStatus === 'simulated'
                              ? 'Simulation Stream'
                              : 'Serial Ready'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-400">Baud Rate:</span>
                          <span className="font-mono text-slate-200">{settings.baudRate} 8-N-1</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-400">Nodes in window:</span>
                          <span className="font-mono text-slate-200">{nodeSummaries.length}</span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-800 flex items-center justify-end">
                        <button
                          onClick={handleClearPath}
                          className="text-rose-600 hover:underline font-medium text-xs"
                        >
                          Clear Path
                        </button>
                      </div>
                    </div>
                  </Panel>
                </div>
              </div>
            )}

            {activeTab === 'terminal' && (
              <div className="space-y-4">
                <Panel
                  id="serial-monitor-tab"
                  title="Serial Monitor"
                  icon={<Terminal className="w-3.5 h-3.5 text-emerald-600" />}
                  variant="light"
                  defaultWidth={900}
                  defaultHeight={560}
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

                <Panel
                  id="serial-help"
                  title="Serial Stream & Packet Injection"
                  icon={<Info className="w-3.5 h-3.5 text-blue-500" />}
                  variant="light"
                  defaultWidth={640}
                  defaultHeight={220}
                  bodyClassName="p-4"
                >
                  <p className="text-xs text-slate-400">
                    You can paste any raw Meshtastic JSON or NMEA string into the input above and press{' '}
                    <strong>Inject</strong> to verify real-time coordinate parsing and plotting onto the map.
                  </p>
                </Panel>
              </div>
            )}

            {activeTab === 'points' && (
              <div className="space-y-4">
                <Panel
                  id="points-log"
                  title="Points Log"
                  icon={<List className="w-3.5 h-3.5 text-cyan-600" />}
                  variant="light"
                  defaultWidth={980}
                  defaultHeight={560}
                  minWidth={380}
                  minHeight={260}
                  bodyClassName="p-0 overflow-auto"
                  actions={
                    <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                      {visiblePoints.length}/{points.length} pkts
                    </span>
                  }
                >
                  <PointsTable points={visiblePoints} totalCount={points.length} />
                </Panel>
              </div>
            )}

            {activeTab === 'telemetry' && (
              <div className="space-y-4">
                <Panel
                  id="telemetry-dashboard"
                  title="Node Telemetry"
                  icon={<Activity className="w-3.5 h-3.5 text-violet-600" />}
                  variant="light"
                  defaultWidth={980}
                  defaultHeight={640}
                  minWidth={420}
                  minHeight={320}
                  bodyClassName="p-0 overflow-hidden"
                  actions={
                    <span
                      className="text-[10px] font-mono text-slate-400 whitespace-nowrap"
                      title="Samples retained in memory (newest 5000)"
                    >
                      {telemetrySamples.length} samples · newest 5000 kept
                    </span>
                  }
                >
                  <Suspense fallback={<TabLoading label="telemetry" />}>
                    <TelemetryPanel samples={telemetrySamples} />
                  </Suspense>
                </Panel>
              </div>
            )}

            {activeTab === 'outputs' && (
              <div className="space-y-4">
                <Panel
                  id="outputs-dashboard"
                  title="Outputs — OSC &amp; MIDI"
                  icon={<SlidersHorizontal className="w-3.5 h-3.5 text-amber-600" />}
                  variant="light"
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
                      nodeSummaries={outputNodeSummaries}
                      seenMetrics={seenMetrics}
                    />
                  </Suspense>
                </Panel>
              </div>
            )}
          </main>
        </div>
      </div>
    </PanelResetContext.Provider>
  );
}
