/**
 * mesh-map MQTT bridge — a dependency-free MQTT 3.1.1 subscriber + HTTP/SSE relay.
 *
 * Browsers cannot open raw TCP sockets to an MQTT broker (port 1883), so this
 * small native process does that and pushes every message to the dashboard over
 * Server-Sent Events. It is the same pattern as bridge/osc-bridge.mjs.
 *
 *   GET  /health    connection status + counters
 *   GET  /config    the current broker + topic configuration
 *   POST /config    replace the configuration (persisted to a JSON file)
 *   GET  /stream    Server-Sent Events: status and message JSON lines
 *
 * Optional: --launch-mosquitto spawns a local mosquitto if the binary is present.
 *
 * MQTT 3.1.1 only (universally supported). QoS 0 and 1 for subscriptions, with
 * PUBACK sent for QoS 1, keep-alive pings, and reconnect with backoff.
 */

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* MQTT 3.1.1 wire codec (exported for tests)                                 */
/* -------------------------------------------------------------------------- */

/** Encodes an MQTT "remaining length" (1–4 byte variable integer). */
export function encodeRemainingLength(length) {
  const bytes = [];
  let value = length;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

/** Decodes the varint at `offset`; returns { value, length } or null. */
export function decodeRemainingLength(buffer, offset) {
  let multiplier = 1;
  let value = 0;
  let used = 0;
  for (let i = offset; i < buffer.length; i += 1) {
    const byte = buffer[i];
    value += (byte & 0x7f) * multiplier;
    used += 1;
    if ((byte & 0x80) === 0) return { value, length: used };
    multiplier *= 128;
    if (used > 4) return null; // malformed
  }
  return null;
}

/** UTF-8 string with MQTT's 2-byte big-endian length prefix. */
function encodeUtf8(text) {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

/**
 * MQTT CONNECT packet (3.1.1).
 *
 * @param {{clientId?: string, username?: string, password?: string, keepalive?: number}} options
 */
export function encodeConnectPacket(options = {}) {
  const username = options.username ?? '';
  const password = options.password ?? '';
  const keepalive = options.keepalive ?? 60;
  const clientId = options.clientId ?? `mesh-map-${crypto.randomBytes(4).toString('hex')}`;

  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;

  const variable = Buffer.concat([
    encodeUtf8('MQTT'), // protocol name (level 4 = 3.1.1)
    Buffer.from([0x04, flags]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(Math.max(0, Math.min(65535, Math.floor(keepalive))), 0);
      return b;
    })(),
  ]);
  const payload = Buffer.concat([
    encodeUtf8(clientId),
    ...(username ? [encodeUtf8(username)] : []),
    ...(password ? [encodeUtf8(password)] : []),
  ]);

  const header = Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(variable.length + payload.length)]);
  return Buffer.concat([header, variable, payload]);
}

/**
 * MQTT SUBSCRIBE packet.
 *
 * @param {number} packetId
 * @param {Array<{topic: string, qos?: number}>} subscriptions
 */
export function encodeSubscribePacket(packetId, subscriptions) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId & 0xffff, 0);
  const payload = Buffer.concat(
    subscriptions.flatMap(({ topic, qos = 0 }) => [encodeUtf8(topic), Buffer.from([qos & 0x03])])
  );
  const header = Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(2 + payload.length)]);
  return Buffer.concat([header, id, payload]);
}

/** MQTT PINGREQ (keep-alive). */
export function encodePingreqPacket() {
  return Buffer.from([0xc0, 0x00]);
}

/** MQTT PUBACK for a received QoS 1 PUBLISH. */
export function encodePubackPacket(packetId) {
  const out = Buffer.alloc(4);
  out[0] = 0x40;
  out[1] = 0x02;
  out.writeUInt16BE(packetId & 0xffff, 2);
  return out;
}

/** First byte bit fields. */
export function mqttPacketType(firstByte) {
  return firstByte >> 4;
}

/**
 * Decodes an incoming PUBLISH packet.
 *
 * @param {Buffer} packet a complete packet (fixed header + remaining length + body)
 * @returns {{topic: string, payload: Buffer, qos: number, retain: boolean, dup: boolean, packetId: number | null} | null}
 */
export function decodePublishPacket(packet) {
  if (packet.length < 2) return null;
  const first = packet[0];
  if (mqttPacketType(first) !== 3) return null; // 0x30..0x3F

  const rl = decodeRemainingLength(packet, 1);
  if (!rl) return null;
  const bodyStart = 1 + rl.length;
  if (bodyStart + rl.value > packet.length) return null; // truncated

  const dup = (first & 0x08) !== 0;
  const qos = (first & 0x06) >> 1;
  const retain = (first & 0x01) !== 0;

  let cursor = bodyStart;
  if (cursor + 2 > packet.length) return null;
  const topicLen = packet.readUInt16BE(cursor);
  cursor += 2;
  if (cursor + topicLen > packet.length) return null;
  const topic = packet.toString('utf8', cursor, cursor + topicLen);
  cursor += topicLen;

  let packetId = null;
  if (qos > 0) {
    if (cursor + 2 > packet.length) return null;
    packetId = packet.readUInt16BE(cursor);
    cursor += 2;
  }

  const payload = packet.subarray(cursor, bodyStart + rl.value);
  return { topic, payload, qos, retain, dup, packetId };
}

/** True when the buffer holds at least one complete MQTT packet. */
export function mqttPacketBoundary(buffer) {
  if (buffer.length < 2) return 0;
  const rl = decodeRemainingLength(buffer, 1);
  if (!rl) return -1; // malformed header
  const total = 1 + rl.length + rl.value;
  return total <= buffer.length ? total : 0;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CONFIG = {
  broker: { host: '127.0.0.1', port: 1883, tls: false, username: '', password: '', keepalive: 60 },
  topics: {
    birdnet: 'birdnet/detections',
    meshtastic: 'msh/+/json',
    weather: 'weather/#',
  },
};

/** Normalises an unknown object into a full, safe config. Exported for tests. */
export function sanitiseConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const broker = value.broker && typeof value.broker === 'object' ? value.broker : {};
  const topics = value.topics && typeof value.topics === 'object' ? value.topics : {};

  const host = typeof broker.host === 'string' && broker.host.trim() !== '' ? broker.host.trim() : DEFAULT_CONFIG.broker.host;
  const port = Number.isInteger(broker.port) && broker.port > 0 && broker.port < 65536 ? broker.port : DEFAULT_CONFIG.broker.port;

  const pick = (v, fallback) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback);
  return {
    broker: {
      host,
      port,
      tls: broker.tls === true,
      username: typeof broker.username === 'string' ? broker.username : '',
      password: typeof broker.password === 'string' ? broker.password : '',
      keepalive: Number.isInteger(broker.keepalive) && broker.keepalive > 0 ? broker.keepalive : DEFAULT_CONFIG.broker.keepalive,
    },
    topics: {
      birdnet: pick(topics.birdnet, DEFAULT_CONFIG.topics.birdnet),
      meshtastic: pick(topics.meshtastic, DEFAULT_CONFIG.topics.meshtastic),
      weather: pick(topics.weather, DEFAULT_CONFIG.topics.weather),
    },
  };
}

/** Strict validation for user input arriving over HTTP (never called for disk loads). */
export function validateConfigInput(raw) {
  const broker = raw?.broker;
  if (broker && broker.port !== undefined && !(Number.isInteger(broker.port) && broker.port > 0 && broker.port < 65536)) {
    throw new Error(`port must be an integer 1-65535, got ${JSON.stringify(broker.port)}`);
  }
  if (broker && broker.host !== undefined && (typeof broker.host !== 'string' || broker.host.trim() === '')) {
    throw new Error('host must be a non-empty string');
  }
  return raw;
}

function resolveConfigFile(flagPath) {
  if (flagPath) return resolve(flagPath);
  return join(dirname(fileURLToPath(import.meta.url)), 'mqtt-config.json');
}

function loadConfig(path) {
  try {
    return sanitiseConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return sanitiseConfig({});
  }
}

function saveConfig(path, config) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* MQTT connection                                                            */
/* -------------------------------------------------------------------------- */

class MqttConnection {
  constructor({ broker, topics, onMessage, onStatus, log }) {
    this.broker = broker;
    this.topics = topics;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.log = log ?? (() => {});
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.pending = Buffer.alloc(0);
    this.nextPacketId = 1;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.subscribedTopics = new Set();
  }

  async start() {
    this.closed = false;
    await this.#connect();
  }

  #connect() {
    return new Promise((resolvePromise) => {
      let settled = false;
      const settle = () => {
        if (!settled) { settled = true; resolvePromise(); }
      };

      const attempt = () => {
        if (this.closed) { settle(); return; }
        this.onStatus({ connected: false, host: this.broker.host, port: this.broker.port, error: 'connecting…' });
        this.log(`[mqtt] connecting to ${this.broker.tls ? 'mqtts' : 'mqtt'}://${this.broker.host}:${this.broker.port}`);

        const socket = this.broker.tls
          ? tls.connect({
              host: this.broker.host,
              port: this.broker.port,
              // SNI only makes sense for hostnames; an IP literal would break some servers.
              ...(/^\d{1,3}(\.\d{1,3}){3}$/.test(this.broker.host) ? {} : { servername: this.broker.host }),
            })
          : net.connect({ host: this.broker.host, port: this.broker.port });

        this.socket = socket;
        this.connected = false;
        this.pending = Buffer.alloc(0);
        socket.setKeepAlive(true, 30000);

        socket.on('connect', () => {
          socket.write(encodeConnectPacket({
            clientId: `mesh-map-${crypto.randomBytes(4).toString('hex')}`,
            username: this.broker.username,
            password: this.broker.password,
            keepalive: this.broker.keepalive,
          }));
          settle();
        });

        socket.on('data', (chunk) => this.#onData(chunk));

        socket.on('error', (error) => {
          if (this.connected) this.log(`[mqtt] socket error: ${error.message}`);
          else this.log(`[mqtt] connect failed: ${error.message}`);
          this.#cleanupSocket();
          this.onStatus({ connected: false, host: this.broker.host, port: this.broker.port, error: error.message });
          settle();
          this.#scheduleReconnect();
        });

        socket.on('close', () => {
          if (this.connected) this.log('[mqtt] disconnected');
          this.#cleanupSocket();
          this.onStatus({ connected: false, host: this.broker.host, port: this.broker.port, error: 'disconnected' });
          settle();
          this.#scheduleReconnect();
        });
      };
      attempt();
    });
  }

  #cleanupSocket() {
    this.connected = false;
    this.subscribedTopics.clear();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  #scheduleReconnect() {
    if (this.closed || this.socket) return;
    this.log(`[mqtt] reconnecting in ${this.reconnectDelay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && !this.socket) this.#connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  #onData(chunk) {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const boundary = mqttPacketBoundary(this.pending);
      if (boundary === 0) break; // need more bytes
      if (boundary < 0) {
        this.log('[mqtt] malformed packet header — dropping stream');
        this.pending = Buffer.alloc(0);
        this.socket?.destroy();
        return;
      }
      const packet = this.pending.subarray(0, boundary);
      this.pending = this.pending.subarray(boundary);
      this.#handlePacket(packet);
    }
  }

  #handlePacket(packet) {
    const type = mqttPacketType(packet[0]);
    if (type === 2) {
      // CONNACK
      const code = packet.length >= 4 ? packet[3] : 0xff;
      if (code === 0) {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.log(`[mqtt] connected (${this.broker.host}:${this.broker.port})`);
        this.onStatus({ connected: true, host: this.broker.host, port: this.broker.port, error: null });
        this.#subscribe();
        this.#startKeepalive();
      } else {
        const reasons = { 1: 'unacceptable protocol version', 2: 'identifier rejected', 3: 'server unavailable', 4: 'bad username/password', 5: 'not authorised' };
        this.log(`[mqtt] CONNACK refused: ${reasons[code] ?? `code ${code}`}`);
        this.onStatus({ connected: false, host: this.broker.host, port: this.broker.port, error: `CONNACK refused (${reasons[code] ?? code})` });
        this.socket?.destroy();
      }
    } else if (type === 3) {
      const published = decodePublishPacket(packet);
      if (published) {
        if (published.qos === 1 && this.socket) this.socket.write(encodePubackPacket(published.packetId ?? 0));
        this.onMessage(published.topic, published.payload);
      }
    } else if (type === 13) {
      // PINGRESP — nothing to do
    } else if (type === 9) {
      // SUBACK — nothing to do
    }
  }

  #subscribe() {
    const wanted = [this.topics.birdnet, this.topics.meshtastic, this.topics.weather].filter(Boolean);
    if (wanted.length === 0 || !this.socket) return;
    const subs = wanted.map((topic) => ({ topic, qos: 0 }));
    this.socket.write(encodeSubscribePacket(this.nextPacketId++, subs));
    this.subscribedTopics = new Set(wanted);
    this.log(`[mqtt] subscribed to ${wanted.join(', ')}`);
  }

  #startKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.socket && this.connected) this.socket.write(encodePingreqPacket());
    }, Math.max(5000, (this.broker.keepalive || 60) * 1000 * 0.6));
  }

  /**
   * Re-applies a new configuration.
   *
   * If already connected this just re-subscribes; if not, it abandons whatever
   * backoff was pending and reconnects to the new broker immediately — a user who
   * fixes a host/port should not have to wait through a 30-second backoff.
   */
  reconfigure(broker, topics) {
    this.broker = broker;
    this.topics = topics;
    if (this.connected) {
      this.#subscribe();
      return;
    }
    this.#cleanupSocket();
    this.reconnectDelay = 1000;
    this.#connect().catch(() => {});
  }

  async close() {
    this.closed = true;
    this.#cleanupSocket();
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP + SSE server                                                           */
/* -------------------------------------------------------------------------- */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function readJsonBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`payload exceeds ${maxBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** Launches mosquitto if asked and available; returns a handle or null. */
function launchMosquitto(log) {
  const candidates = ['mosquitto'];
  const configPath = join(dirname(fileURLToPath(import.meta.url)), 'mosquitto.example.conf');
  // The example config must exist for a sane launch; otherwise use defaults.
  const args = existsSync(configPath) ? ['-c', configPath] : [];
  for (const bin of candidates) {
    try {
      const child = spawn(bin, args, { stdio: 'ignore' });
      child.on('error', () => log(`[mosquitto] ${bin} not available — connect to an external broker instead`));
      child.on('exit', (code) => log(`[mosquitto] exited (${code})`));
      log(`[mosquitto] launching local broker: ${bin} ${args.join(' ')}`);
      return child;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function createMqttBridge({ config, configPath, log = console.log, listen = 9300, bind = '127.0.0.1' } = {}) {
  let current = sanitiseConfig(config);
  const clients = new Set(); // SSE responses
  const stats = { startedAt: Date.now(), messages: 0 };

  let connection = null;
  const onStatus = (status) => broadcast({ type: 'status', ...status, receivedAt: Date.now() });
  const onMessage = (topic, payload) => {
    stats.messages += 1;
    broadcast({
      type: 'message',
      topic,
      payloadText: payload.toString('utf8'),
      receivedAt: Date.now(),
    });
  };
  const connectionLog = (line) => log(line);

  function broadcast(event) {
    const text = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(text);
  }

  function applyConfig(next) {
    // Only touch the live connection when something actually changed: a reconnect
    // tears down and re-establishes the broker session, so a no-op POST /config
    // must not disturb a working connection (or the SSE stream feeding the UI).
    const changed =
      JSON.stringify(current.broker) !== JSON.stringify(next.broker) ||
      JSON.stringify(current.topics) !== JSON.stringify(next.topics);
    current = next;
    saveConfig(configPath, current);
    if (connection && changed) connection.reconfigure(current.broker, current.topics);
    broadcast({ type: 'config', config: current });
  }

  async function start() {
    connection = new MqttConnection({
      broker: current.broker,
      topics: current.topics,
      onMessage,
      onStatus,
      log: connectionLog,
    });
    // Await so `await bridge.start()` means "connected (or the attempt failed)".
    await connection.start().catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.method === 'GET' && url === '/health') {
      return writeJson(res, 200, {
        ok: true,
        connected: connection?.connected ?? false,
        host: current.broker.host,
        port: current.broker.port,
        messages: stats.messages,
        uptime: Math.round((Date.now() - stats.startedAt) / 1000),
      });
    }

    if (req.method === 'GET' && url === '/config') {
      return writeJson(res, 200, current);
    }

    if (req.method === 'POST' && url === '/config') {
      try {
        const body = await readJsonBody(req, 64 * 1024);
        applyConfig(sanitiseConfig(validateConfigInput(body)));
        return writeJson(res, 200, { ok: true, config: current });
      } catch (error) {
        return writeJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && url === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...cors,
      });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'status', connected: connection?.connected ?? false, host: current.broker.host, port: current.broker.port, error: null, receivedAt: Date.now() })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'config', config: current })}\n\n`);
      clients.add(res);
      // `res` 'close', not `req` 'close': the request finishes as soon as the GET
      // headers arrive, which would drop every SSE client immediately. The
      // response's 'close' is what signals the browser actually disconnected.
      res.on('close', () => clients.delete(res));
      return;
    }

    return writeJson(res, 404, { error: `not found: ${req.method} ${url}` });
  });

  // Periodic comment keeps idle SSE connections alive through proxies.
  const keepaliveTimer = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15000);

  const close = async () => {
    clearInterval(keepaliveTimer);
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    clients.clear();
    if (connection) await connection.close();
    server.closeAllConnections?.();
    await new Promise((done) => {
      server.close(done);
      // A lingering keep-alive/SSE socket must not hold shutdown forever.
      setTimeout(done, 1000);
    });
  };

  return {
    server,
    // Exposed by reference so callers/tests see the connection that start() creates.
    get connection() {
      return connection;
    },
    stats,
    config: () => current,
    applyConfig,
    start,
    close,
    listen() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(listen, bind, () => {
          server.removeListener('error', reject);
          resolvePromise(server.address());
        });
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const cfg = { listen: 9300, bind: '127.0.0.1', config: null, launchMosquitto: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(`${raw} is missing its value`);
      i += 1;
      return argv[i];
    };
    switch (raw) {
      case '--listen': cfg.listen = Number(take()); break;
      case '--bind': cfg.bind = take(); break;
      case '--config': cfg.config = take(); break;
      case '--launch-mosquitto': cfg.launchMosquitto = true; break;
      case '--help': case '-h': cfg.help = true; break;
      default: throw new Error(`unknown option: ${JSON.stringify(raw)}`);
    }
  }
  return cfg;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  return import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
}

if (isEntryPoint()) {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`mqtt-bridge: ${error.message}`);
    process.exit(2);
  }
  if (cfg.help) {
    console.log('Usage: node bridge/mqtt-bridge.mjs [options]\n\n  --listen <port>        HTTP/SSE port            (default 9300)\n  --bind <host>          bind address             (default 127.0.0.1)\n  --config <path>        JSON config file          (default bridge/mqtt-config.json)\n  --launch-mosquitto     also launch a local mosquitto, if installed');
    process.exit(0);
  }

  const configPath = resolveConfigFile(cfg.config);
  const bridge = createMqttBridge({ config: loadConfig(configPath), configPath, listen: cfg.listen, bind: cfg.bind });
  if (cfg.launchMosquitto) launchMosquitto(console.log);
  bridge.listen().then((address) => {
    console.log(`mqtt-bridge — MQTT 3.1.1 -> HTTP + Server-Sent Events`);
    console.log(`  listening   http://127.0.0.1:${address.port}  (GET /health, POST /config, GET /stream)`);
    console.log(`  broker      mqtt://${bridge.config().broker.host}:${bridge.config().broker.port}`);
    console.log(`  config file ${configPath}`);
    console.log(`  Ctrl-C to stop.`);
    bridge.start();
  }).catch((error) => {
    console.error(`mqtt-bridge: ${error.message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => { bridge.close().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { bridge.close().then(() => process.exit(0)); });
}
