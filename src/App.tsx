import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GpsPoint, ConnectionStatus, SerialSettings, SimulationRoute, AvailablePort } from './types';
import { parseSerialStreamLine } from './utils/parser';
import { FoliumMap } from './components/FoliumMap';
import { MetricsBar } from './components/MetricsBar';
import { SerialTerminal } from './components/SerialTerminal';
import { PointsTable } from './components/PointsTable';
import { Sidebar } from './components/Sidebar';
import { PythonCodeModal } from './components/PythonCodeModal';
import { PYTHON_SCRIPT_CODE } from './data/pythonScript';
import {
  Radio,
  Map,
  Terminal,
  List,
  Code,
  Trash2,
  Info,
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

const DEFAULT_AVAILABLE_PORTS: AvailablePort[] = [
  {
    id: '/dev/ttyUSB0',
    label: '/dev/ttyUSB0 (Linux / Raspberry Pi USB Serial)',
    category: 'Linux & Raspberry Pi',
    description: 'Silicon Labs CP2102 / CH340 USB to UART Bridge',
  },
  {
    id: '/dev/ttyUSB1',
    label: '/dev/ttyUSB1 (Secondary USB Serial)',
    category: 'Linux & Raspberry Pi',
    description: 'Secondary USB Serial Node',
  },
  {
    id: '/dev/ttyACM0',
    label: '/dev/ttyACM0 (ESP32-S3 / Heltec V3 LoRa CDC)',
    category: 'Linux & Raspberry Pi',
    description: 'USB CDC ACM Interface',
  },
  {
    id: '/dev/ttyACM1',
    label: '/dev/ttyACM1 (Secondary CDC ACM)',
    category: 'Linux & Raspberry Pi',
    description: 'Secondary USB CDC ACM Interface',
  },
  {
    id: 'COM3',
    label: 'COM3 (Silicon Labs / Heltec V3)',
    category: 'Windows (COM Ports)',
    description: 'Silicon Labs CP210x USB to UART Bridge',
  },
  {
    id: 'COM4',
    label: 'COM4 (WCH CH340 / LilyGO T-Beam)',
    category: 'Windows (COM Ports)',
    description: 'USB-SERIAL CH340',
  },
  {
    id: 'COM5',
    label: 'COM5 (USB Serial Port)',
    category: 'Windows (COM Ports)',
    description: 'Generic USB Serial Port',
  },
  {
    id: 'COM1',
    label: 'COM1 (System Serial Port)',
    category: 'Windows (COM Ports)',
    description: 'Motherboard Standard COM Port',
  },
  {
    id: '/dev/cu.usbserial-0001',
    label: '/dev/cu.usbserial-0001 (macOS CP210x)',
    category: 'macOS (cu.usb*)',
    description: 'Silicon Labs CP2102 USB to UART Bridge',
  },
  {
    id: '/dev/cu.usbmodem14101',
    label: '/dev/cu.usbmodem14101 (macOS ESP32-S3 / Heltec)',
    category: 'macOS (cu.usb*)',
    description: 'USB CDC ACM modem driver',
  },
];

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
  const [activeTab, setActiveTab] = useState<'map' | 'terminal' | 'points'>('map');
  const [isPythonModalOpen, setIsPythonModalOpen] = useState(false);
  const [autoCenter, setAutoCenter] = useState(true);

  // Available Ports State
  const [availablePorts, setAvailablePorts] = useState<AvailablePort[]>(DEFAULT_AVAILABLE_PORTS);

  // Serial State
  const [settings, setSettings] = useState<SerialSettings>({
    port: '/dev/ttyUSB0',
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
  const simulationTimerRef = useRef<any>(null);
  const simStepRef = useRef<number>(0);
  const simCoordsRef = useRef<{ lat: number; lon: number; alt: number }>({
    lat: SIMULATION_ROUTES[0].baseLat,
    lon: SIMULATION_ROUTES[0].baseLon,
    alt: SIMULATION_ROUTES[0].baseAlt,
  });

  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  // Append a serial log
  const logSerial = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSerialLogs((prev) => {
      const next = [...prev, `[${timestamp}] ${msg}`];
      return next.length > 250 ? next.slice(-250) : next;
    });
  }, []);

  // Scan previously authorized ports on mount
  useEffect(() => {
    if (hasWebSerial) {
      (navigator as any).serial
        .getPorts()
        .then((ports: any[]) => {
          if (ports && ports.length > 0) {
            const detected: AvailablePort[] = ports.map((p, idx) => {
              const info = p.getInfo ? p.getInfo() : {};
              const { label, description } = getUsbDeviceLabel(info, idx);
              return {
                id: `web-serial-${idx}`,
                label,
                category: 'Detected USB Hardware',
                description,
                isWebSerial: true,
                portRef: p,
              };
            });
            setAvailablePorts([...detected, ...DEFAULT_AVAILABLE_PORTS]);
            setSettings((prev) => ({ ...prev, port: detected[0].id }));
            logSerial(`Detected ${detected.length} previously authorized USB serial device(s).`);
          }
        })
        .catch(() => {});
    }
  }, [hasWebSerial, logSerial]);

  // Process incoming raw line (from real Web Serial, simulator, or manual inject)
  const processIncomingLine = useCallback(
    (line: string) => {
      logSerial(`RX: ${line}`);
      const parsed = parseSerialStreamLine(line);
      if (parsed) {
        logSerial(
          `✓ Parsed ${parsed.source}: [Lat ${parsed.latitude.toFixed(6)}, Lon ${parsed.longitude.toFixed(6)}${
            parsed.altitude !== null ? `, Alt ${parsed.altitude}m` : ''
          }]`
        );
        setPoints((prev) => [...prev, parsed]);
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

  // Request & Scan New USB Device
  const handleScanNewPort = async () => {
    if (!hasWebSerial) {
      logSerial('Web Serial is only supported in Chromium-based browsers (Chrome, Edge, Opera, Brave). Re-enumerated standard OS serial ports.');
      return;
    }

    try {
      logSerial('Requesting user authorization for new USB Serial device...');
      const port = await (navigator as any).serial.requestPort();
      const info = port.getInfo ? port.getInfo() : {};
      const newPortId = `web-serial-${Date.now()}`;
      const { label, description } = getUsbDeviceLabel(info, availablePorts.length);

      const newPortItem: AvailablePort = {
        id: newPortId,
        label,
        category: 'Detected USB Hardware',
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
      }
    }
  };

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

      await port.open({ baudRate: settings.baudRate });

      serialPortRef.current = port;
      isReadingRef.current = true;
      setConnectionStatus('connected');
      setStatusMessage(`Connected to ${selectedPortObj?.label || settings.port} @ ${settings.baudRate} baud`);
      logSerial(`Connected to ${selectedPortObj?.label || settings.port} at ${settings.baudRate} baud.`);

      // Read serial stream loop
      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      serialReaderRef.current = reader;

      let buffer = '';
      (async () => {
        try {
          while (isReadingRef.current) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              buffer += value;
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (line.trim()) {
                  processIncomingLine(line);
                }
              }
            }
          }
        } catch (readErr: any) {
          logSerial(`Serial reader error: ${readErr.message}`);
        } finally {
          reader.releaseLock();
        }
      })();
    } catch (err: any) {
      logSerial(`Serial port connection failed: ${err.message}`);
      setConnectionStatus('error');
      setStatusMessage(`Connection failed: ${err.message}`);
    }
  };

  // Disconnect Web Serial
  const handleDisconnect = async () => {
    handleStopSimulation();

    isReadingRef.current = false;
    if (serialReaderRef.current) {
      try {
        await serialReaderRef.current.cancel();
      } catch {}
      serialReaderRef.current = null;
    }

    if (serialPortRef.current) {
      try {
        await serialPortRef.current.close();
      } catch {}
      serialPortRef.current = null;
    }

    setConnectionStatus('disconnected');
    setStatusMessage('Disconnected');
    logSerial('Serial port closed.');
  };

  // REQUIREMENT: Clear Path button to purge logged coordinates and reset map
  const handleClearPath = () => {
    setPoints([]);
    simStepRef.current = 0;
    const route = SIMULATION_ROUTES[selectedRouteIndex];
    if (route) {
      simCoordsRef.current = { lat: route.baseLat, lon: route.baseLon, alt: route.baseAlt };
    }
    logSerial('Route coordinates cleared. Folium map reset.');
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
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans">
      {/* Sidebar matching Streamlit Sidebar with Port Dropdown */}
      <Sidebar
        settings={settings}
        onUpdateSettings={(newVals) => setSettings((prev) => ({ ...prev, ...newVals }))}
        status={connectionStatus}
        statusMessage={statusMessage}
        availablePorts={availablePorts}
        onScanNewPort={handleScanNewPort}
        onConnectSerial={handleConnectSerial}
        onDisconnect={handleDisconnect}
        onStartSimulation={handleStartSimulation}
        onStopSimulation={handleStopSimulation}
        onClearPath={handleClearPath}
        onOpenPythonCode={() => setIsPythonModalOpen(true)}
        hasWebSerial={hasWebSerial}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRouteIndex={setSelectedRouteIndex}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-slate-50 dark:bg-slate-950">
        {/* Top Bar strictly following 3-Zone Top Bar Contract */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
          {/* Zone 1: Single text element wordmark */}
          <div className="flex items-center gap-3">
            <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
              <Radio className="w-5 h-5 text-blue-600" />
              Mesh Map
            </span>
            <span className="hidden sm:inline-block text-xs text-slate-500 font-mono">
              v1.2 · Meshtastic GIS
            </span>
          </div>

          {/* Zone 2: Navigation Links / View Tabs */}
          <nav className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('map')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'map'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Map className="w-3.5 h-3.5 text-blue-600" />
              <span>Live Map</span>
            </button>

            <button
              onClick={() => setActiveTab('terminal')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'terminal'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
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
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <List className="w-3.5 h-3.5 text-cyan-600" />
              <span>Points Log ({points.length})</span>
            </button>
          </nav>

          {/* Zone 3: Primary Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleClearPath}
              title="Purge all coordinates and reset map"
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg border border-transparent hover:border-rose-200 dark:hover:border-rose-800 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Path</span>
            </button>

            <button
              onClick={() => setIsPythonModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shadow-sm"
            >
              <Code className="w-3.5 h-3.5" />
              <span>mesh_map.py</span>
            </button>
          </div>
        </header>

        {/* Workspace Body */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {/* Top Telemetry Metrics */}
          <MetricsBar points={points} />

          {/* Active View Container */}
          {activeTab === 'map' && (
            <div className="space-y-4">
              <FoliumMap
                points={points}
                autoCenter={autoCenter}
                onToggleAutoCenter={() => setAutoCenter(!autoCenter)}
              />

              {/* Bottom Quick Console Strip */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2">
                  <SerialTerminal
                    logs={serialLogs}
                    onClearLogs={() => setSerialLogs([])}
                    onInjectLine={processIncomingLine}
                    connectionStatus={connectionStatus}
                  />
                </div>

                <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between text-xs">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-1.5 mb-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Meshtastic Serial Protocol
                    </h4>
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
                      This application continuously parses both <strong>Meshtastic JSON outputs</strong> (scaled integer <code className="font-mono text-[11px] text-slate-800 dark:text-slate-200">latitude_i / 1e7</code>) and standard <strong>NMEA sentences</strong> (<code className="font-mono text-[11px] text-slate-800 dark:text-slate-200">$GPGGA</code>, <code className="font-mono text-[11px] text-slate-800 dark:text-slate-200">$GPRMC</code>).
                    </p>
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Selected Port:</span>
                        <span className="font-mono font-medium text-slate-800 dark:text-slate-200 truncate max-w-[160px]">
                          {settings.port}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Connection Mode:</span>
                        <span className="font-mono text-emerald-600 dark:text-emerald-400 font-medium">
                          {connectionStatus === 'connected'
                            ? 'Web Serial USB (Live)'
                            : connectionStatus === 'simulated'
                            ? 'Simulation Stream'
                            : 'Serial Ready'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Baud Rate:</span>
                        <span className="font-mono text-slate-800 dark:text-slate-200">{settings.baudRate} 8-N-1</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <button
                      onClick={() => setIsPythonModalOpen(true)}
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium text-xs flex items-center gap-1"
                    >
                      <span>How to run with Streamlit CLI</span>
                      <span>→</span>
                    </button>
                    <button
                      onClick={handleClearPath}
                      className="text-rose-600 dark:text-rose-400 hover:underline font-medium text-xs"
                    >
                      Clear Path
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="space-y-4">
              <SerialTerminal
                logs={serialLogs}
                onClearLogs={() => setSerialLogs([])}
                onInjectLine={processIncomingLine}
                connectionStatus={connectionStatus}
              />
              <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
                <h4 className="font-semibold text-slate-900 dark:text-white mb-1">
                  Serial Stream &amp; Packet Injection
                </h4>
                <p>
                  You can paste any raw Meshtastic JSON or NMEA string into the input above and press <strong>Inject</strong> to verify real-time coordinate parsing and plotting onto the Folium map.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'points' && (
            <div className="space-y-4">
              <PointsTable points={points} />
            </div>
          )}
        </main>
      </div>

      {/* Python Code & Guide Modal */}
      <PythonCodeModal
        isOpen={isPythonModalOpen}
        onClose={() => setIsPythonModalOpen(false)}
        pythonCode={PYTHON_SCRIPT_CODE}
      />
    </div>
  );
}
