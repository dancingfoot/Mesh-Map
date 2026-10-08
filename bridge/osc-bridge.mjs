#!/usr/bin/env node
/**
 * osc-bridge.mjs — dependency-free OSC 1.0 bridge for the Mesh-Map browser dashboard.
 *
 * Browsers cannot open UDP sockets, so the dashboard POSTs (or sends over WebSocket)
 * JSON messages to this local process, which encodes OSC 1.0 and forwards them over UDP
 * to any OSC receiver (SuperCollider, TouchDesigner, Max, Pd, ...).
 *
 * Inputs (both on the same port):
 *   POST /osc   JSON body: {address, args} or [{address, args}, ...]
 *   WS   upgrade on the same port: each text frame is the same JSON shape
 *   GET  /health
 *   GET  /
 *
 * Zero npm dependencies. Node >= 20. ESM.
 */

import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { listSerialPorts } from './serial-ports.mjs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB cap per message
const MAX_WS_BUFFER_BYTES = 4 * 1024 * 1024; // cap on reassembled frames
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024; // cap on a single frame payload

// ---------------------------------------------------------------------------
// CLI parsing (by hand, no dependencies)
// ---------------------------------------------------------------------------

const USAGE = `osc-bridge — dependency-free OSC 1.0 bridge (HTTP + WebSocket -> UDP)

Usage: node bridge/osc-bridge.mjs [options]

Options:
  --listen <port>     HTTP/WebSocket port            (default 9000)
  --bind <addr>       bind address                   (default 127.0.0.1)
  --osc-host <host>   UDP target host                (default 127.0.0.1)
  --osc-port <port>   UDP target port                (default 57120)
  --prefix <path>     prefix for relative addresses  (default /mesh)
  --map <a=b,c=d>     address rewrite rules, applied to incoming addresses
  --dry-run           log OSC messages instead of sending
  --verbose           log every message
  --help              show this help

Examples:
  node bridge/osc-bridge.mjs --listen 9000 --osc-port 57120
  node bridge/osc-bridge.mjs --map /mesh=/synth --verbose
`;

/** Parse argv by hand. Returns a config object, or throws on bad usage. */
export function parseArgs(argv) {
  const cfg = {
    listen: 9000,
    bind: '127.0.0.1',
    oscHost: '127.0.0.1',
    oscPort: 57120,
    prefix: '/mesh',
    map: [], // [{from, to}] ordered as given
    dryRun: false,
    verbose: false,
    help: false,
    // Directory scanned by GET /serial/ports. Overridable so the system-port
    // list can be exercised against a synthetic tree (containers have no
    // serial devices of their own).
    devRoot: '/dev',
  };

  const need = (name, value) => {
    if (value === undefined) throw new Error(`option ${name} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    // support --opt=value as well as --opt value
    let arg = raw;
    let inlineValue;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq !== -1) {
      arg = raw.slice(0, eq);
      inlineValue = raw.slice(eq + 1);
    }
    const take = (name) => (inlineValue !== undefined ? inlineValue : need(name, argv[++i]));

    switch (arg) {
      case '--listen': {
        const v = Number(take('--listen'));
        if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`--listen must be a port 0-65535, got ${JSON.stringify(take('--listen'))}`);
        cfg.listen = v;
        break;
      }
      case '--bind':
        cfg.bind = take('--bind');
        break;
      case '--osc-host':
        cfg.oscHost = take('--osc-host');
        break;
      case '--osc-port': {
        const rawV = take('--osc-port');
        const v = Number(rawV);
        if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`--osc-port must be a port 0-65535, got ${JSON.stringify(rawV)}`);
        cfg.oscPort = v;
        break;
      }
      case '--prefix': {
        let v = take('--prefix').trim();
        if (v === '') v = '/';
        if (!v.startsWith('/')) v = '/' + v;
        if (v.length > 1 && v.endsWith('/')) v = v.slice(0, -1);
        cfg.prefix = v;
        break;
      }
      case '--map': {
        const v = take('--map');
        for (const rule of String(v).split(',')) {
          const t = rule.trim();
          if (t === '') continue;
          const idx = t.indexOf('=');
          if (idx <= 0 || idx === t.length - 1) {
            throw new Error(`--map rule must look like a=b, got ${JSON.stringify(t)}`);
          }
          cfg.map.push({ from: t.slice(0, idx).trim(), to: t.slice(idx + 1).trim() });
        }
        break;
      }
      case '--dev-root':
        cfg.devRoot = take('--dev-root');
        break;
      case '--dry-run':
        cfg.dryRun = true;
        break;
      case '--verbose':
        cfg.verbose = true;
        break;
      case '--help':
      case '-h':
        cfg.help = true;
        break;
      default:
        throw new Error(`unknown option: ${JSON.stringify(raw)}`);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// OSC 1.0 encoding
// ---------------------------------------------------------------------------

/**
 * OSC strings (and blobs) are NUL-padded to a 4-byte boundary.
 * A string of length L occupies L+1 bytes minimum (its terminator), then 1-4 NULs.
 * This function returns the precise number of NUL bytes required: always 1..4.
 */
export function oscPadLength(byteLength) {
  const remainder = byteLength % 4;
  // Always at least one NUL terminator, and the total must reach a 4-byte boundary:
  // hence 1-4 NULs (4 when the body is already aligned).
  return remainder === 0 ? 4 : 4 - remainder;
}

/** Encode a JS string as a padded, NUL-terminated OSC string. */
function encodeOscString(str) {
  const body = Buffer.from(String(str), 'utf8');
  const pad = oscPadLength(body.length);
  return Buffer.concat([body, Buffer.alloc(pad, 0)]);
}

/** Encode a blob: int32 size, then the bytes, padded to 4 bytes (0 pad if already aligned). */
function encodeOscBlob(buf) {
  const size = Buffer.alloc(4);
  size.writeInt32BE(buf.length, 0);
  const pad = (4 - (buf.length % 4)) % 4; // blobs pad with 0-3 bytes (size field keeps alignment)
  return Buffer.concat([size, buf, Buffer.alloc(pad, 0)]);
}

/** Classify one JSON arg into an OSC type tag + encoder. Throws a descriptive error. */
function classifyArg(value, index) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`args[${index}]: number must be finite`);
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      return { tag: 'i', write: (b) => { const t = Buffer.alloc(4); t.writeInt32BE(value, 0); return t; } };
    }
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      // 'h' int64 — only when it does not fit in int32 but is a safe integer.
      return { tag: 'h', write: (b) => { const t = Buffer.alloc(8); t.writeBigInt64BE(BigInt(value), 0); return t; } };
    }
    return { tag: 'f', write: (b) => { const t = Buffer.alloc(4); t.writeFloatBE(value, 0); return t; } };
  }
  if (typeof value === 'string') {
    return { tag: 's', write: () => encodeOscString(value) };
  }
  if (typeof value === 'boolean') {
    return { tag: value ? 'T' : 'F', write: () => Buffer.alloc(0) };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (value.type === 'b') {
      if (typeof value.value !== 'string') throw new Error(`args[${index}]: blob needs {"type":"b","value":"<base64>"}`);
      let bytes;
      try {
        bytes = Buffer.from(value.value, 'base64');
      } catch {
        throw new Error(`args[${index}]: blob value is not valid base64`);
      }
      if (bytes.length === 0 && value.value.trim() !== '') throw new Error(`args[${index}]: blob value is not valid base64`);
      return { tag: 'b', write: () => encodeOscBlob(bytes) };
    }
    if (value.type && typeof value.value !== 'undefined') {
      // allow explicit {"type":"i"|"f"|"s", "value": ...} for convenience
      const t = String(value.type);
      if (t === 'i' || t === 'f' || t === 's' || t === 'T' || t === 'F' || t === 'h') {
        const inner = classifyArg(t === 'T' ? true : t === 'F' ? false : value.value, index);
        if (inner.tag !== t) {
          throw new Error(`args[${index}]: declared type "${t}" does not match value ${JSON.stringify(value.value)}`);
        }
        return inner;
      }
    }
    throw new Error(`args[${index}]: unsupported object arg (expected {"type":"b","value":...})`);
  }
  if (value === null) throw new Error(`args[${index}]: null is not a valid OSC arg`);
  if (Array.isArray(value)) throw new Error(`args[${index}]: nested arrays are not valid OSC args`);
  throw new Error(`args[${index}]: unsupported arg type ${typeof value}`);
}

/**
 * Encode one OSC 1.0 message into a Buffer.
 * Layout: address (padded) | "," + tags (padded) | 4-byte-aligned big-endian args.
 */
export function encodeOsc(address, args = []) {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('address must be a non-empty string');
  }
  if (!address.startsWith('/')) throw new Error(`address must start with "/", got ${JSON.stringify(address)}`);
  if (!Array.isArray(args)) throw new Error('args must be an array');

  const parts = [];
  const tags = [];
  for (let i = 0; i < args.length; i++) {
    const { tag, write } = classifyArg(args[i], i);
    tags.push(tag);
    parts.push(write());
  }

  const head = [encodeOscString(address), encodeOscString(',' + tags.join(''))];
  const buf = Buffer.concat([...head, ...parts]);
  if (buf.length > MAX_MESSAGE_BYTES) {
    throw new Error(`encoded message is ${buf.length} bytes, exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
  }
  return buf;
}

/**
 * Decode an OSC message. Exported so tests/tools can reuse it — the bridge test
 * deliberately ships its OWN independent decoder so padding bugs cannot hide.
 */
export function decodeOsc(buf) {
  const readString = (offset) => {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    if (end >= buf.length) throw new Error('unterminated OSC string');
    const str = buf.toString('utf8', offset, end);
    const pad = oscPadLength(end - offset);
    return { str, next: offset + (end - offset) + pad };
  };

  let { str: address, next } = readString(0);
  let tags;
  ({ str: tags, next } = readString(next));
  if (!tags.startsWith(',')) throw new Error('OSC type tag string must start with ","');
  const typeTags = tags.slice(1);

  const args = [];
  for (const tag of typeTags) {
    switch (tag) {
      case 'i': args.push(buf.readInt32BE(next)); next += 4; break;
      case 'f': args.push(buf.readFloatBE(next)); next += 4; break;
      case 's': { const r = readString(next); args.push(r.str); next = r.next; break; }
      case 'b': {
        const size = buf.readInt32BE(next); next += 4;
        args.push(Buffer.from(buf.subarray(next, next + size)));
        next += size + ((4 - (size % 4)) % 4);
        break;
      }
      case 'h': args.push(buf.readBigInt64BE(next)); next += 8; break;
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      default: throw new Error(`unsupported OSC type tag "${tag}"`);
    }
  }
  return { address, typeTags, args };
}

// ---------------------------------------------------------------------------
// Address handling
// ---------------------------------------------------------------------------

/** Apply --prefix (for relative addresses) then --map rewrite rules. */
export function resolveAddress(address, cfg) {
  let addr = String(address);
  if (!addr.startsWith('/')) {
    const prefix = cfg.prefix === '/' ? '' : cfg.prefix;
    addr = prefix + (addr.startsWith('/') ? addr : '/' + addr);
  }
  for (const { from, to } of cfg.map) {
    if (addr === from) { addr = to; break; }
    if (addr.startsWith(from.endsWith('/') ? from : from + '/')) {
      addr = to + addr.slice(from.length);
      break;
    }
  }
  return addr;
}

// ---------------------------------------------------------------------------
// Message normalization / validation
// ---------------------------------------------------------------------------

/** Normalize one JSON object into {address, args}. Throws on malformed input. */
function normalizeOne(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('each message must be a JSON object like {"address":"/x","args":[]}');
  }
  if (typeof obj.address !== 'string' || obj.address.length === 0) {
    throw new Error('message.address must be a non-empty string');
  }
  let args = obj.args;
  if (args === undefined || args === null) args = [];
  if (!Array.isArray(args)) throw new Error('message.args must be an array (or omitted)');
  return { address: obj.address, args };
}

/** Normalize a parsed JSON body (single object or array) into a list. Throws on malformed input. */
export function normalizePayload(json) {
  const list = Array.isArray(json) ? json : [json];
  if (list.length === 0) return [];
  return list.map(normalizeOne);
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Validates a requested OSC destination.
 *
 * Exported so the rules can be tested directly: this is the one place a
 * (loopback-only, but still) local request can redirect where the bridge sends.
 *
 * @param {unknown} host
 * @param {unknown} port
 * @returns {{host: string, port: number}} cleaned values
 * @throws {Error} when either value is unusable
 */
export function validateTarget(host, port) {
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('host must be a non-empty string, e.g. "127.0.0.1"');
  }
  const cleanHost = host.trim();
  // Reject anything that is not a plausible hostname or IP literal; this also
  // rules out control characters being smuggled into the log or the UDP call.
  if (!/^[A-Za-z0-9._:\[\]-]{1,253}$/.test(cleanHost) || cleanHost.includes('..')) {
    throw new Error(`host ${JSON.stringify(host)} is not a valid hostname or IP`);
  }
  const cleanPort = typeof port === 'string' && port.trim() !== '' ? Number(port) : port;
  if (!Number.isInteger(cleanPort) || cleanPort < 0 || cleanPort > 65535) {
    throw new Error(`port must be an integer 0-65535, got ${JSON.stringify(port)}`);
  }
  return { host: cleanHost, port: cleanPort };
}

class CORSHeaders {
  static apply(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

export function createBridge(cfg) {
  const stats = { sent: 0, errors: 0, startedAt: Date.now() };
  const udp = dgram.createSocket('udp4');

  const log = (...a) => console.log(...a);
  const vlog = (...a) => { if (cfg.verbose) console.log(...a); };

  /** Encode + send a batch of normalized messages. Returns the count actually sent. */
  function sendMessages(messages) {
    let sent = 0;
    for (const msg of messages) {
      const address = resolveAddress(msg.address, cfg);
      const packet = encodeOsc(address, msg.args);
      if (cfg.dryRun) {
        vlog(`[dry-run] ${address} ${JSON.stringify(msg.args)} (${packet.length} bytes)`);
        sent++;
        continue;
      }
      udp.send(packet, cfg.oscPort, cfg.oscHost, (err) => {
        if (err) { stats.errors++; console.error(`[osc] send failed: ${err.message}`); }
      });
      sent++;
      vlog(`[osc] -> ${cfg.oscHost}:${cfg.oscPort} ${address} ${JSON.stringify(msg.args)} (${packet.length} bytes)`);
    }
    stats.sent += sent;
    return sent;
  }

  /** Shared handler for HTTP POST and WS text frames. Returns {sent} or throws. */
  function handleJsonText(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON: ${err.message}`);
    }
    const messages = normalizePayload(json);
    return { sent: sendMessages(messages) };
  }

  // --- HTTP -----------------------------------------------------------------

  const server = http.createServer((req, res) => {
    CORSHeaders.apply(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `osc-bridge — HTTP + WebSocket -> OSC 1.0 (UDP)\n\n` +
        `OSC target : ${cfg.oscHost}:${cfg.oscPort}${cfg.dryRun ? '  [DRY RUN]' : ''}\n` +
        `Address scheme (default): /mesh/node/<nodeId>/<metric>\n\n` +
        `POST /osc   {"address":"/mesh/node/!a1d7631c/battery","args":[87]}\n` +
        `POST /target {"host":"127.0.0.1","port":57120}   retarget the UDP destination\n` +
        `            also accepts an array of such objects; replies {"sent":N}\n` +
        `WS   ws://${cfg.bind}:${server.address()?.port ?? cfg.listen}/  (text frames, same JSON shape)\n` +
        `GET  /health\n` +
        `GET  /serial/ports   serial ports on this machine (scans --dev-root)\n\n` +
        `Addresses not starting with "/" are prefixed with "${cfg.prefix}".\n`
      );
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      const body = JSON.stringify({
        ok: true,
        oscTarget: `${cfg.oscHost}:${cfg.oscPort}`,
        sent: stats.sent,
        uptime: Math.round(((Date.now() - stats.startedAt) / 1000) * 10) / 10,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    // A browser cannot enumerate serial ports (Web Serial only exposes devices
    // the user already granted), so the dashboard asks the bridge, which can
    // just read the OS.
    if (req.method === 'GET' && url === '/serial/ports') {
      const body = JSON.stringify({
        platform: process.platform,
        ports: listSerialPorts(cfg.devRoot, `${cfg.devRoot}/serial/by-id`),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    // Retarget the UDP destination at runtime, so the dashboard can offer a
    // target field instead of requiring the bridge to be restarted with a flag.
    if (req.method === 'POST' && url === '/target') {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_MESSAGE_BYTES) {
          aborted = true;
          stats.errors++;
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `payload exceeds ${MAX_MESSAGE_BYTES} bytes` }));
          chunks.length = 0;
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => { aborted = true; });
      req.on('end', () => {
        if (aborted) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const next = validateTarget(body?.host, body?.port);
          cfg.oscHost = next.host;
          cfg.oscPort = next.port;
          console.log(`  OSC target  udp://${cfg.oscHost}:${cfg.oscPort}  (updated by client)`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, oscTarget: `${cfg.oscHost}:${cfg.oscPort}` }));
        } catch (err) {
          stats.errors++;
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && url === '/osc') {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_MESSAGE_BYTES) {
          aborted = true;
          stats.errors++;
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `payload exceeds ${MAX_MESSAGE_BYTES} bytes` }));
          chunks.length = 0;
          // Drain and discard the rest of the upload instead of destroying the socket:
          // that keeps the connection well-behaved (no RST for a client mid-write)
          // while still holding only O(1) memory.
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => { aborted = true; });
      req.on('end', () => {
        if (aborted) return;
        try {
          const result = handleJsonText(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          stats.errors++;
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `not found: ${req.method} ${url}` }));
  });

  // --- Minimal RFC6455 WebSocket server (hand-rolled, no `ws`) ---------------
  //
  // We deliberately do NOT use the `upgrade` event's socket-destroying default path
  // by registering our own handler. Only text frames are interpreted; binary is
  // ignored, ping is answered with pong, and close is echoed cleanly.

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();

    const fail = (code, text) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      } catch { /* socket already gone */ }
      socket.destroy();
    };

    if (upgrade !== 'websocket' || !key || String(version) !== '13') {
      fail(400, 'Bad Request');
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    if (cfg.verbose) log(`[ws] client connected from ${socket.remoteAddress}:${socket.remotePort}`);

    // --- per-connection frame parser state ---
    let buffer = Buffer.alloc(0);
    let fragments = []; // Buffers of a fragmented text message
    let fragmentOpcode = null;
    let closed = false;

    const sendFrame = (opcode, payload) => {
      if (closed || socket.destroyed) return;
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      try {
        socket.write(Buffer.concat([header, payload]));
      } catch { /* client vanished mid-write */ }
    };

    const sendText = (str) => sendFrame(0x1, Buffer.from(str, 'utf8'));

    const closeWith = (code, reason = '') => {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      sendFrame(0x8, body);
      socket.end();
    };

    socket.on('data', (chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_WS_BUFFER_BYTES) {
        closeWith(1009, 'message too big');
        return;
      }

      // Parse as many complete frames as the buffer holds.
      for (;;) {
        if (closed) return;
        if (buffer.length < 2) return;

        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (rsv !== 0) { closeWith(1002, 'RSV bits must be 0'); return; }

        if (payloadLen === 126) {
          if (buffer.length < offset + 2) return;
          payloadLen = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (buffer.length < offset + 8) return;
          const big = buffer.readBigUInt64BE(offset);
          if (big > BigInt(MAX_WS_PAYLOAD_BYTES)) { closeWith(1009, 'frame too big'); return; }
          payloadLen = Number(big);
          offset += 8;
        }
        if (payloadLen > MAX_WS_PAYLOAD_BYTES) { closeWith(1009, 'frame too big'); return; }

        // RFC6455: client -> server frames MUST be masked.
        if (!masked) { closeWith(1002, 'client frames must be masked'); return; }

        const maskKey = buffer.subarray(offset, offset + 4);
        if (maskKey.length < 4) return;
        offset += 4;

        if (buffer.length < offset + payloadLen) return; // wait for the rest

        const payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = buffer[offset + i] ^ maskKey[i & 3];
        }
        buffer = buffer.subarray(offset + payloadLen);

        // --- control frames ---
        if (opcode === 0x8) { // close
          if (!closed) {
            closed = true;
            sendFrame(0x8, payload.subarray(0, 2));
            socket.end();
          }
          return;
        }
        if (opcode === 0x9) { sendFrame(0xa, payload); continue; } // ping -> pong
        if (opcode === 0xa) continue; // pong: ignore
        if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
          closeWith(1002, `unsupported opcode ${opcode}`);
          return;
        }
        if (opcode === 0x2) continue; // binary: ignored by design

        // --- data frames: text (0x1) and continuation (0x0) ---
        if (opcode === 0x1) {
          if (fragmentOpcode !== null) { closeWith(1002, 'new text frame during fragmentation'); return; }
          if (fin) {
            handleWsText(Buffer.concat([payload]));
          } else {
            fragmentOpcode = 0x1;
            fragments = [payload];
          }
        } else { // 0x0 continuation
          if (fragmentOpcode === null) { closeWith(1002, 'continuation without initial frame'); return; }
          fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(fragments);
            fragments = [];
            fragmentOpcode = null;
            handleWsText(full);
          }
        }
      }
    });

    function handleWsText(buf) {
      let reply;
      try {
        reply = handleJsonText(buf.toString('utf8'));
      } catch (err) {
        stats.errors++;
        reply = { error: err.message };
        if (cfg.verbose) console.error(`[ws] ${err.message}`);
        sendText(JSON.stringify(reply));
        return;
      }
      sendText(JSON.stringify(reply));
    }

    const onGone = () => {
      if (closed) return;
      closed = true;
      if (cfg.verbose) log('[ws] client disconnected');
    };
    socket.on('close', onGone);
    socket.on('end', () => { try { socket.end(); } catch { /* ignore */ } });
    socket.on('error', onGone);
  });

  server.on('clientError', (err, socket) => {
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch { /* ignore */ }
  });

  return {
    server,
    udp,
    stats,
    handleJsonText,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.listen, cfg.bind, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        try { udp.close(); } catch { /* already closed */ }
        server.close(() => resolve());
        // If there are lingering upgraded sockets, don't hang the process.
        setTimeout(resolve, 250).unref?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`osc-bridge: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (cfg.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const bridge = createBridge(cfg);
  let addr;
  try {
    addr = await bridge.listen();
  } catch (err) {
    console.error(`osc-bridge: cannot listen on ${cfg.bind}:${cfg.listen} — ${err.message}`);
    process.exit(1);
  }

  const shownHost = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
  console.log('osc-bridge — OSC 1.0 over UDP, from HTTP + WebSocket');
  console.log(`  listening   http://${shownHost}:${addr.port}  (POST /osc, GET /health, WS upgrade)`);
  console.log(`  OSC target  udp://${cfg.oscHost}:${cfg.oscPort}${cfg.dryRun ? '   [DRY RUN — nothing is sent]' : ''}`);
  console.log(`  prefix      "${cfg.prefix}" for addresses not starting with "/"`);
  if (cfg.map.length) {
    console.log(`  map rules   ${cfg.map.map((r) => `${r.from} -> ${r.to}`).join(', ')}`);
  }
  console.log(`  scheme      /mesh/node/<nodeId>/<metric>${cfg.verbose ? '   (verbose)' : ''}`);
  console.log('  Ctrl-C to stop.');

  const shutdown = (signal) => {
    console.log(`\nosc-bridge: ${signal} received, shutting down (${bridge.stats.sent} message(s) sent).`);
    bridge.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(`osc-bridge: uncaught exception — ${err?.stack || err}`);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`osc-bridge: unhandled rejection — ${err?.stack || err}`);
  });
}

// Only auto-start when executed directly (so tests can import the helpers).
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
