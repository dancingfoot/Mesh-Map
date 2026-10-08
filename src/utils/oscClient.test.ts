import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OSC_CONFIG,
  OSC_MAX_INTERVAL_MS,
  OSC_MAX_QUEUE,
  OSC_MAX_TIMEOUT_MS,
  OSC_MIN_INTERVAL_MS,
  OSC_MIN_QUEUE,
  OSC_MIN_TIMEOUT_MS,
  OscClient,
  buildNodeMessages,
  encodableArgs,
  isEncodableOscArg,
  loadOscConfig,
  metricAddress,
  normalisePrefix,
  packetAddress,
  positionAddress,
  sanitiseOscSegment,
  saveOscConfig,
  type OscClientConfig,
} from './oscClient';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

/** Node >= 18 ships a global fetch that `vi.stubGlobal` does not replace. */
function setFetch(fn: unknown) {
  Object.defineProperty(globalThis, 'fetch', { value: fn, configurable: true, writable: true });
}

/**
 * Calls made to one endpoint, ignoring the others: the client now also pushes
 * the UDP destination to the bridge, so a raw call count is not meaningful.
 */
function callsTo(fetchMock: { mock: { calls: unknown[][] } }, suffix: string) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(suffix));
}

function restoreFetch() {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
}

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
  return store;
}

const config = (over: Partial<OscClientConfig> = {}): OscClientConfig => ({ ...DEFAULT_OSC_CONFIG, enabled: true, ...over });

let client: OscClient | null = null;

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  client?.dispose();
  client = null;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  restoreFetch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('address building', () => {
  it('normalises the prefix to a single leading slash and no trailing one', () => {
    expect(normalisePrefix('mesh')).toBe('/mesh');
    expect(normalisePrefix('/mesh')).toBe('/mesh');
    expect(normalisePrefix('/mesh/')).toBe('/mesh');
    expect(normalisePrefix('//mesh//')).toBe('/mesh');
    expect(normalisePrefix('')).toBe('/mesh');
  });

  it('keeps the node identity but removes characters OSC forbids', () => {
    expect(sanitiseOscSegment('!a1d7631c')).toBe('!a1d7631c');
    for (const hostile of ['a b', 'a/b', 'a#b', 'a*b', 'a,b', 'a?b', 'a[b]', 'a{b}', 'a"b', "a'b", 'a\\b']) {
      const out = sanitiseOscSegment(hostile);
      expect(out).not.toMatch(/[\s#*,?[\]{}"'\\/]/);
    }
    expect(sanitiseOscSegment('   ')).toBe('unknown');
  });

  it('builds the documented /mesh/node/<id>/<metric> scheme', () => {
    expect(metricAddress('/mesh', '!a1d7631c', 'batteryLevel')).toBe('/mesh/node/!a1d7631c/batteryLevel');
    expect(positionAddress('/mesh', '!a1d7631c')).toBe('/mesh/node/!a1d7631c/position');
    expect(packetAddress('/mesh', '!a1d7631c')).toBe('/mesh/node/!a1d7631c/packet');
    expect(metricAddress('synth', '!a1d7631c', 'rx snr')).toBe('/synth/node/!a1d7631c/rx_snr');
  });
});

describe('argument filtering', () => {
  it('accepts only what OSC can encode', () => {
    expect(isEncodableOscArg(1)).toBe(true);
    expect(isEncodableOscArg('x')).toBe(true);
    expect(isEncodableOscArg(false)).toBe(true);
    expect(isEncodableOscArg(null)).toBe(false);
    expect(isEncodableOscArg(undefined)).toBe(false);
    expect(isEncodableOscArg({})).toBe(false);
    expect(isEncodableOscArg(Number.NaN)).toBe(false);
    expect(isEncodableOscArg(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('drops junk so one bad firmware field cannot break a batch', () => {
    const args = [87, 'SIM1', true, null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY];
    expect(encodableArgs(args)).toEqual([87, 'SIM1', true]);
  });
});

describe('message builders', () => {
  it('emits one address per metric plus a position and a packet event', () => {
    const messages = buildNodeMessages(
      '!a1d7631c',
      { batteryLevel: 87, voltage: 4.02, latitude_i: 37.7749, longitude_i: -122.4194, altitude: 42, longName: 'Relay' },
      '/mesh'
    );
    const byAddress = new Map(messages.map((m) => [m.address, m]));

    expect(byAddress.get('/mesh/node/!a1d7631c/batteryLevel')?.args).toEqual([87]);
    expect(byAddress.get('/mesh/node/!a1d7631c/longName')?.args).toEqual(['Relay']);
    expect(byAddress.has('/mesh/node/!a1d7631c/latitude_i')).toBe(false);
    expect(byAddress.get('/mesh/node/!a1d7631c/position')?.args).toEqual([37.7749, -122.4194, 42]);
    expect(byAddress.get('/mesh/node/!a1d7631c/packet')?.kind).toBe('packet');
    expect(messages.every((m) => m.address.startsWith('/mesh/node/!a1d7631c/'))).toBe(true);
  });

  it('skips metrics that cannot be encoded', () => {
    const messages = buildNodeMessages('!x', { good: 1, bad: { nested: true } }, '/mesh');
    expect(messages.map((m) => m.address)).toEqual(['/mesh/node/!x/good']);
  });

  it('produces no position message when there are no coordinates', () => {
    const messages = buildNodeMessages('!x', { batteryLevel: 10 }, '/mesh');
    expect(messages.some((m) => m.kind === 'position')).toBe(false);
  });
});

describe('config persistence', () => {
  it('clamps out-of-range values from storage', () => {
    installMemoryStorage({
      'meshmap:osc-config:v1': JSON.stringify({
        enabled: true,
        url: 'http://127.0.0.1:9000',
        prefix: 'mesh',
        intervalMs: 1,
        maxQueue: 999999,
        timeoutMs: 5,
      }),
    });
    const cfg = loadOscConfig();
    expect(cfg.intervalMs).toBe(OSC_MIN_INTERVAL_MS);
    expect(cfg.maxQueue).toBe(OSC_MAX_QUEUE);
    expect(cfg.timeoutMs).toBe(OSC_MIN_TIMEOUT_MS);
    expect(cfg.enabled).toBe(true);
  });

  it('falls back to defaults on malformed storage instead of throwing', () => {
    installMemoryStorage({ 'meshmap:osc-config:v1': '{"enabled": tru' });
    expect(loadOscConfig()).toEqual(DEFAULT_OSC_CONFIG);
  });

  it('round-trips through save/load', () => {
    const custom = config({ url: 'http://10.0.0.5:9100', prefix: '/synth', intervalMs: 120 });
    saveOscConfig(custom);
    const loaded = loadOscConfig();
    expect(loaded.url).toBe('http://10.0.0.5:9100');
    expect(loaded.prefix).toBe('/synth');
    expect(loaded.intervalMs).toBe(120);
  });
});

describe('OscClient transport', () => {
  it('POSTs a batch to <url>/osc and counts what the bridge confirms', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ sent: 2 }) }));
    setFetch(fetchMock);
    client = new OscClient(config({ url: 'http://127.0.0.1:9000' }));

    const result = await client.sendMessages([
      { address: '/mesh/node/!a/batteryLevel', args: [87] },
      { address: '/mesh/node/!a/voltage', args: [4.02] },
    ]);

    expect(result.sent).toBe(2);
    const oscCalls = callsTo(fetchMock, '/osc');
    expect(oscCalls).toHaveLength(1);
    const [url, init] = oscCalls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9000/osc');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toHaveLength(2);
    expect(client.getStats().sent).toBe(2);
    expect(client.getStats().failed).toBe(0);
  });

  it('queues nothing while disabled (queueMessages respects the flag)', async () => {
    const fetchMock = vi.fn();
    setFetch(fetchMock);
    client = new OscClient(config({ enabled: false }));
    client.queueMessages([{ address: '/mesh/node/!a/x', args: [1] }]);
    // The destination is still pushed to the bridge (that is configuration, not
    // sending), but no OSC message may leave while disabled.
    expect(callsTo(fetchMock, '/osc')).toHaveLength(0);
    expect(client.getStats().pending).toBe(0);
    expect(client.getStats().queued).toBe(0);
  });

  it('sendMessages is the explicit immediate path and ignores the throttle', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ sent: 1 }) }));
    setFetch(fetchMock);
    client = new OscClient(config({ enabled: false, intervalMs: OSC_MAX_INTERVAL_MS }));
    const result = await client.sendMessages([{ address: '/mesh/node/!a/x', args: [1] }]);
    expect(callsTo(fetchMock, '/osc')).toHaveLength(1);
    expect(result.sent).toBe(1);
  });

  it('records a failure instead of throwing when the bridge is down', async () => {
    setFetch(vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    client = new OscClient(config());
    const result = await client.sendMessages([{ address: '/mesh/node/!a/x', args: [1] }]);
    expect(result.sent).toBe(0);
    expect(client.getStats().failed).toBe(1);
    expect(client.getStats().lastError).toMatch(/ECONNREFUSED|failed|refused/i);
  });

  it('treats a non-2xx reply as a failure', async () => {
    setFetch(vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => JSON.stringify({ error: 'boom' }) })));
    client = new OscClient(config());
    const result = await client.sendMessages([{ address: '/mesh/node/!a/x', args: [1] }]);
    expect(result.sent).toBe(0);
    expect(client.getStats().failed).toBe(1);
  });

  it('drops the oldest messages past the queue cap', () => {
    client = new OscClient(config({ maxQueue: 10, intervalMs: OSC_MAX_INTERVAL_MS }));
    client.queueMessages(Array.from({ length: 14 }, (_, i) => ({ address: `/mesh/node/!a/m${i}`, args: [i] })));
    const stats = client.getStats();
    expect(stats.dropped).toBe(4);
    expect(stats.pending).toBe(10);
  });

  it('parses the bridge health payload', async () => {
    setFetch(vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true, sent: 12, oscTarget: '127.0.0.1:57120' }) })));
    client = new OscClient(config());
    const health = await client.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.oscTarget).toBe('127.0.0.1:57120');
  });

  it('reports health failure rather than throwing', async () => {
    setFetch(vi.fn(async () => Promise.reject(new Error('down'))));
    client = new OscClient(config());
    const health = await client.checkHealth();
    expect(health.ok).toBe(false);
    expect(typeof health.error).toBe('string');
  });

  it('clamps a config passed at runtime', () => {
    client = new OscClient(config({ intervalMs: 1, maxQueue: 1, timeoutMs: 1 }));
    const cfg = client.getConfig();
    expect(cfg.intervalMs).toBe(OSC_MIN_INTERVAL_MS);
    expect(cfg.maxQueue).toBe(OSC_MIN_QUEUE);
    expect(cfg.timeoutMs).toBe(OSC_MIN_TIMEOUT_MS);
    expect(OSC_MAX_TIMEOUT_MS).toBeGreaterThan(OSC_MIN_TIMEOUT_MS);
  });

  it('builds an addressable test message', () => {
    client = new OscClient(config({ prefix: '/mesh' }));
    const msg = client.buildTestMessage();
    expect(msg.address.startsWith('/mesh/')).toBe(true);
    expect(msg.args.length).toBeGreaterThan(0);
  });
});
