import React, { useMemo } from 'react';
import { ConnectionStatus, SerialSettings, AvailablePort } from '../types';
import { Panel } from './Panel';
import {
  Play,
  Square,
  Trash2,
  RefreshCw,
  Cpu,
  Layers,
  Sparkles,
  Usb,
} from 'lucide-react';

interface SidebarProps {
  settings: SerialSettings;
  onUpdateSettings: (newSettings: Partial<SerialSettings>) => void;
  status: ConnectionStatus;
  statusMessage: string;
  availablePorts?: AvailablePort[];
  onScanNewPort?: () => void;
  /** Asks the connected device for its node database (real node names). */
  onRequestNodeNames?: () => void;
  onConnectSerial: () => void;
  onDisconnect: () => void;
  onStartSimulation: () => void;
  onStopSimulation: () => void;
  onClearPath: () => void;
  selectedRouteIndex: number;
  onSelectRouteIndex: (idx: number) => void;
}

/**
 * Left-rail serial controls.
 *
 * Each section is its own {@link Panel}, so every group can be collapsed,
 * detached (floated + dragged), resized and reset independently. The rail
 * itself (width + scrolling) is owned by `App`.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  settings,
  onUpdateSettings,
  status,
  statusMessage,
  availablePorts = [],
  onScanNewPort,
  onRequestNodeNames,
  onConnectSerial,
  onDisconnect,
  onStartSimulation,
  onStopSimulation,
  onClearPath,
  selectedRouteIndex,
  onSelectRouteIndex,
}) => {
  /**
   * Ports grouped for the dropdown. Order matters: what the user actually has
   * (authorized devices, then devices the local bridge found on this machine)
   * comes before the generic name suggestions.
   */
  const portGroups = useMemo(() => {
    const order = ['Authorized devices (Web Serial)', 'On this system (bridge)'];
    const groups = new Map<string, AvailablePort[]>();
    for (const port of availablePorts) {
      const key = port.category || 'Other';
      const bucket = groups.get(key);
      if (bucket) bucket.push(port);
      else groups.set(key, [port]);
    }
    return [...groups.entries()].sort((a, b) => {
      const left = order.indexOf(a[0]);
      const right = order.indexOf(b[0]);
      return (left === -1 ? order.length : left) - (right === -1 ? order.length : right);
    });
  }, [availablePorts]);

  const isConnected = status === 'connected';
  const isSimulated = status === 'simulated';
  const isBusy = isConnected || isSimulated;

  const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  const simulationPresets = [
    { name: 'San Francisco Urban Walk', coords: '37.7749°N, 122.4194°W' },
    { name: 'Rocky Mountain Alpine Ridge', coords: '39.7392°N, 104.9903°W' },
    { name: 'Munich City Mesh Node', coords: '48.1371°N, 11.5754°E' },
  ];

  const statusBadge = (
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
  );

  return (
    <div className="space-y-3 text-xs">
      {/* Section 1: Serial Connection */}
      <Panel
        id="serial-connection"
        title="Serial Connection"
        icon={<Usb className="w-3.5 h-3.5" />}
        variant="dark"
        actions={statusBadge}
        defaultWidth={350}
        defaultHeight={440}
        bodyClassName="p-3 space-y-3"
      >
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] font-medium text-slate-300">Serial Port</label>
            <button
              type="button"
              onClick={onScanNewPort || onConnectSerial}
              disabled={isBusy}
              className="text-[10px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
              title="Authorize and detect new USB serial hardware"
            >
              <span>+ Scan Hardware</span>
            </button>
          </div>

          {onRequestNodeNames && (
            <button
              type="button"
              onClick={onRequestNodeNames}
              disabled={isBusy}
              title="Ask the connected node for its database of known nodes, so every node shows its real name instead of an address"
              className="mb-1 text-[10px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors disabled:opacity-50"
            >
              <span>⇅ Request node names</span>
            </button>
          )}

          <select
            value={settings.port}
            disabled={isBusy}
            onChange={(e) => onUpdateSettings({ port: e.target.value })}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60 font-mono"
          >
            {settings.port === '' && (
              <option value="">
                {availablePorts.length === 0 ? 'No device found…' : 'Select a port…'}
              </option>
            )}
            {portGroups.map(([group, ports]) => (
              <optgroup key={group} label={group}>
                {ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {/*
            A web page cannot enumerate the machine's serial ports: Web Serial only
            exposes devices the user has already granted, and the rest appear in
            Chrome's own dialog. So this list contains only real devices.
          */}
          <p className="mt-1 text-[10px] leading-snug text-slate-500">
            {availablePorts.length === 0 ? 'No devices yet — ' : 'Only real devices are listed. '}
            Press <span className="text-blue-400">+ Scan Hardware</span> to pick your device from the
            browser dialog
            {availablePorts.some((p) => p.category === 'On this system (bridge)')
              ? '.'
              : ', and run npm run bridge to also list the ports this PC reports.'}
          </p>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">Baud Rate</label>
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
      </Panel>

      {/* Section 2: Hardware Simulation Demo */}
      <Panel
        id="hardware-simulation"
        title="Hardware Simulation"
        icon={<Cpu className="w-3.5 h-3.5 text-purple-400" />}
        variant="dark"
        defaultWidth={350}
        defaultHeight={250}
        bodyClassName="p-3 space-y-3"
      >
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
      </Panel>

      {/* Section 3: Route Management */}
      <Panel
        id="route-management"
        title="Route Management"
        icon={<Layers className="w-3.5 h-3.5 text-emerald-400" />}
        variant="dark"
        defaultWidth={350}
        defaultHeight={180}
        bodyClassName="p-3 space-y-2"
      >
        {/* REQUIREMENT: Clear Path button to purge logged coordinates and reset map */}
        <button
          onClick={onClearPath}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/80 text-rose-200 font-semibold transition-colors shadow-sm"
        >
          <Trash2 className="w-4 h-4 text-rose-400" />
          <span>Clear Path</span>
        </button>
        <p className="text-[11px] text-slate-500 leading-tight">
          Purges all logged GPS coordinates and resets the map view.
        </p>
      </Panel>

      {/* Section 4: Display & Auto-Refresh */}
      <Panel
        id="display-refresh"
        title="Display & Auto-Refresh"
        icon={<RefreshCw className="w-3.5 h-3.5 text-cyan-400" />}
        variant="dark"
        defaultWidth={350}
        defaultHeight={220}
        bodyClassName="p-3 space-y-3"
      >
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
      </Panel>
    </div>
  );
};
