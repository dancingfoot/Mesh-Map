import React from 'react';
import { ConnectionStatus, SerialSettings } from '../types';
import {
  Radio,
  Sliders,
  Play,
  Square,
  Trash2,
  RefreshCw,
  Cpu,
  Layers,
  Sparkles,
  Usb,
  Code,
} from 'lucide-react';

interface SidebarProps {
  settings: SerialSettings;
  onUpdateSettings: (newSettings: Partial<SerialSettings>) => void;
  status: ConnectionStatus;
  statusMessage: string;
  onConnectSerial: () => void;
  onDisconnect: () => void;
  onStartSimulation: () => void;
  onStopSimulation: () => void;
  onClearPath: () => void;
  onOpenPythonCode: () => void;
  hasWebSerial: boolean;
  selectedRouteIndex: number;
  onSelectRouteIndex: (idx: number) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  settings,
  onUpdateSettings,
  status,
  statusMessage,
  onConnectSerial,
  onDisconnect,
  onStartSimulation,
  onStopSimulation,
  onClearPath,
  onOpenPythonCode,
  hasWebSerial,
  selectedRouteIndex,
  onSelectRouteIndex,
}) => {
  const isConnected = status === 'connected';
  const isSimulated = status === 'simulated';
  const isBusy = isConnected || isSimulated;

  const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  const simulationPresets = [
    { name: 'San Francisco Urban Walk', coords: '37.7749°N, 122.4194°W' },
    { name: 'Rocky Mountain Alpine Ridge', coords: '39.7392°N, 104.9903°W' },
    { name: 'Munich City Mesh Node', coords: '48.1371°N, 11.5754°E' },
  ];

  return (
    <aside className="w-80 shrink-0 bg-slate-900 border-r border-slate-800 text-slate-200 flex flex-col h-full overflow-y-auto">
      {/* Brand Header */}
      <div className="p-5 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-900/30">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-bold text-base tracking-tight text-white">Mesh Map</h1>
              <p className="text-[11px] text-slate-400">Meshtastic Real-Time Tracker</p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-6 flex-1 text-xs">
        {/* Section 1: Serial Connection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Usb className="w-3.5 h-3.5 text-blue-400" />
              Serial Connection
            </h2>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                isConnected
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  : isSimulated
                  ? 'bg-amber-950 text-amber-300 border border-amber-800'
                  : 'bg-slate-800 text-slate-400'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isConnected ? 'bg-emerald-400 animate-pulse' : isSimulated ? 'bg-amber-400 animate-pulse' : 'bg-slate-500'
                }`}
              />
              {status === 'connected' ? 'Hardware Active' : status === 'simulated' ? 'Demo Sim' : 'Offline'}
            </span>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-medium text-slate-300">
                Serial Port
              </label>
              <button
                type="button"
                onClick={onConnectSerial}
                disabled={isBusy}
                className="text-[10px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
                title="Authorize and detect new USB serial hardware"
              >
                <span>+ Scan Hardware</span>
              </button>
            </div>

            {/* REQUIREMENT: Dropdown with all ports available on system */}
            <select
              value={settings.port}
              disabled={isBusy}
              onChange={(e) => onUpdateSettings({ port: e.target.value })}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60 font-mono"
            >
              <optgroup label="Linux & Raspberry Pi">
                <option value="/dev/ttyUSB0">/dev/ttyUSB0 — Primary USB-UART (CH340/CP2102)</option>
                <option value="/dev/ttyACM0">/dev/ttyACM0 — Meshtastic ESP32-S3 / RP2040 CDC</option>
                <option value="/dev/ttyUSB1">/dev/ttyUSB1 — Secondary USB-Serial</option>
                <option value="/dev/ttyACM1">/dev/ttyACM1 — Secondary CDC Port</option>
                <option value="/dev/ttyAMA0">/dev/ttyAMA0 — Raspberry Pi GPIO UART</option>
              </optgroup>
              <optgroup label="Windows COM Ports">
                <option value="COM3">COM3 — Silicon Labs CP210x Bridge</option>
                <option value="COM4">COM4 — CH340 / Heltec / T-Beam</option>
                <option value="COM1">COM1 — Communications Port</option>
                <option value="COM2">COM2 — Communications Port</option>
                <option value="COM5">COM5 — RAK Wireless / nRF52</option>
                <option value="COM6">COM6 — USB Serial Device</option>
                <option value="COM7">COM7 — USB Serial Device</option>
              </optgroup>
              <optgroup label="macOS">
                <option value="/dev/cu.usbserial">/dev/cu.usbserial — macOS USB Serial</option>
                <option value="/dev/cu.usbmodem">/dev/cu.usbmodem — macOS USB Modem</option>
                <option value="/dev/cu.SLAB_USBtoUART">/dev/cu.SLAB_USBtoUART — Silicon Labs</option>
                <option value="/dev/cu.wchusbserial">/dev/cu.wchusbserial — WCH CH340</option>
              </optgroup>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              Baud Rate
            </label>
            <select
              value={settings.baudRate}
              disabled={isBusy}
              onChange={(e) => onUpdateSettings({ baudRate: Number(e.target.value) })}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60 font-mono"
            >
              {baudRates.map((b) => (
                <option key={b} value={b}>
                  {b} {b === 115200 ? '(Meshtastic Standard)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Connect / Disconnect Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={onConnectSerial}
              disabled={isBusy}
              className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-medium py-2 px-3 rounded-lg transition-colors"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Connect</span>
            </button>

            <button
              onClick={onDisconnect}
              disabled={!isBusy}
              className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/40 disabled:text-slate-600 text-slate-200 font-medium py-2 px-3 rounded-lg transition-colors"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Disconnect</span>
            </button>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-400 font-mono truncate">
            {statusMessage}
          </div>
        </div>

        {/* Section 2: Hardware Simulation Demo */}
        <div className="space-y-3 pt-3 border-t border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-purple-400" />
              Hardware Simulation
            </h2>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              Simulation Preset
            </label>
            <select
              value={selectedRouteIndex}
              disabled={isSimulated}
              onChange={(e) => onSelectRouteIndex(Number(e.target.value))}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
            >
              {simulationPresets.map((preset, idx) => (
                <option key={idx} value={idx}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onStartSimulation}
              disabled={isBusy}
              className="flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-medium py-2 px-3 rounded-lg transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Start Demo</span>
            </button>

            <button
              onClick={onStopSimulation}
              disabled={!isSimulated}
              className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/40 disabled:text-slate-600 text-slate-200 font-medium py-2 px-3 rounded-lg transition-colors"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Stop Demo</span>
            </button>
          </div>
        </div>

        {/* Section 3: Route Management */}
        <div className="space-y-3 pt-3 border-t border-slate-800">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            Route Management
          </h2>

          {/* REQUIREMENT: Clear Path button to purge logged coordinates and reset map */}
          <button
            onClick={onClearPath}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/80 text-rose-200 font-semibold transition-colors shadow-sm"
          >
            <Trash2 className="w-4 h-4 text-rose-400" />
            <span>Clear Path</span>
          </button>
          <p className="text-[11px] text-slate-500 leading-tight">
            Purges all logged GPS coordinates and resets the Folium map view.
          </p>
        </div>

        {/* Section 4: Display & Auto-Refresh */}
        <div className="space-y-3 pt-3 border-t border-slate-800">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
            Display & Auto-Refresh
          </h2>

          <div className="flex items-center justify-between">
            <span className="text-slate-300 font-medium">Auto-Refresh UI</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoRefresh}
              onClick={() => onUpdateSettings({ autoRefresh: !settings.autoRefresh })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                settings.autoRefresh ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  settings.autoRefresh ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Refresh Interval</span>
              <span className="font-mono text-white font-medium">{settings.refreshInterval}s</span>
            </div>
            <input
              type="range"
              min="1.0"
              max="5.0"
              step="0.5"
              value={settings.refreshInterval}
              onChange={(e) => onUpdateSettings({ refreshInterval: parseFloat(e.target.value) })}
              className="w-full accent-blue-600"
            />
          </div>
        </div>

        {/* Python Script Action Box */}
        <div className="pt-3 border-t border-slate-800">
          <button
            onClick={onOpenPythonCode}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-blue-950/40 hover:bg-blue-900/50 border border-blue-800/80 text-blue-200 font-semibold transition-colors"
          >
            <Code className="w-4 h-4 text-blue-400" />
            <span>View mesh_map.py</span>
          </button>
        </div>
      </div>

      {/* Sidebar Footer */}
      <div className="p-4 border-t border-slate-800 bg-slate-950/60 text-[11px] text-slate-500 flex items-center justify-between">
        <span>Mesh Map v1.2</span>
        <span>Python &amp; Streamlit</span>
      </div>
    </aside>
  );
};
