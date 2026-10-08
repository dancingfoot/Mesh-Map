/**
 * Output coordinator: the single place the serial read funnel hands telemetry to
 * the OSC bridge and to Web MIDI.
 *
 * `App.processIncomingLine` calls {@link ingestOutputs} **synchronously, with no
 * await**, right after it appends a telemetry sample. That keeps the outputs off
 * the read loop's critical path:
 *
 *  - OSC messages are queued in memory and flushed by `OscClient` at most once
 *    per `intervalMs` (default 50 ms), so a burst of packets is one HTTP request;
 *  - MIDI bytes are written straight to the port (Web MIDI `send` is
 *    fire-and-forget), and note-offs are scheduled on timers.
 *
 * Unchanged scalar values are suppressed (the firmware repeats `batteryLevel=87`
 * in every packet, which would otherwise flood the bridge), while position
 * packets always emit their `/packet` event.
 */

import { summariseTelemetry, type NodeTelemetry, type TelemetrySample } from './telemetry';
import {
  OscClient,
  buildPositionMessages,
  metricAddress,
  loadOscConfig,
  saveOscConfig,
  type OscClientConfig,
  type OscMessage,
} from './oscClient';
import {
  sendTelemetry as midiSendTelemetry,
  getStatus as midiGetStatus,
  isWebMidiSupported,
  loadMidiConfig,
  saveMidiConfig,
  type MidiConfig,
  type MidiStatus,
} from './midi';

/** One OSC client for the whole app (module singleton, like the panel layout). */
export const oscClient = new OscClient(loadOscConfig());

/** Applies and persists a new OSC config; returns the sanitised result. */
export function configureOsc(config: OscClientConfig): OscClientConfig {
  const applied = oscClient.configure(config);
  saveOscConfig(applied);
  return applied;
}

/** Applies and persists a new MIDI config (does not open the API — see `midi.configure`). */
export function configureMidiOutputs(config: MidiConfig): MidiConfig {
  saveMidiConfig(config);
  return config;
}

/** `GET /health` on the bridge, for the Outputs tab's health chip. */
export function checkOscHealth() {
  return oscClient.checkHealth();
}

/** Sends one `/mesh/test` message immediately (bypasses the throttle queue). */
export function sendOscTestMessage() {
  return oscClient.sendMessages([oscClient.buildTestMessage()]);
}

/** Live MIDI status for the UI. */
export function getMidiStatus(config?: MidiConfig): MidiStatus {
  return midiGetStatus(config);
}

export function isMidiSupported(): boolean {
  return isWebMidiSupported();
}

/**
 * `lastValue` memo: `${nodeId}\u0000${metric}` → last value sent.
 * Only DIFFERENT scalar values are re-sent, which is what keeps a stationary
 * node from re-emitting the same 12 metrics on every packet.
 */
const lastSentValue = new Map<string, number | string | boolean>();

/** Caps the memo so a long-running session with many transient nodes cannot grow. */
const LAST_VALUE_CAP = 4000;

/** Nodes that produced a position packet in the last {@link ingestOutputs} call. */
let lastFreshPositionNodes: string[] = [];

/** Node ids from the most recent ingest that carried a position sample. */
export function freshPositionNodeIds(): string[] {
  return [...lastFreshPositionNodes];
}

/**
 * Hands one batch of samples to every enabled output.
 *
 * @param samples       newest parsed samples (may be empty).
 * @param allSummaries  the caller's current per-node roll-up. When omitted, this
 *                      function rolls the samples up itself (used by tests and
 *                      by callers that do not already have a summary).
 * @returns a small report of what was dispatched (never throws).
 */
export function ingestOutputs(
  samples: TelemetrySample[],
  allSummaries?: NodeTelemetry[]
): { oscQueued: number; midiSent: number; midiSkipped: string | null } {
  const report: { oscQueued: number; midiSent: number; midiSkipped: string | null } = {
    oscQueued: 0,
    midiSent: 0,
    midiSkipped: null,
  };
  if (samples.length === 0) return report;

  const oscConfig = oscClient.getConfig();
  const midiConfig = loadMidiConfig();

  // Which nodes produced a position packet in this batch (note-on trigger).
  const fresh = new Set<string>();
  const touched = new Set<string>();
  for (const sample of samples) {
    if (!sample.nodeId) continue;
    touched.add(sample.nodeId);
    if (sample.kind === 'position' || hasLatLon(sample.metrics)) fresh.add(sample.nodeId);
  }
  lastFreshPositionNodes = [...fresh];

  if (oscConfig.enabled) {
    const messages: OscMessage[] = [];
    for (const sample of samples) {
      if (!sample.nodeId) continue;
      const prefix = oscConfig.prefix;

      // Every metric that changed ⇒ its own address.
      for (const [metric, value] of Object.entries(sample.metrics)) {
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        const key = `${sample.nodeId}\u0000${metric}`;
        if (lastSentValue.get(key) === value) continue;
        lastSentValue.set(key, value);
        messages.push({ address: metricAddress(prefix, sample.nodeId, metric), args: [value] });
      }

      // New position packet ⇒ /packet (+ /position when the fix is complete).
      if (fresh.has(sample.nodeId)) {
        messages.push(...buildPositionMessages(sample.nodeId, sample.metrics, prefix));
      }
    }

    if (messages.length > 0) {
      oscClient.queueMessages(messages);
      report.oscQueued = messages.length;
    }

    if (lastSentValue.size > LAST_VALUE_CAP) {
      // Drop the oldest half — Map preserves insertion order.
      let toDrop = lastSentValue.size - LAST_VALUE_CAP / 2;
      for (const key of lastSentValue.keys()) {
        if (toDrop-- <= 0) break;
        lastSentValue.delete(key);
      }
    }
  }

  if (midiConfig.enabled) {
    const summaries = allSummaries ?? summariseTelemetry(samples, 1);
    const affected = summaries.filter((node) => touched.has(node.nodeId));
    if (affected.length > 0) {
      const outcome = midiSendTelemetry(affected, fresh);
      report.midiSent = outcome.sent;
      report.midiSkipped = outcome.skipped;
    }
  }

  return report;
}

/** True when the metric map already carries a usable latitude/longitude fix. */
function hasLatLon(metrics: Record<string, unknown>): boolean {
  const has = (names: string[]) =>
    names.some((name) => typeof metrics[name] === 'number' && Number.isFinite(metrics[name] as number));
  return (
    has(['latitude_i', 'latitudeI', 'lat', 'latitude']) &&
    has(['longitude_i', 'longitudeI', 'lon', 'longitude'])
  );
}

/** Test-only: forget the de-duplication memo. */
export function resetOutputDedupeForTests(): void {
  lastSentValue.clear();
  lastFreshPositionNodes = [];
}

export { summariseTelemetry };
