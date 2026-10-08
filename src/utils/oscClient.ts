/**
 * Browser-side OSC client for the Mesh-Map dashboard.
 *
 * Browsers cannot open UDP sockets, so this module never talks OSC itself: it
 * POSTs JSON to the local bridge (`bridge/osc-bridge.mjs`), which encodes real
 * OSC 1.0 packets and forwards them over UDP to SuperCollider / TouchDesigner /
 * Max / Pd / anything else listening.
 *
 * Address scheme (see `bridge/README.md`):
 *
 *   /<prefix>/node/<nodeId>/<metric>    one message per metric value
 *   /<prefix>/node/<nodeId>/position    lat, lon, alt in one message
 *   /<prefix>/node/<nodeId>/packet      fired once per new position packet
 *
 * Node ids are used verbatim inside the address. Meshtastic ids are `!` + hex
 * (`!a1d7631c`); OSC addresses may not contain spaces or `#`, `*`, `,`, `?`,
 * `[`, `]`, `{`, `}` and must not contain `/` inside a segment. The leading `!`
 * is **kept** because the bridge's own README documents the id form with it and
 * receivers (`/mesh/node/!a1d7631c/*`) rely on it; only characters that are
 * illegal in an OSC address are stripped/replaced, so the mapping stays
 * round-trippable for every real hardware id.
 *
 * Design rules, because this code runs on the hot serial-read path:
 *  - `queue(...)` is synchronous and never awaits. It coalesces a burst of
 *    samples into **at most one HTTP request per `intervalMs`** (default 50 ms).
 *  - Every promise is terminated with a `.catch`; nothing can become an
 *    unhandled rejection and nothing throws into React.
 *  - Failures are counted and stored in {@link OscStats}, which the UI polls.
 */

/** One OSC message as the bridge's `POST /osc` expects it. */
export interface OscMessage {
  address: string;
  args: Array<number | string | boolean>;
}

/** What the bridge's `/health` endpoint reports (plus our reachability flag). */
export interface OscHealth {
  ok: boolean;
  sent: number | null;
  oscTarget: string | null;
  uptime: number | null;
  error: string | null;
}

export interface OscStats {
  /** Messages handed to the bridge successfully (counted at enqueue, see note). */
  queued: number;
  /** Messages confirmed by the bridge (`{"sent":N}` replies, summed). */
  sent: number;
  /** Messages dropped because the queue was full. */
  dropped: number;
  /** Requests that failed (bridge down, non-2xx, timeout, bad JSON). */
  failed: number;
  /** Messages currently waiting for the next flush. */
  pending: number;
  /** Messages waiting when the last flush started (peak coalescing size). */
  lastBatchSize: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export interface OscClientConfig {
  /** Master switch. When false nothing is queued or sent. */
  enabled: boolean;
  /** Bridge base URL, e.g. `http://127.0.0.1:9000`. */
  url: string;
  /** Address prefix, e.g. `/mesh`. Normalised to start with `/` and not end with one. */
  prefix: string;
  /**
   * Where the bridge sends UDP, e.g. `127.0.0.1`.
   *
   * The bridge owns the actual socket, so this is pushed to it via `POST /target`
   * — without it the only way to change the destination was a CLI flag on the
   * bridge, which is invisible from the dashboard.
   */
  targetHost: string;
  /** UDP destination port, e.g. `57120` (SuperCollider's default). */
  targetPort: number;
  /** Throttle: at most one HTTP request per this many ms (default 50). */
  intervalMs: number;
  /** Hard cap on queued messages; the oldest are dropped past this (default 600). */
  maxQueue: number;
  /** Per-request timeout in ms (default 2500). */
  timeoutMs: number;
}

export const DEFAULT_OSC_CONFIG: OscClientConfig = {
  enabled: false,
  url: 'http://127.0.0.1:9000',
  prefix: '/mesh',
  targetHost: '127.0.0.1',
  targetPort: 57120,
  intervalMs: 50,
  maxQueue: 600,
  timeoutMs: 2500,
};

/** Interval bounds accepted from the UI (a burst must not become one request per sample). */
export const OSC_MIN_INTERVAL_MS = 10;
export const OSC_MAX_INTERVAL_MS = 2000;
export const OSC_MIN_QUEUE = 10;
export const OSC_MAX_QUEUE = 5000;
export const OSC_MIN_TIMEOUT_MS = 200;
export const OSC_MAX_TIMEOUT_MS = 20_000;

const STORAGE_KEY = 'meshmap:osc-config:v1';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Host names and IP literals only; keeps control characters out of the bridge. */
const HOST_RE = /^[A-Za-z0-9._:\[\]-]{1,253}$/;

/** Cleans a destination host, falling back to the default when unusable. */
export function normaliseTargetHost(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_OSC_CONFIG.targetHost;
  const value = raw.trim();
  if (!HOST_RE.test(value) || value.includes('..')) return DEFAULT_OSC_CONFIG.targetHost;
  return value;
}

/** Cleans a destination port, falling back to the default when out of range. */
export function normaliseTargetPort(raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
    return DEFAULT_OSC_CONFIG.targetPort;
  }
  return value;
}

/** Normalises a prefix to `/name` (or `/`), never `//` and never trailing `/`. */
export function normalisePrefix(raw: string): string {
  let value = (raw ?? '').trim();
  if (value === '') return '/mesh';
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * Makes a node id safe as one OSC address segment.
 *
 * Keeps `!` and the hex digits (that is the identity Mesh-Map uses everywhere).
 * OSC forbids the pattern characters `# * , ? [ ] { }` and whitespace inside an
 * address, and `/` would split the segment, so each of those becomes `_`.
 */
export function sanitiseOscSegment(raw: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[\s#*,?[\]{}"'\\/]+/g, '_')
    .replace(/^\.+/, '_');
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * True when the value is something the bridge can encode.
 * `null`/`undefined`/objects/NaN/Infinity are not valid OSC args.
 */
export function isEncodableOscArg(value: unknown): value is number | string | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

/** Drops non-encodable args, so a weird firmware field cannot 400 the whole batch. */
export function encodableArgs(values: unknown[]): Array<number | string | boolean> {
  return values.filter(isEncodableOscArg);
}

/** `/mesh/node/!a1d7631c/battery` style address for one metric. */
export function metricAddress(prefix: string, nodeId: string, metric: string): string {
  return `${normalisePrefix(prefix)}/node/${sanitiseOscSegment(nodeId)}/${sanitiseOscSegment(metric)}`;
}

/** `/mesh/node/!a1d7631c/position` — lat/lon/alt in a single message. */
export function positionAddress(prefix: string, nodeId: string): string {
  return `${normalisePrefix(prefix)}/node/${sanitiseOscSegment(nodeId)}/position`;
}

/** `/mesh/node/!a1d7631c/packet` — the per-new-position-packet event. */
export function packetAddress(prefix: string, nodeId: string): string {
  return `${normalisePrefix(prefix)}/node/${sanitiseOscSegment(nodeId)}/packet`;
}

/** Metric names that belong to the combined `/position` message, not their own address. */
export const POSITION_METRICS: readonly string[] = [
  'latitude_i',
  'longitude_i',
  'latitudeI',
  'longitudeI',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'altitude',
  'altitudeMsl',
  'altitudeHae',
  'msl',
  'hae',
];

function isPositionMetric(metric: string): boolean {
  return POSITION_METRICS.includes(metric);
}

/** First present, finite numeric value among `names`. */
function firstNumber(latest: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = latest[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** The exact OSC addresses a node's current metrics produce (for the UI preview). */
export interface PreviewMessage {
  address: string;
  args: Array<number | string | boolean>;
  /** `metric`, `position` or `packet` — used to group the preview. */
  kind: 'metric' | 'position' | 'packet';
}

/**
 * Builds the messages a node's latest metrics would emit, without sending.
 * Keeps the metric order stable (sorted) so the preview does not jitter.
 */
export function buildNodeMessages(
  nodeId: string,
  latest: Record<string, unknown>,
  prefix: string
): PreviewMessage[] {
  const out: PreviewMessage[] = [];
  const metrics = Object.keys(latest).sort();

  for (const metric of metrics) {
    if (isPositionMetric(metric)) continue;
    const args = encodableArgs([latest[metric]]);
    if (args.length === 0) continue;
    out.push({ address: metricAddress(prefix, nodeId, metric), args, kind: 'metric' });
  }

  const lat = firstNumber(latest, ['latitude_i', 'latitudeI', 'lat', 'latitude']);
  const lon = firstNumber(latest, ['longitude_i', 'longitudeI', 'lon', 'longitude']);
  const alt = firstNumber(latest, ['altitude', 'altitudeMsl', 'msl', 'altitudeHae', 'hae']);
  const positionArgs = encodableArgs([lat, lon, alt]);
  if (positionArgs.length > 0) {
    out.push({ address: positionAddress(prefix, nodeId), args: positionArgs, kind: 'position' });
    out.push({ address: packetAddress(prefix, nodeId), args: positionArgs, kind: 'packet' });
  }

  return out;
}

/**
 * One new position packet: `/packet` plus (when the fix is complete) `/position`.
 * Called only for samples whose kind is `position`, so the event rate follows the
 * mesh, not the dashboard's render rate.
 */
export function buildPositionMessages(
  nodeId: string,
  metrics: Record<string, unknown>,
  prefix: string
): PreviewMessage[] {
  const lat = firstNumber(metrics, ['latitude_i', 'latitudeI', 'lat', 'latitude']);
  const lon = firstNumber(metrics, ['longitude_i', 'longitudeI', 'lon', 'longitude']);
  const alt = firstNumber(metrics, ['altitude', 'altitudeMsl', 'msl', 'altitudeHae', 'hae']);
  const args = encodableArgs([lat, lon, alt]);
  if (args.length === 0) return [];
  const out: PreviewMessage[] = [
    { address: packetAddress(prefix, nodeId), args, kind: 'packet' },
  ];
  if (lat !== null && lon !== null) {
    out.push({ address: positionAddress(prefix, nodeId), args, kind: 'position' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function sanitiseConfig(raw: unknown): OscClientConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_OSC_CONFIG };
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    url:
      typeof value.url === 'string' && value.url.trim() !== ''
        ? value.url.trim().replace(/\/+$/, '')
        : DEFAULT_OSC_CONFIG.url,
    prefix: typeof value.prefix === 'string' ? normalisePrefix(value.prefix) : DEFAULT_OSC_CONFIG.prefix,
    targetHost: normaliseTargetHost(value.targetHost),
    targetPort: normaliseTargetPort(value.targetPort),
    intervalMs: Math.round(
      clampNumber(value.intervalMs, OSC_MIN_INTERVAL_MS, OSC_MAX_INTERVAL_MS, DEFAULT_OSC_CONFIG.intervalMs)
    ),
    maxQueue: Math.round(
      clampNumber(value.maxQueue, OSC_MIN_QUEUE, OSC_MAX_QUEUE, DEFAULT_OSC_CONFIG.maxQueue)
    ),
    timeoutMs: Math.round(
      clampNumber(value.timeoutMs, OSC_MIN_TIMEOUT_MS, OSC_MAX_TIMEOUT_MS, DEFAULT_OSC_CONFIG.timeoutMs)
    ),
  };
}

/** Reads the persisted config; malformed JSON or wrong types fall back to defaults. */
export function loadOscConfig(): OscClientConfig {
  try {
    if (typeof window === 'undefined') return { ...DEFAULT_OSC_CONFIG };
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OSC_CONFIG };
    return sanitiseConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_OSC_CONFIG };
  }
}

/** Persists the config (best-effort; storage may be disabled). */
export function saveOscConfig(config: OscClientConfig): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitiseConfig(config)));
  } catch {
    /* storage disabled / quota exceeded — the session still works */
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  /** Messages the bridge acknowledged, or 0 on failure. */
  sent: number;
  error: string | null;
}

type StatsListener = (stats: OscStats) => void;

/**
 * Stateful OSC sender. One instance lives for the app's lifetime
 * (`src/utils/outputs.ts` owns it); the class holds the throttle queue.
 */
export class OscClient {
  private config: OscClientConfig = { ...DEFAULT_OSC_CONFIG };
  private queue: OscMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private inFlight = false;
  private listeners = new Set<StatsListener>();
  private stopped = false;

  private stats: OscStats = {
    queued: 0,
    sent: 0,
    failed: 0,
    dropped: 0,
    pending: 0,
    lastBatchSize: 0,
    lastError: null,
    lastSuccessAt: null,
  };

  constructor(initial?: Partial<OscClientConfig>) {
    this.configure({ ...DEFAULT_OSC_CONFIG, ...initial });
  }

  /** Applies a new config. Disabling drops the queue and cancels the flush timer. */
  /**
   * Tells the bridge where to send UDP.
   *
   * Best-effort: if the bridge is down or older than `POST /target`, the
   * dashboard keeps working and the serial log/health chip still show the target
   * the bridge reports, so a mismatch is visible rather than silent.
   */
  private pushTarget(): void {
    const wanted = `${this.config.targetHost}:${this.config.targetPort}`;
    if (wanted === this.appliedTarget) return;
    this.appliedTarget = wanted;

    void (async () => {
      try {
        const response = await fetch(`${this.config.url}/target`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: this.config.targetHost, port: this.config.targetPort }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          this.lastTargetError = `bridge rejected the target (HTTP ${response.status}) ${detail}`.trim();
        } else {
          this.lastTargetError = null;
        }
      } catch (error) {
        // Not fatal: an older bridge simply keeps its CLI-configured target.
        this.lastTargetError = `could not set the OSC target: ${(error as Error)?.message ?? error}`;
        this.appliedTarget = null; // retry on the next configure()
      }
      this.emit();
    })();
  }

  /** The destination the bridge accepted, e.g. `127.0.0.1:57120`, when known. */
  getAppliedTarget(): string | null {
    return this.appliedTarget;
  }

  /** Last error from pushing the target, or null. */
  getTargetError(): string | null {
    return this.lastTargetError;
  }

  configure(config: OscClientConfig): OscClientConfig {
    this.config = sanitiseConfig(config);
    this.pushTarget();
    if (!this.config.enabled) {
      this.queue = [];
      this.clearTimer();
      this.stats.pending = 0;
      this.emit();
    } else {
      this.scheduleFlush();
    }
    return this.config;
  }

  /** Destination last pushed to the bridge, so repeats are not re-sent. */
  private appliedTarget: string | null = null;

  /** Why the last target push failed, if it did. */
  private lastTargetError: string | null = null;

  getConfig(): OscClientConfig {
    return { ...this.config };
  }

  getStats(): OscStats {
    return { ...this.stats, pending: this.queue.length };
  }

  /** Subscribe to stats changes (returns an unsubscribe function). */
  subscribe(listener: StatsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getStats();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* a broken listener must not stop the sender */
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Schedules the next flush at most `intervalMs` after the last request. */
  private scheduleFlush(): void {
    if (this.stopped || !this.config.enabled) return;
    if (this.timer !== null || this.queue.length === 0) return;
    const elapsed = Date.now() - this.lastFlushAt;
    const wait = Math.max(0, this.config.intervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Queues messages. Synchronous and non-throwing — safe on the serial read path. */
  queueMessages(messages: OscMessage[]): void {
    if (!this.config.enabled || messages.length === 0) return;

    for (const message of messages) {
      if (!message || typeof message.address !== 'string' || message.address === '') continue;
      this.queue.push({ address: message.address, args: message.args ?? [] });
      if (this.queue.length > this.config.maxQueue) {
        this.queue.shift();
        this.stats.dropped += 1;
      }
    }

    this.stats.queued += messages.length;
    this.emit();
    this.scheduleFlush();
  }

  /**
   * Sends now, ignoring the throttle (used by "Send test message" and by the
   * unit test). Never throws; resolves with the bridge's acknowledgement.
   */
  async flush(): Promise<SendResult> {
    if (this.inFlight) {
      // A request is already on the wire; let it finish and pick this up on the
      // next tick so two flushes never interleave the same batch.
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.intervalMs));
    }
    const batch = this.queue;
    if (batch.length === 0) return { ok: true, sent: 0, error: null };
    this.queue = [];
    this.stats.lastBatchSize = batch.length;
    this.stats.pending = 0;
    return this.post(batch);
  }

  /** Sends an explicit list without touching the queue (test message / health). */
  async sendMessages(messages: OscMessage[]): Promise<SendResult> {
    const clean = messages.filter(
      (message) => message && typeof message.address === 'string' && message.address !== ''
    );
    if (clean.length === 0) return { ok: true, sent: 0, error: null };
    this.stats.queued += clean.length;
    return this.post(clean);
  }

  /** The one place that performs HTTP. Catches everything. */
  private async post(messages: OscMessage[]): Promise<SendResult> {
    this.inFlight = true;
    this.lastFlushAt = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.url}/osc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.length === 1 ? messages[0] : messages),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const detail =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : `${response.status} ${response.statusText}`.trim();
        return this.fail(`bridge rejected the batch: ${detail}`);
      }

      const sent =
        payload && typeof payload === 'object' && typeof (payload as { sent?: unknown }).sent === 'number'
          ? Number((payload as { sent: number }).sent)
          : messages.length;

      this.stats.sent += sent;
      this.stats.lastError = null;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.emit();
      return { ok: true, sent, error: null };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const message = aborted
        ? `no response from the bridge within ${this.config.timeoutMs} ms (${this.config.url})`
        : error instanceof Error
        ? error.message
        : String(error);
      return this.fail(`OSC bridge unreachable: ${message}`);
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
      // Anything queued while the request was in flight goes out after the throttle.
      this.scheduleFlush();
    }
  }

  private fail(message: string): SendResult {
    this.stats.failed += 1;
    this.stats.lastError = message;
    this.emit();
    return { ok: false, sent: 0, error: message };
  }

  /** `GET /health` → `{ok, sent, oscTarget}`; never throws. */
  async checkHealth(): Promise<OscHealth> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.url}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          sent: null,
          oscTarget: null,
          uptime: null,
          error: `bridge answered ${response.status} ${response.statusText}`.trim(),
        };
      }
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, sent: null, oscTarget: null, uptime: null, error: 'bridge /health was not JSON' };
      }
      const body = payload as Record<string, unknown>;
      return {
        ok: body.ok !== false,
        sent: typeof body.sent === 'number' ? body.sent : null,
        oscTarget: typeof body.oscTarget === 'string' ? body.oscTarget : null,
        uptime: typeof body.uptime === 'number' ? body.uptime : null,
        error: null,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        sent: null,
        oscTarget: null,
        uptime: null,
        error: aborted
          ? `no response within ${this.config.timeoutMs} ms — is the bridge running? (npm run bridge)`
          : `bridge unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** A representative message for "Send test message" (chosen prefix + one float arg). */
  buildTestMessage(): OscMessage {
    const prefix = normalisePrefix(this.config.prefix);
    return {
      address: `${prefix}/test`,
      args: ['meshmap', Math.round(Date.now() / 1000), true],
    };
  }

  /** Clears counters (queue is untouched). */
  resetStats(): void {
    this.stats = {
      queued: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      pending: this.queue.length,
      lastBatchSize: 0,
      lastError: null,
      lastSuccessAt: null,
    };
    this.emit();
  }

  /** Cancels timers; the client is unusable afterwards (used on unmount/tests). */
  dispose(): void {
    this.stopped = true;
    this.clearTimer();
    this.queue = [];
    this.listeners.clear();
  }
}
