/**
 * Web MIDI output for the Mesh-Map dashboard.
 *
 * Sends telemetry to any OS MIDI destination — a DAW, a synth, an Arduino, or a
 * **QMidiNet / RTP-MIDI virtual port** (those appear in the port list exactly
 * like a hardware port; enable the QMidiNet driver/virtual port in the OS first
 * and it will show up here).
 *
 * Three entry points map telemetry onto MIDI:
 *
 *  1. **CC (control change)** — one rule per metric. The metric's real range is
 *     linearly scaled onto 0..127 using the rule's `min`/`max` and clamped.
 *  2. **14-bit CC** — a rule may set `resolution: '14bit'`; the bridge sends the
 *     standard MSB/LSB pair (CC `number` = MSB, CC `number + 1` = LSB, the
 *     `number` controller is the one you map in your synth). LSB values are
 *     quantised to 7 bits, so the pair carries 13-bit effective resolution. Only
 *     rules whose metric genuinely needs it (barometric pressure, uptime) use it.
 *  3. **Note events** — a `type: 'note'` rule fires note-on for each new value
 *     (position changes fire one note per packet, giving a musical "packet
 *     arrived" cue) and schedules a note-off after {@link NOTE_OFF_MS}. Velocity
 *     is derived from the rule's own range, so the altitude rule maps altitude to
 *     velocity and 0 clamps to silence rather than to a stuck note.
 *
 * Channels: `channelMode: 'fixed'` uses the rule's 1..16 `channel`;
 * `channelMode: 'perNode'` assigns channels by a **stable first-seen ordering**
 * of node ids (the order in which the dashboard first hears each node). A mesh
 * with more than 16 nodes wraps around modulo 16, i.e. node 17 shares channel 1
 * with node 1 — states the UI spells out, because two nodes on one channel is a
 * real musical limitation, not a bug.
 *
 * Nothing here throws: an unavailable API, a denied permission, a missing port
 * and a dead device all end up in {@link MidiStatus.message} for the UI.
 */

import type { NodeTelemetry, TelemetrySample, TelemetryValue } from './telemetry';

/** MIDI channel numbers are 1..16 in the UI and 0..15 on the wire. */
export const MIDI_CHANNELS = 16;

/** How long a note stays on before its automatic note-off (ms). */
export const NOTE_OFF_MS = 180;

/** `note` rules whose metrics are not position packets still fire for new values. */
export type MidiRuleType = 'cc' | 'note';
export type MidiChannelMode = 'perNode' | 'fixed';
export type MidiResolution = '7bit' | '14bit';

export interface MidiRule {
  /** Stable id for React keys and list edits. */
  id: string;
  /** Telemetry metric name, e.g. `batteryLevel`. */
  metric: string;
  type: MidiRuleType;
  /** CC number (`type: 'cc'`) or note number (`type: 'note'`), 0..127. */
  number: number;
  channelMode: MidiChannelMode;
  /** 1..16, used when `channelMode === 'fixed'`. */
  channel: number;
  /** Real-world value that maps to the bottom of the MIDI range. */
  min: number;
  /** Real-world value that maps to the top of the MIDI range. */
  max: number;
  /** `'linear'` is the only scale today; kept explicit so the UI can grow. */
  scale: 'linear';
  /** `'14bit'` emits an MSB/LSB CC pair (`number` + `number + 1`). */
  resolution: MidiResolution;
}

export interface MidiConfig {
  enabled: boolean;
  /** Selected `MIDIOutput.id`, or `''` for "first available". */
  portId: string;
  rules: MidiRule[];
}

export type MidiStatusCode =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'denied'
  | 'no-ports'
  | 'ready'
  | 'error';

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
  connection: string;
}

export interface MidiStatus {
  code: MidiStatusCode;
  /** Human sentence for the UI — never empty. */
  message: string;
  /** True once the API answered and at least one output exists. */
  available: boolean;
  ports: MidiPortInfo[];
  /** The port messages would go to right now (selected, else first). */
  activePortId: string | null;
  activePortName: string | null;
  /** nodeId → MIDI channel (1..16) for `channelMode: 'perNode'` rules. */
  channelMap: Record<string, number>;
  /** Notes currently sounding, awaiting their automatic note-off. */
  pendingNotes: number;
}

/**
 * Metrics the default mapping covers (dropdown order).
 * Rule ids are stable slugs (`default-<metric>`) so React keys and the stored
 * config survive a reload unchanged.
 */
export const DEFAULT_MAPPING: MidiRule[] = [
  { id: 'default-batteryLevel', metric: 'batteryLevel', type: 'cc', number: 20, channelMode: 'perNode', channel: 1, min: 0, max: 100, scale: 'linear', resolution: '7bit' },
  { id: 'default-voltage', metric: 'voltage', type: 'cc', number: 21, channelMode: 'perNode', channel: 1, min: 3, max: 4.3, scale: 'linear', resolution: '7bit' },
  { id: 'default-temperature', metric: 'temperature', type: 'cc', number: 22, channelMode: 'perNode', channel: 1, min: -10, max: 50, scale: 'linear', resolution: '7bit' },
  { id: 'default-relativeHumidity', metric: 'relativeHumidity', type: 'cc', number: 23, channelMode: 'perNode', channel: 1, min: 0, max: 100, scale: 'linear', resolution: '7bit' },
  { id: 'default-barometricPressure', metric: 'barometricPressure', type: 'cc', number: 24, channelMode: 'perNode', channel: 1, min: 950, max: 1050, scale: 'linear', resolution: '14bit' },
  { id: 'default-altitude', metric: 'altitude', type: 'note', number: 60, channelMode: 'perNode', channel: 1, min: 0, max: 3000, scale: 'linear', resolution: '7bit' },
  { id: 'default-sats', metric: 'sats', type: 'cc', number: 25, channelMode: 'perNode', channel: 1, min: 0, max: 24, scale: 'linear', resolution: '7bit' },
  { id: 'default-siv', metric: 'siv', type: 'cc', number: 25, channelMode: 'perNode', channel: 1, min: 0, max: 24, scale: 'linear', resolution: '7bit' },
  { id: 'default-rxSNR', metric: 'rxSNR', type: 'cc', number: 26, channelMode: 'perNode', channel: 1, min: -20, max: 12, scale: 'linear', resolution: '7bit' },
  { id: 'default-rxRSSI', metric: 'rxRSSI', type: 'cc', number: 27, channelMode: 'perNode', channel: 1, min: -130, max: -40, scale: 'linear', resolution: '7bit' },
  { id: 'default-channelUtilization', metric: 'channelUtilization', type: 'cc', number: 28, channelMode: 'perNode', channel: 1, min: 0, max: 100, scale: 'linear', resolution: '7bit' },
  { id: 'default-uptimeSeconds', metric: 'uptimeSeconds', type: 'cc', number: 29, channelMode: 'perNode', channel: 1, min: 0, max: 86400, scale: 'linear', resolution: '14bit' },
];

/** Mid-velocity fallback when a metric is missing (never a stuck/silent note). */
const DEFAULT_NOTE_VELOCITY = 64;

/** Minimal structural types for Web MIDI (the DOM lib in TS 7 has none). */
interface MidiIOPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  connection?: string;
  open?: () => Promise<unknown>;
  send?: (data: number[], timestamp?: number) => void;
}

interface MidiAccessLike {
  inputs: Map<string, MidiIOPortLike>;
  outputs: Map<string, MidiIOPortLike>;
  onstatechange: ((event: unknown) => void) | null;
}

interface MidiAccessOptions {
  sysex?: boolean;
  software?: boolean;
}

type MidiAccessRequester = (options?: MidiAccessOptions) => Promise<unknown>;

const STORAGE_KEY = 'meshmap:midi-config:v1';

// ---------------------------------------------------------------------------
// Pure helpers (exported for the UI preview and for tests)
// ---------------------------------------------------------------------------

/**
 * Scales a real value onto the MIDI 0..127 range, clamping at both ends.
 * A degenerate range (`max <= min`) sends 0 instead of dividing by zero.
 */
export function scaleToMidi(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  const normalised = (value - min) / (max - min);
  return Math.max(0, Math.min(127, Math.round(normalised * 127)));
}

/** Full 14-bit value (0..16383) for `resolution: '14bit'` rules. */
export function scaleToMidi14(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  const normalised = (value - min) / (max - min);
  return Math.max(0, Math.min(16383, Math.round(normalised * 16383)));
}

/** 14-bit pair: `[MSB, LSB]`, matching the standard CC MSB/LSB convention. */
export function to14BitPair(value: number): [number, number] {
  const clamped = Math.max(0, Math.min(16383, Math.round(value)));
  return [(clamped >> 7) & 0x7f, clamped & 0x7f];
}

/** The value a rule should read from a metric map, or `null` when absent/textual. */
export function numericMetric(
  metrics: Record<string, TelemetryValue | undefined>,
  metric: string
): number | null {
  const value = metrics[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Metrics covered by the default mapping plus every metric actually seen. */
export function availableMetrics(seen: Iterable<string>): string[] {
  const names = new Set<string>(DEFAULT_MAPPING.map((rule) => rule.metric));
  for (const name of seen) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

let ruleSeq = 0;
/** Fresh rule for the "Add rule" button. */
export function createRule(metric = 'batteryLevel'): MidiRule {
  ruleSeq += 1;
  return {
    id: `rule-${Date.now().toString(36)}-${ruleSeq.toString(36)}`,
    metric,
    type: 'cc',
    number: 30,
    channelMode: 'perNode',
    channel: 1,
    min: 0,
    max: 127,
    scale: 'linear',
    resolution: '7bit',
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function clampFloat(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Validates one stored rule; returns `null` for anything unusable. */
function sanitiseRule(raw: unknown, index: number): MidiRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.metric !== 'string' || value.metric.trim() === '') return null;
  const type: MidiRuleType = value.type === 'note' ? 'note' : 'cc';
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : `stored-${index}`,
    metric: value.metric.trim(),
    type,
    number: clampInt(value.number, 0, 127, type === 'note' ? 60 : 20),
    channelMode: value.channelMode === 'fixed' ? 'fixed' : 'perNode',
    channel: clampInt(value.channel, 1, MIDI_CHANNELS, 1),
    min: clampFloat(value.min, 0),
    max: clampFloat(value.max, 127),
    scale: 'linear',
    resolution: value.resolution === '14bit' ? '14bit' : '7bit',
  };
}

/** Reads the persisted MIDI config; malformed JSON or rules fall back safely. */
export function loadMidiConfig(): MidiConfig {
  const fallback: MidiConfig = { enabled: false, portId: '', rules: DEFAULT_MAPPING.map((r) => ({ ...r })) };
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const value = parsed as Record<string, unknown>;
    const rulesRaw = Array.isArray(value.rules) ? value.rules : [];
    const rules = rulesRaw
      .map((rule, index) => sanitiseRule(rule, index))
      .filter((rule): rule is MidiRule => rule !== null);
    return {
      enabled: value.enabled === true,
      portId: typeof value.portId === 'string' ? value.portId : '',
      rules: rules.length > 0 ? rules : fallback.rules,
    };
  } catch {
    return fallback;
  }
}

/** Persists the MIDI config (best-effort; storage may be disabled). */
export function saveMidiConfig(config: MidiConfig): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage disabled / quota exceeded — the session still works */
  }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface MidiRuntime {
  access: MidiAccessLike | null;
  outputs: MidiIOPortLike[];
  /** nodeId → channel, assigned in first-seen order and never reshuffled. */
  channelAssignment: Map<string, number>;
  noteTimers: Set<ReturnType<typeof setTimeout>>;
  error: string | null;
}

const runtime: MidiRuntime = {
  access: null,
  outputs: [],
  channelAssignment: new Map(),
  noteTimers: new Set(),
  error: null,
};

function setStatusError(message: string): void {
  runtime.error = message;
}

/** True when `navigator.requestMIDIAccess` exists (Chromium does; Safari does not). */
export function isWebMidiSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { requestMIDIAccess?: MidiAccessRequester }).requestMIDIAccess ===
      'function'
  );
}

function requestAccess(): Promise<unknown> {
  const requester = (navigator as Navigator & { requestMIDIAccess?: MidiAccessRequester })
    .requestMIDIAccess;
  if (!requester) return Promise.reject(new Error('Web MIDI is not available in this browser'));
  return requester.call(navigator, { sysex: false });
}

function hasMidiAccess(): boolean {
  return runtime.access !== null;
}

/**
 * Which MIDI channel a node uses.
 *
 * `perNode` assigns channels in **first-seen order** and keeps them for the
 * session (a channel change mid-performance would be worse than a shared one).
 * Past 16 nodes the assignment wraps modulo 16: node 17 shares channel 1.
 */
export function channelForNode(nodeId: string): number {
  const existing = runtime.channelAssignment.get(nodeId);
  if (existing !== undefined) return existing;
  const next = (runtime.channelAssignment.size % MIDI_CHANNELS) + 1;
  runtime.channelAssignment.set(nodeId, next);
  return next;
}

function channelForRule(rule: MidiRule, nodeId: string): number {
  if (rule.channelMode === 'fixed') return clampInt(rule.channel, 1, MIDI_CHANNELS, 1);
  return channelForNode(nodeId);
}

/** `/health`-style snapshot of the MIDI side for the UI. */
export function getStatus(config?: MidiConfig): MidiStatus {
  const solved = config ?? loadMidiConfig();

  if (!isWebMidiSupported()) {
    return {
      code: 'unsupported',
      message: 'Web MIDI not available in this browser — use Chromium (Chrome / Edge / Brave / Opera).',
      available: false,
      ports: [],
      activePortId: null,
      activePortName: null,
      channelMap: Object.fromEntries(runtime.channelAssignment),
      pendingNotes: runtime.noteTimers.size,
    };
  }

  const ports: MidiPortInfo[] = runtime.outputs.map((output) => ({
    id: output.id,
    name: output.name ?? '(unnamed port)',
    manufacturer: output.manufacturer ?? '',
    state: output.state ?? 'connected',
    connection: output.connection ?? 'closed',
  }));

  const active = resolveOutput(runtime.outputs, solved.portId);
  const channelMap = Object.fromEntries(runtime.channelAssignment);
  const pendingNotes = runtime.noteTimers.size;

  if (runtime.error) {
    return {
      code: 'error',
      message: runtime.error,
      available: false,
      ports,
      activePortId: active?.id ?? null,
      activePortName: active?.name ?? null,
      channelMap,
      pendingNotes,
    };
  }

  if (!hasMidiAccess()) {
    return {
      code: 'idle',
      message: 'MIDI not requested yet — press "Enable MIDI" or "Refresh ports".',
      available: false,
      ports,
      activePortId: null,
      activePortName: null,
      channelMap,
      pendingNotes,
    };
  }

  if (ports.length === 0) {
    return {
      code: 'no-ports',
      message:
        'No output ports found — create a virtual port (IAC Driver on macOS, loopMIDI on Windows, ' +
        'QMidiNet / RTP-MIDI over the network) and refresh.',
      available: false,
      ports,
      activePortId: null,
      activePortName: null,
      channelMap,
      pendingNotes,
    };
  }

  return {
    code: 'ready',
    message:
      active !== null
        ? `Ready · sending to "${active.name ?? active.id}"${
            runtime.outputs.length > 1 ? ` (${runtime.outputs.length} outputs available)` : ''
          }`
        : `${runtime.outputs.length} output(s) available`,
    available: active !== null,
    ports,
    activePortId: active?.id ?? null,
    activePortName: active?.name ?? null,
    channelMap,
    pendingNotes,
  };
}

/** Selected port, else the first one. */
function resolveOutput(outputs: MidiIOPortLike[], portId: string): MidiIOPortLike | null {
  if (outputs.length === 0) return null;
  const selected = outputs.find((output) => output.id === portId);
  return selected ?? outputs[0];
}

/**
 * Enumerates MIDI outputs.
 *
 * Safe to call repeatedly. Returns the same {@link MidiStatus} shape as
 * {@link getStatus}, so the UI can render one status line from either path.
 * Never throws: an unavailable API → `unsupported`, a denied permission →
 * `denied`, a missing port → `no-ports`.
 */
export async function requestPorts(config?: MidiConfig): Promise<MidiStatus> {
  if (!isWebMidiSupported()) {
    return getStatus(config);
  }

  try {
    const rawAccess = runtime.access ?? (await requestAccess());
    const access = rawAccess as MidiAccessLike;
    runtime.access = access;
    runtime.error = null;

    // Re-read the port map on every call: virtual ports appear/disappear while
    // the page is open (QMidiNet ports show up like any other OS MIDI port).
    runtime.outputs = [...access.outputs.values()];

    access.onstatechange = () => {
      if (!runtime.access) return;
      runtime.outputs = [...runtime.access.outputs.values()];
    };

    return getStatus(config);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    runtime.access = null;
    runtime.outputs = [];
    setStatusError(
      name === 'SecurityError' || /permission|denied|not allowed/i.test(message)
        ? 'MIDI permission denied — allow MIDI access for this site, then refresh ports.'
        : `Could not open Web MIDI: ${message}`
    );
    return getStatus(config);
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function sendRaw(output: MidiIOPortLike, bytes: number[]): boolean {
  if (typeof output.send !== 'function') return false;
  try {
    output.send(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 0..15 channel nibble from a 1..16 channel number. */
function mode0(channelIndex: number): number {
  return Math.max(0, Math.min(15, Math.round(channelIndex)));
}

/**
 * Converts a rule + real value into the raw MIDI bytes to send.
 * Exported so the mapping table can preview exactly what a node will emit.
 *
 *  - `cc` + `7bit`  → `[B0|ch, number, value]`
 *  - `cc` + `14bit` → `[B0|ch, number, MSB, B0|ch, number+1, LSB]` (standard pair)
 *  - `note`         → `[90|ch, note, velocity]`; MIDI 1.0 notes are 7-bit, so the
 *    resolution flag has no effect here (velocity is always 0..127).
 */
export function ruleToMidiBytes(rule: MidiRule, channel: number, value: number): number[] {
  const status = mode0(Math.round(channel) - 1);
  const number = clampInt(rule.number, 0, 127, 0);

  if (rule.type === 'note') {
    return [0x90 | status, number, noteVelocity(rule, value)];
  }

  if (rule.resolution === '14bit') {
    const [msb, lsb] = to14BitPair(scaleToMidi14(value, rule.min, rule.max));
    const lsbControl = Math.min(127, number + 1);
    return [0xb0 | status, number, msb, 0xb0 | status, lsbControl, lsb];
  }
  return [0xb0 | status, number, scaleToMidi(value, rule.min, rule.max)];
}

/**
 * Velocity for a note rule.
 *
 * `value === null` means the mapped metric was missing or non-numeric; the note
 * still fires at {@link DEFAULT_NOTE_VELOCITY} so a note rule can never silently
 * do nothing, and a real value at (or below) the rule's `min` is lifted to 1
 * rather than 0 — velocity 0 is a note-off, which would leave the matching
 * note-off timer as the only thing on the wire and no audible packet cue.
 */
function noteVelocity(rule: MidiRule, value: number | null): number {
  if (value === null) return DEFAULT_NOTE_VELOCITY;
  return Math.max(1, scaleToMidi(value, rule.min, rule.max));
}

function scheduleNoteOff(output: MidiIOPortLike, channelIndex: number, note: number): void {
  const timer = setTimeout(() => {
    runtime.noteTimers.delete(timer);
    sendRaw(output, [0x80 | mode0(channelIndex), clampInt(note, 0, 127, 0), 0]);
  }, NOTE_OFF_MS);
  runtime.noteTimers.add(timer);
}

export interface MidiSendOutcome {
  sent: number;
  skipped: string | null;
}

/**
 * Sends one node's latest values through the configured mapping.
 *
 * @param triggeredByPosition true for a fresh position packet: note rules fire
 *        even when the metric value itself did not change (a moving node keeps
 *        ticking), which is the "packet arrived" cue.
 */
function sendNode(
  node: NodeTelemetry,
  config: MidiConfig,
  triggeredByPosition = false
): MidiSendOutcome {
  const output = resolveOutput(runtime.outputs, config.portId);
  if (!output) return { sent: 0, skipped: 'no output port' };

  let sent = 0;
  const latest: Record<string, TelemetryValue | undefined> = node.latest;

  for (const rule of config.rules) {
    const value = numericMetric(latest, rule.metric);
    if (value === null) continue;
    const channel = channelForRule(rule, node.nodeId);

    if (rule.type === 'note') {
      if (!triggeredByPosition) continue; // notes are packet events, not levels
      const velocity = scaleToMidi(value, rule.min, rule.max);
      if (velocity <= 0) continue; // silent velocity would hang a synth's voice
      const channelIndex = channel - 1;
      const note = clampInt(rule.number, 0, 127, 60);
      if (sendRaw(output, [0x90 | mode0(channelIndex), note, velocity])) {
        sent += 1;
        scheduleNoteOff(output, channelIndex, note);
      }
      continue;
    }

    const bytes = ruleToMidiBytes(rule, channel, value);
    if (sendRaw(output, bytes)) sent += 1;
  }

  return { sent, skipped: null };
}

/**
 * Sends every node's latest telemetry.
 *
 * @param input `NodeTelemetry[]` (from `summariseTelemetry`) or raw
 *        `TelemetrySample[]` (rolled up here, which is what the serial funnel
 *        passes when it has not materialised a summary yet).
 * @param freshPositionNodeIds nodes that just produced a position packet — their
 *        note rules fire on this call.
 */
export function sendTelemetry(
  input: NodeTelemetry[] | TelemetrySample[],
  freshPositionNodeIds: Iterable<string> = []
): MidiSendOutcome {
  const config = loadMidiConfig();
  if (!config.enabled) return { sent: 0, skipped: 'MIDI output is disabled' };
  if (!runtime.access || runtime.outputs.length === 0) {
    return { sent: 0, skipped: getStatus(config).message };
  }

  const nodes = normaliseNodes(input);
  if (nodes.length === 0) return { sent: 0, skipped: 'no telemetry yet' };

  const fresh = new Set(freshPositionNodeIds);
  let sent = 0;
  for (const node of nodes) {
    sent += sendNode(node, config, fresh.has(node.nodeId) || fresh.has(node.nodeId.replace(/^!/, ''))).sent;
  }
  return { sent, skipped: null };
}

/** Calls `sendTelemetry` for one node's latest values (see the coordinator). */
export function sendNodeTelemetry(node: NodeTelemetry, freshPosition = false): MidiSendOutcome {
  const config = loadMidiConfig();
  if (!config.enabled) return { sent: 0, skipped: 'MIDI output is disabled' };
  if (!runtime.access || runtime.outputs.length === 0) {
    return { sent: 0, skipped: getStatus(config).message };
  }
  return sendNode(node, config, freshPosition);
}

/** Accepts either shape and always returns `NodeTelemetry[]`. */
function normaliseNodes(input: NodeTelemetry[] | TelemetrySample[]): NodeTelemetry[] {
  if (input.length === 0) return [];
  const first = input[0] as TelemetrySample & NodeTelemetry;
  if ('metrics' in first && 'receivedAt' in first && !('latest' in first)) {
    // Raw samples: roll them up with the shared summariser.
    // Imported lazily to keep this module's import graph flat.
    return summarise(input as TelemetrySample[]);
  }
  return input as NodeTelemetry[];
}

/**
 * Local, dependency-free roll-up used when raw samples are passed in.
 * Mirrors `summariseTelemetry` for the fields MIDI needs (latest + lastSeen).
 */
function summarise(samples: TelemetrySample[]): NodeTelemetry[] {
  const byNode = new Map<string, NodeTelemetry>();
  for (const sample of samples) {
    const key = sample.nodeId ?? 'local';
    let node = byNode.get(key);
    if (!node) {
      node = { nodeId: key, lastSeen: sample.receivedAt, sampleCount: 0, latest: {}, byKind: {}, series: {} };
      byNode.set(key, node);
    }
    node.sampleCount += 1;
    if (Date.parse(sample.receivedAt) >= Date.parse(node.lastSeen)) node.lastSeen = sample.receivedAt;
    for (const [metric, value] of Object.entries(sample.metrics)) node.latest[metric] = value;
  }
  return [...byNode.values()];
}

/**
 * Panic: all-notes-off + reset-all-controllers on every channel, and cancel the
 * pending automatic note-offs so nothing re-triggers after the user hit panic.
 */
export function panic(): MidiSendOutcome {
  for (const timer of runtime.noteTimers) clearTimeout(timer);
  runtime.noteTimers.clear();

  const config = loadMidiConfig();
  const output = resolveOutput(runtime.outputs, config.portId);
  if (!output) return { sent: 0, skipped: getStatus(config).message };

  let sent = 0;
  for (let channel = 0; channel < MIDI_CHANNELS; channel++) {
    if (sendRaw(output, [0xb0 | channel, 123, 0])) sent += 1; // All Notes Off
    if (sendRaw(output, [0xb0 | channel, 120, 0])) sent += 1; // All Sound Off
    if (sendRaw(output, [0xb0 | channel, 121, 0])) sent += 1; // Reset All Controllers
  }
  return { sent, skipped: null };
}

/** Applies a config: persists it and, when enabled, opens the API (idempotent). */
export async function configure(config: MidiConfig): Promise<MidiStatus> {
  saveMidiConfig(config);
  if (config.enabled && isWebMidiSupported() && !runtime.access) {
    return requestPorts(config);
  }
  return getStatus(config);
}

/** Opens the API without changing the persisted config (refresh button). */
export async function refreshPorts(config: MidiConfig): Promise<MidiStatus> {
  runtime.error = null;
  return requestPorts(config);
}

/** Test-only escape hatch: forget cached access/ports (not used by the UI). */
export function resetMidiRuntimeForTests(): void {
  for (const timer of runtime.noteTimers) clearTimeout(timer);
  runtime.noteTimers.clear();
  runtime.access = null;
  runtime.outputs = [];
  runtime.channelAssignment.clear();
  runtime.error = null;
}
