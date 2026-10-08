import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeTelemetry } from './telemetry';
import {
  DEFAULT_MAPPING,
  MIDI_CHANNELS,
  NOTE_OFF_MS,
  availableMetrics,
  channelForNode,
  createRule,
  isWebMidiSupported,
  loadMidiConfig,
  panic,
  requestPorts,
  resetMidiRuntimeForTests,
  ruleToMidiBytes,
  saveMidiConfig,
  scaleToMidi,
  scaleToMidi14,
  sendNodeTelemetry,
  to14BitPair,
  type MidiConfig,
  type MidiRule,
} from './midi';

/** A rule factory so each test states only what it is about. */
function rule(overrides: Partial<MidiRule> = {}): MidiRule {
  return {
    id: 'r1',
    metric: 'batteryLevel',
    type: 'cc',
    number: 74,
    channelMode: 'fixed',
    channel: 1,
    min: 0,
    max: 100,
    scale: 'linear',
    resolution: '7bit',
    ...overrides,
  };
}

function node(latest: Record<string, number | string | boolean>): NodeTelemetry {
  return { nodeId: '!a1d7631c', lastSeen: new Date().toISOString(), sampleCount: 1, latest, byKind: {}, series: {} };
}

/**
 * Installs a fake Web MIDI stack and returns the bytes the app sends.
 *
 * `vi.stubGlobal('navigator', …)` is not enough: Node >= 21 defines a built-in
 * `navigator` global, so the property is redefined directly and restored after.
 */
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

/** midi.ts persists through `window.localStorage`; node has neither. */
function installMemoryStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? String(store.get(k)) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true, writable: true });
  return { store, localStorage };
}

function restoreWindow() {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function restoreNavigator() {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
}

function installFakeMidi() {
  const sent: number[][] = [];
  const port = {
    id: 'p1',
    name: 'QMidiNet',
    manufacturer: 'QMidiNet',
    state: 'connected',
    connection: 'open',
    send: (bytes: number[]) => sent.push([...bytes]),
  };
  const access = {
    outputs: new Map([['p1', port]]),
    inputs: new Map(),
    onstatechange: null,
    sysexEnabled: false,
  };
  setNavigator({ requestMIDIAccess: async () => access });
  return { sent, port, access };
}

const config = (over: Partial<MidiConfig> = {}): MidiConfig => ({ enabled: true, portId: 'p1', rules: [], ...over });

beforeEach(() => {
  resetMidiRuntimeForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetMidiRuntimeForTests();
  restoreNavigator();
  restoreWindow();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('value scaling', () => {
  it('maps the configured range onto 0..127 and clamps', () => {
    expect(scaleToMidi(0, 0, 100)).toBe(0);
    expect(scaleToMidi(100, 0, 100)).toBe(127);
    expect(scaleToMidi(50, 0, 100)).toBe(64);
    expect(scaleToMidi(150, 0, 100)).toBe(127);
    expect(scaleToMidi(-20, 0, 100)).toBe(0);
  });

  it('survives a degenerate range without producing NaN', () => {
    for (const value of [5, -5, 0, 1e9]) {
      const out = scaleToMidi(value, 10, 10);
      expect(Number.isFinite(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(127);
    }
  });

  it('maps onto 14-bit and splits into MSB/LSB', () => {
    expect(scaleToMidi14(0, 0, 100)).toBe(0);
    expect(scaleToMidi14(100, 0, 100)).toBe(16383);
    expect(to14BitPair(0)).toEqual([0, 0]);
    expect(to14BitPair(127)).toEqual([0, 127]);
    expect(to14BitPair(128)).toEqual([1, 0]);
    expect(to14BitPair(16383)).toEqual([127, 127]);
  });
});

describe('ruleToMidiBytes', () => {
  it('emits a 7-bit CC on the right channel', () => {
    expect(ruleToMidiBytes(rule(), 1, 100)).toEqual([0xb0, 74, 127]);
    expect(ruleToMidiBytes(rule(), 16, 0)).toEqual([0xbf, 74, 0]);
  });

  it('emits a 14-bit CC pair on number and number+1', () => {
    const bytes = ruleToMidiBytes(rule({ resolution: '14bit', number: 20 }), 1, 100);
    expect(bytes).toEqual([0xb0, 20, 127, 0xb0, 21, 127]);
  });

  it('never writes the LSB past CC 127', () => {
    const bytes = ruleToMidiBytes(rule({ resolution: '14bit', number: 127 }), 1, 50);
    expect(bytes[4]).toBe(127);
  });

  it('clamps an out-of-range controller number', () => {
    expect(ruleToMidiBytes(rule({ number: 200 }), 1, 50)[1]).toBe(127);
    expect(ruleToMidiBytes(rule({ number: -5 }), 1, 50)[1]).toBe(0);
  });

  it('emits note-on for note rules', () => {
    const bytes = ruleToMidiBytes(rule({ type: 'note', number: 60 }), 1, 100);
    expect(bytes[0]).toBe(0x90);
    expect(bytes[1]).toBe(60);
    expect(bytes[2]).toBe(127);
  });

  /**
   * Regression: a missing metric used to fall through to velocity 0, which is a
   * note-OFF in MIDI — the "packet arrived" cue would be silent.
   */
  it('fires a missing metric at the fallback velocity, not 0', () => {
    const bytes = ruleToMidiBytes(rule({ type: 'note', number: 60 }), 1, null as unknown as number);
    expect(bytes[2]).toBe(64);
    expect(bytes[2]).toBeGreaterThan(0);
  });

  it('lifts a value at or below min to velocity 1, never 0', () => {
    expect(ruleToMidiBytes(rule({ type: 'note' }), 1, 0)[2]).toBe(1);
    expect(ruleToMidiBytes(rule({ type: 'note' }), 1, -50)[2]).toBe(1);
  });
});

describe('channel assignment', () => {
  it('is stable per node and stays inside the 16 channels', () => {
    const a = channelForNode('!a1d7631c');
    expect(channelForNode('!a1d7631c')).toBe(a);
    for (const id of ['!a1d7631c', '!28a9df12', '!deadbeef', 'unknown', '!00000001']) {
      const channel = channelForNode(id);
      expect(Number.isInteger(channel)).toBe(true);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(MIDI_CHANNELS);
    }
  });
});

describe('config helpers', () => {
  it('ships a non-empty default mapping with valid rules', () => {
    expect(DEFAULT_MAPPING.length).toBeGreaterThan(0);
    for (const r of DEFAULT_MAPPING) {
      expect(r.number).toBeGreaterThanOrEqual(0);
      expect(r.number).toBeLessThanOrEqual(127);
      expect(['cc', 'note']).toContain(r.type);
      expect(r.channel).toBeGreaterThanOrEqual(1);
      expect(r.channel).toBeLessThanOrEqual(16);
    }
  });

  it('createRule returns a usable rule and availableMetrics surfaces seen metrics', () => {
    const r = createRule('temperature');
    expect(r.metric).toBe('temperature');
    expect(r.number).toBeGreaterThanOrEqual(0);
    expect(availableMetrics(['batteryLevel', 'customField'])).toEqual(
      expect.arrayContaining(['batteryLevel', 'customField'])
    );
  });

  it('falls back to defaults when localStorage holds junk', () => {
    installMemoryStorage({ 'meshmap:midi-config:v1': '{"enabled": tru' });
    const cfg = loadMidiConfig();
    expect(typeof cfg.enabled).toBe('boolean');
    expect(Array.isArray(cfg.rules)).toBe(true);
  });

  it('reports Web MIDI as unsupported when the API is absent', () => {
    setNavigator({});
    expect(isWebMidiSupported()).toBe(false);
  });
});

describe('sending with a real (fake) MIDI port', () => {
  it('enumerates ports and reports the selected one', async () => {
    installFakeMidi();
    const status = await requestPorts(config());
    expect(status.available).toBe(true);
    expect(status.ports.map((p) => p.name)).toContain('QMidiNet');
    expect(status.message).toMatch(/QMidiNet/);
  });

  it('sends CC bytes for a telemetry metric', async () => {
    const { sent } = installFakeMidi();
    installMemoryStorage();
    saveMidiConfig(config({ rules: [rule({ metric: 'batteryLevel', number: 74 })] }));
    await requestPorts(config({ rules: [rule({ metric: 'batteryLevel', number: 74 })] }));
    const outcome = sendNodeTelemetry(node({ batteryLevel: 100 }), false);
    expect(outcome.skipped).toBeNull();
    expect(outcome.sent).toBeGreaterThan(0);
    expect(sent).toContainEqual([0xb0, 74, 127]);
  });

  it('sends nothing while disabled', () => {
    installFakeMidi();
    installMemoryStorage();
    saveMidiConfig(config({ enabled: false }));
    const outcome = sendNodeTelemetry(node({ batteryLevel: 50 }), false);
    expect(outcome.sent).toBe(0);
    expect(outcome.skipped).toMatch(/disabled/i);
  });

  it('fires note rules on a fresh position packet and schedules a note-off', async () => {
    const { sent } = installFakeMidi();
    installMemoryStorage();
    const rules = [rule({ type: 'note', number: 60, metric: 'altitude', min: 0, max: 100 })];
    saveMidiConfig(config({ rules }));
    await requestPorts(config({ rules }));
    sendNodeTelemetry(node({ altitude: 50 }), true);
    expect(sent.some((bytes) => bytes[0] === 0x90 && bytes[1] === 60)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, NOTE_OFF_MS + 80));
    expect(sent.some((bytes) => bytes[0] === 0x80 && bytes[1] === 60)).toBe(true);
  });

  it('panic resets every channel', async () => {
    const { sent } = installFakeMidi();
    installMemoryStorage();
    saveMidiConfig(config());
    await requestPorts(config());
    const outcome = panic();
    expect(outcome.sent).toBe(MIDI_CHANNELS * 3);
    expect(sent.filter((b) => b[1] === 123)).toHaveLength(MIDI_CHANNELS);
    expect(sent.filter((b) => b[1] === 120)).toHaveLength(MIDI_CHANNELS);
    expect(sent.filter((b) => b[1] === 121)).toHaveLength(MIDI_CHANNELS);
  });

  it('reports a skip instead of throwing when there is no port', async () => {
    setNavigator({ requestMIDIAccess: async () => ({ outputs: new Map(), inputs: new Map(), onstatechange: null }) });
    installMemoryStorage();
    saveMidiConfig(config());
    await requestPorts(config());
    const outcome = sendNodeTelemetry(node({ batteryLevel: 50 }), false);
    expect(outcome.sent).toBe(0);
    expect(typeof outcome.skipped).toBe('string');
  });
});
