import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TELEMETRY_KINDS,
  summariseTelemetry,
  telemetryToCsv,
  type NodeTelemetry,
  type TelemetryKind,
  type TelemetrySample,
  type TelemetryValue,
} from '../utils/telemetry';
import { assignNodeColors, formatRelativeTime } from '../utils/nodes';
import { TimeWindowSelector } from './TimeWindowSelector';
import { TelemetryMetricCard, type TelemetryPoint } from './TelemetryMetricCard';
import { Activity, Download, RadioTower } from 'lucide-react';

interface TelemetryPanelProps {
  /** Every captured sample, oldest first (App caps the array at 5000). */
  samples: TelemetrySample[];
}

/** JSON containers the telemetry module models — see `telemetry.ts`. */
const KIND_CONTAINERS: Partial<Record<TelemetryKind, string[]>> = {
  device: ['deviceMetrics'],
  power: ['powerMetrics'],
  environment: ['environmentMetrics'],
  airQuality: ['airQualityMetrics'],
  health: ['healthMetrics'],
  localStats: ['localStats'],
  position: ['positionMetrics'],
};

/** Human title + lucide icon tint for each kind card. */
const KIND_META: Record<TelemetryKind, { title: string; accent: string }> = {
  device: { title: 'Device metrics', accent: 'text-blue-600' },
  power: { title: 'Power metrics', accent: 'text-amber-600' },
  environment: { title: 'Environment metrics', accent: 'text-emerald-600' },
  airQuality: { title: 'Air quality metrics', accent: 'text-teal-600' },
  health: { title: 'Health metrics', accent: 'text-rose-600' },
  localStats: { title: 'Local stats', accent: 'text-indigo-600' },
  position: { title: 'Position', accent: 'text-cyan-600' },
  link: { title: 'Link / radio', accent: 'text-violet-600' },
  nodeinfo: { title: 'Node info', accent: 'text-pink-600' },
  network: { title: 'Network / mesh', accent: 'text-slate-400' },
  unknown: { title: 'Other fields', accent: 'text-slate-400' },
};

/** `local` is the bucket for lines with no node address (network-wide logs). */
const LOCAL_NODE_KEY = 'local';

function nodeLabel(nodeId: string): string {
  return nodeId === LOCAL_NODE_KEY ? 'local (no node id)' : nodeId;
}

/** Scopes samples to the selected time window. `null` = all samples. */
function filterSamplesByWindow(
  samples: TelemetrySample[],
  windowMs: number | null,
  now: number
): TelemetrySample[] {
  if (windowMs === null) return samples;
  const cutoff = now - windowMs;
  return samples.filter((sample) => {
    const time = Date.parse(sample.receivedAt);
    if (!Number.isFinite(time)) return true;
    return time >= cutoff;
  });
}

/** Sample count per node (used for the selector, including windowed-out nodes). */
function countByNode(samples: TelemetrySample[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.nodeId ?? LOCAL_NODE_KEY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Per-kind, per-metric display data. */
interface KindGroup {
  kind: TelemetryKind;
  metrics: Array<{ name: string; value: TelemetryValue | undefined }>;
}

/**
 * Groups a node's metrics into one card per telemetry kind that actually has
 * data, plus an always-present "Other fields" card for metrics no modelled
 * container covers (unknown samples, raw firmware logs, new firmware fields).
 */
function buildKindGroups(node: NodeTelemetry | null): KindGroup[] {
  if (!node) return [];

  const covered = new Set<string>();
  const groups: KindGroup[] = [];

  for (const kind of TELEMETRY_KINDS) {
    if (kind === 'unknown') continue;
    const containerMetrics = new Set(KIND_CONTAINERS[kind] ?? []);
    for (const name of Object.keys(node.series)) {
      if (containerMetrics.has(name)) covered.add(name);
    }
  }

  for (const kind of TELEMETRY_KINDS) {
    if (kind === 'unknown') continue;
    const values = node.byKind[kind];
    if (!values || Object.keys(values).length === 0) continue;
    groups.push({
      kind,
      metrics: Object.keys(values).map((name) => ({ name, value: values[name] })),
    });
  }

  // Anything not shown above: unknown-kind samples first, then metrics no
  // modelled container covers (e.g. firmware log fields like `sortMs`).
  const extras = new Map<string, TelemetryValue | undefined>();
  for (const [name, value] of Object.entries(node.byKind.unknown ?? {})) {
    extras.set(name, value);
  }
  for (const [name, value] of Object.entries(node.latest)) {
    if (!covered.has(name) && !extras.has(name)) extras.set(name, value);
  }

  groups.push({
    kind: 'unknown',
    metrics: [...extras.entries()].map(([name, value]) => ({ name, value })),
  });

  return groups;
}

/** Cuts a numeric history to the selected window. */
function windowHistory(
  points: TelemetryPoint[] | undefined,
  windowMs: number | null,
  now: number
): TelemetryPoint[] {
  if (!points || points.length === 0) return [];
  if (windowMs === null) return points;
  const cutoff = now - windowMs;
  return points.filter((point) => point.t >= cutoff);
}

/** Blob + temporary anchor download (no server round-trip). */
function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick so the download has started.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Per-node telemetry dashboard.
 *
 * Shows everything that arrived from the Meshtastic network, grouped per node
 * and per telemetry kind: latest value, unit and an inline SVG sparkline of the
 * recent history. Fields the telemetry module does not model still surface in
 * the "Other fields" card — nothing is hidden.
 */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({ samples }) => {
  // Independent from the map's window so the two views can be compared.
  const [timeWindowMs, setTimeWindowMs] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [now, setNow] = useState<number>(() => Date.now());

  // Keep "last seen" ages moving even while no packets arrive.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const windowedSamples = useMemo(
    () => filterSamplesByWindow(samples, timeWindowMs, now),
    [samples, timeWindowMs, now]
  );

  // `summariseTelemetry` is cheap (one pass) and keeps the roll-up single-sourced.
  const nodeSummaries = useMemo(() => summariseTelemetry(windowedSamples, 240), [windowedSamples]);

  // Colours come from the shared palette, so a node keeps the same colour as
  // the map trace and the Nodes panel.
  const colorByNode = useMemo(() => {
    const keys = new Set<string>();
    for (const sample of samples) keys.add(sample.nodeId ?? LOCAL_NODE_KEY);
    return assignNodeColors(keys);
  }, [samples]);

  const countsByNode = useMemo(() => countByNode(samples), [samples]);

  // Fall back to the most recently heard node whenever the current selection
  // disappears (e.g. windowing it out). A real mesh address is preferred over
  // the `local` bucket (network-wide log lines with no node field), but `local`
  // is still selectable and is used when it is all we have.
  const activeNodeId = useMemo(() => {
    if (selectedNodeId && nodeSummaries.some((node) => node.nodeId === selectedNodeId)) {
      return selectedNodeId;
    }
    const firstAddressed = nodeSummaries.find((node) => node.nodeId !== LOCAL_NODE_KEY);
    return firstAddressed?.nodeId ?? nodeSummaries[0]?.nodeId ?? '';
  }, [nodeSummaries, selectedNodeId]);

  const activeNode = useMemo(
    () => nodeSummaries.find((node) => node.nodeId === activeNodeId) ?? null,
    [nodeSummaries, activeNodeId]
  );

  const activeSamples = useMemo(
    () => windowedSamples.filter((sample) => (sample.nodeId ?? LOCAL_NODE_KEY) === activeNodeId),
    [windowedSamples, activeNodeId]
  );

  const newestSample = useMemo(() => {
    let newest: TelemetrySample | null = null;
    for (const sample of activeSamples) {
      if (!newest || Date.parse(sample.receivedAt) >= Date.parse(newest.receivedAt)) newest = sample;
    }
    return newest;
  }, [activeSamples]);

  const kindGroups = useMemo(() => buildKindGroups(activeNode), [activeNode]);

  const activeColor = activeNode
    ? colorByNode.get(activeNode.nodeId) ?? '#2563EB'
    : '#2563EB';

  const handleExportCsv = useCallback(() => {
    const rows = activeNodeId ? activeSamples : windowedSamples;
    if (rows.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const scope = activeNodeId ? activeNodeId.replace(/[^a-zA-Z0-9]/g, '') : 'all-nodes';
    downloadTextFile(`meshmap-telemetry-${scope}-${stamp}.csv`, telemetryToCsv(rows));
  }, [activeNodeId, activeSamples, windowedSamples]);

  const totalSamples = samples.length;
  const metricsShown = kindGroups.reduce((total, group) => total + group.metrics.length, 0);

  return (
    <div className="flex flex-col lg:flex-row min-h-0">
      {/* ------------------------------------------------------ node selector */}
      <aside className="lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-950/70 p-3 space-y-2 lg:max-h-[70vh] lg:overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wide">
            Nodes with telemetry
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-700 text-[10px] font-mono text-slate-400">
            {nodeSummaries.length}
          </span>
        </div>

        {nodeSummaries.length === 0 ? (
          <p className="text-[11px] text-slate-400 leading-snug py-3">
            No nodes in this time window. Widen the window or start the demo.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {nodeSummaries.map((node) => {
              const active = node.nodeId === activeNodeId;
              const color = colorByNode.get(node.nodeId) ?? '#64748B';
              const total = countsByNode.get(node.nodeId) ?? node.sampleCount;
              return (
                <li key={node.nodeId}>
                  <button
                    type="button"
                    onClick={() => setSelectedNodeId(node.nodeId)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-lg border px-2 py-1.5 transition-colors ${
                      active
                        ? 'border-blue-500 bg-slate-900 shadow-sm'
                        : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full shrink-0 border border-white"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[11px] font-semibold text-slate-200 truncate">
                        {nodeLabel(node.nodeId)}
                      </span>
                      <span className="ml-auto text-[10px] font-mono text-slate-400 shrink-0">
                        {node.sampleCount}
                        {total !== node.sampleCount ? `/${total}` : ''}
                      </span>
                    </div>
                    <div className="mt-1 pl-5 text-[10px] font-mono text-slate-400">
                      last seen {formatRelativeTime(Date.parse(node.lastSeen), now)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* ------------------------------------------------------- metrics area */}
      <div className="flex-1 min-w-0 p-3 space-y-3 lg:max-h-[70vh] lg:overflow-y-auto">
        {/* Toolbar: window filter + export */}
        <div className="flex flex-wrap items-center gap-2">
          <TimeWindowSelector value={timeWindowMs} onChange={setTimeWindowMs} />
          <span className="text-[10px] font-mono text-slate-400">
            {windowedSamples.length}/{totalSamples} samples
          </span>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={(activeNodeId ? activeSamples : windowedSamples).length === 0}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-900 text-[11px] font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors"
            title={
              activeNodeId
                ? `Download every field of ${activeNodeId} as CSV`
                : 'Download every captured sample as CSV'
            }
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>

        {totalSamples === 0 ? (
          <EmptyState
            title="No telemetry yet — connect a node or press Start Demo."
            hint="Device, environment, air-quality, link and node-info packets will appear here."
          />
        ) : nodeSummaries.length === 0 ? (
          <EmptyState
            title="No telemetry in this time window."
            hint="Pick a wider window (All) to see every captured sample."
          />
        ) : !activeNode ? (
          <EmptyState
            title="Select a node to inspect its telemetry."
            hint="The selector lists every node that has sent telemetry."
          />
        ) : (
          <>
            {/* Selected node summary */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
              <span className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full border border-white"
                  style={{ backgroundColor: activeColor }}
                  aria-hidden="true"
                />
                <span className="font-mono text-xs font-semibold text-slate-100">
                  {nodeLabel(activeNode.nodeId)}
                </span>
              </span>
              <span className="text-[11px] text-slate-400">
                {activeNode.sampleCount} sample{activeNode.sampleCount === 1 ? '' : 's'} in window
              </span>
              <span className="text-[11px] text-slate-400">
                {metricsShown} field{metricsShown === 1 ? '' : 's'}
              </span>
              <span className="text-[11px] text-slate-400">
                last seen {formatRelativeTime(Date.parse(activeNode.lastSeen), now)}
              </span>
              <span className="text-[11px] text-slate-400">
                source time{' '}
                {newestSample?.sourceTime
                  ? new Date(newestSample.sourceTime * 1000).toLocaleTimeString()
                  : 'not sent'}
              </span>
            </div>

            {/* One card per kind with data + the always-present Other fields card */}
            <div className="space-y-3">
              {kindGroups.map((group) => (
                <KindSection
                  key={group.kind}
                  group={group}
                  color={activeColor}
                  series={activeNode.series}
                  timeWindowMs={timeWindowMs}
                  now={now}
                />
              ))}
            </div>

            {/* Newest raw line for the node */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <Activity className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wide">
                  Newest raw line
                </span>
              </div>
              <pre className="text-[11px] font-mono text-slate-200 bg-slate-950 border border-slate-800 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                {newestSample?.raw ?? 'No raw line for this node in the current window.'}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

interface KindSectionProps {
  group: KindGroup;
  color: string;
  series: Record<string, TelemetryPoint[]>;
  timeWindowMs: number | null;
  now: number;
}

/** One collapsible-free card per telemetry kind. */
const KindSection: React.FC<KindSectionProps> = ({ group, color, series, timeWindowMs, now }) => {
  const meta = KIND_META[group.kind];
  return (
    <section className="rounded-xl border border-slate-800 overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-1.5 bg-slate-950 border-b border-slate-800">
        <span className={`text-xs font-semibold ${meta.accent}`}>{meta.title}</span>
        <span className="text-[10px] font-mono text-slate-400">{group.kind}</span>
        <span className="ml-auto text-[10px] font-mono text-slate-400">
          {group.metrics.length} field{group.metrics.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="p-2">
        {group.metrics.length === 0 ? (
          <p className="text-[11px] text-slate-400 px-1 py-1">
            {group.kind === 'unknown'
              ? 'Every field in this window is covered by the cards above.'
              : 'No fields.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {group.metrics.map((metric) => (
              <TelemetryMetricCard
                key={`${group.kind}:${metric.name}`}
                name={metric.name}
                value={metric.value}
                history={windowHistory(series[metric.name], timeWindowMs, now)}
                color={color}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

interface EmptyStateProps {
  title: string;
  hint: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ title, hint }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
    <RadioTower className="w-6 h-6 text-slate-400" />
    <p className="text-sm font-medium text-slate-300">{title}</p>
    <p className="text-[11px] text-slate-400 max-w-sm">{hint}</p>
  </div>
);
