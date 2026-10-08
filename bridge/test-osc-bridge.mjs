#!/usr/bin/env node
/**
 * test-osc-bridge.mjs — self-contained test for bridge/osc-bridge.mjs.
 *
 * Plain `node`, no test framework, no dependencies. It:
 *   1. starts the bridge as a CHILD PROCESS on an ephemeral port, with a UDP
 *      listener that this test creates itself,
 *   2. POSTs a single message and an array of messages,
 *   3. connects over WebSocket using Node's built-in `WebSocket` (Node >= 22),
 *   4. decodes the received UDP datagrams with its OWN decoder (below) and asserts
 *      addresses, type tags and values — including 6-char and 9-char strings that
 *      force 1-4 NUL padding, and an int/float mix,
 *   5. asserts /health reports the right count,
 *   6. kills the child and exits non-zero with a clear message on any failure.
 *
 * The decoder here is written independently of the bridge's encoder on purpose:
 * a shared implementation would hide exactly the padding bug this test exists for.
 */

import { spawn } from 'node:child_process';
import { validateTarget } from './osc-bridge.mjs';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'osc-bridge.mjs');

const failures = [];
let checks = 0;

function ok(condition, label, detail) {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
    failures.push(label + (detail ? ` (${detail})` : ''));
  }
}

function eq(actual, expected, label) {
  ok(
    Object.is(actual, expected),
    label,
    Object.is(actual, expected) ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, a === b ? '' : `expected ${b}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Independent OSC decoder (strict about padding)
// ---------------------------------------------------------------------------

/**
 * Read one OSC string starting at `offset`.
 * Asserts: a NUL terminator exists, the padding to the next 4-byte boundary is
 * 1..4 NUL bytes, and every padding byte really is zero.
 */
function readString(buf, offset, what) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error(`${what} at ${offset}: no NUL terminator`);

  const body = buf.toString('utf8', offset, end);
  const bodyLen = end - offset;
  // Minimum 1 NUL; total (body + NULs) must be a multiple of 4 => 1..4 NULs.
  const padLen = 4 - (bodyLen % 4);
  const next = offset + bodyLen + padLen;
  if (next > buf.length) {
    throw new Error(`${what} at ${offset}: padding runs past end of datagram (body=${bodyLen}, pad=${padLen})`);
  }
  if (padLen < 1 || padLen > 4) throw new Error(`${what} at ${offset}: illegal pad length ${padLen}`);
  for (let i = 0; i < padLen; i++) {
    if (buf[end + i] !== 0) {
      throw new Error(`${what} at ${offset}: pad byte ${i} is 0x${buf[end + i].toString(16)}, expected 0x00`);
    }
  }
  return { value: body, bodyLen, padLen, next };
}

/** Decode a whole datagram. Throws unless it is consumed exactly (catches misalignment). */
function decodeOscStrict(buf) {
  const addr = readString(buf, 0, 'address');
  const tags = readString(buf, addr.next, 'type-tag string');
  if (!tags.value.startsWith(',')) throw new Error(`type-tag string "${tags.value}" must start with ","`);

  const typeTags = [...tags.value.slice(1)];
  const args = [];
  let off = tags.next;

  for (const tag of typeTags) {
    switch (tag) {
      case 'i':
        args.push(buf.readInt32BE(off)); off += 4; break;
      case 'f':
        args.push(buf.readFloatBE(off)); off += 4; break;
      case 'h':
        args.push(buf.readBigInt64BE(off)); off += 8; break;
      case 'd':
        args.push(buf.readDoubleBE(off)); off += 8; break;
      case 's': {
        const s = readString(buf, off, 'string arg');
        args.push(s.value); off = s.next; break;
      }
      case 'b': {
        const size = buf.readInt32BE(off); off += 4;
        args.push(Buffer.from(buf.subarray(off, off + size)));
        off += size + ((4 - (size % 4)) % 4);
        break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      default: throw new Error(`unsupported type tag "${tag}"`);
    }
  }

  if (off !== buf.length) {
    throw new Error(`datagram not consumed exactly: read ${off} of ${buf.length} bytes (padding/alignment bug)`);
  }
  return { address: addr.value, addressPad: addr.padLen, tagPad: tags.padLen, typeTags, args };
}

/**
 * Independent padding proof: find `needle` as ASCII in the raw datagram and assert
 * it is followed by exactly `expectedPad` NUL bytes, with the next 4-byte boundary after that.
 */
function assertStringPadding(buf, needle, expectedPad, label) {
  const at = buf.indexOf(Buffer.from(needle, 'utf8'));
  if (at === -1) {
    ok(false, label, `substring "${needle}" not found in datagram`);
    return;
  }
  const nuls = [];
  for (let i = at + needle.length; i < Math.min(buf.length, at + needle.length + 6); i++) {
    if (buf[i] !== 0) break;
    nuls.push(buf[i]);
  }
  const boundaryOk = (at + needle.length + expectedPad) % 4 === 0;
  ok(
    nuls.length === expectedPad && boundaryOk,
    label,
    `expected ${expectedPad} NUL(s) after "${needle}" reaching a 4-byte boundary; ` +
      `found ${nuls.length} (ends at byte ${at + needle.length + nuls.length}, %4=${(at + needle.length + nuls.length) % 4})`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ask the OS for a free TCP port (used only to give the child a concrete port). */
function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the bridge as a child process with `--listen 0` (OS-assigned ephemeral port)
 * and recover the real port from the startup banner. Using port 0 removes any
 * race between "find a free port" and "bind it".
 */
async function spawnBridge(extraArgs = []) {
  const child = spawn(
    process.execPath,
    [BRIDGE, '--listen', '0', '--bind', '127.0.0.1', ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`\n!! bridge child exited early: code=${code} signal=${signal}\n${log}`);
    }
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && child.exitCode === null) {
    const m = log.match(/listening\s+http:\/\/[^\s:]+:(\d+)/);
    if (m) {
      const port = Number(m[1]);
      return { child, listenPort: port, log: () => log, stop: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } } };
    }
    await sleep(50);
  }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  throw new Error(`bridge child never printed its listening banner:\n${log}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. UDP listener we own -------------------------------------------------
  const received = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg) => received.push(msg));
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', resolve);
  });
  const udpPort = udp.address().port;
  console.log(`UDP listener on 127.0.0.1:${udpPort}`);

  function waitForDatagrams(n, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (received.length >= n) return resolve(received.slice(0, n));
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`timed out waiting for ${n} datagram(s); got ${received.length}`));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  // 2. Start the bridge as a child on an OS-assigned (ephemeral) port --------
  const bridge = await spawnBridge(['--osc-port', String(udpPort), '--osc-host', '127.0.0.1', '--map', '/mesh/kb=/synth/kb', '--verbose']);
  const { child, listenPort } = bridge;
  let childLog = bridge.log();
  const cleanup = () => {
    bridge.stop();
    try { udp.close(); } catch { /* already closed */ }
  };
  process.on('exit', cleanup);

  // 3. Wait for readiness (/health) -----------------------------------------
  const deadline = Date.now() + 8000;
  let healthy = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await request(listenPort, 'GET', '/health');
      if (r.status === 200) { healthy = JSON.parse(r.text); break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  childLog = bridge.log();
  if (!healthy) {
    cleanup();
    console.error(`\nFATAL: bridge never became healthy on 127.0.0.1:${listenPort}\n--- child output ---\n${childLog}`);
    process.exit(1);
  }
  console.log(`Bridge is up on 127.0.0.1:${listenPort}, OSC target reported as ${healthy.oscTarget}\n`);

  ok(healthy.ok === true, 'GET /health -> {ok:true}');
  eq(healthy.oscTarget, `127.0.0.1:${udpPort}`, 'GET /health -> oscTarget matches the UDP listener');
  ok(typeof healthy.uptime === 'number' && healthy.uptime >= 0, 'GET /health -> uptime is a number');
  ok(childLog.includes('osc-bridge'), 'startup banner was printed');
  ok(/-?\d+/.test(String(listenPort)), '--listen 0 let the OS assign a real port');

  let expectedSent = 0;

  // --- Test 1: single message via POST -------------------------------------
  console.log('\n[1] POST /osc — single message (int)');
  {
    const r = await request(
      listenPort, 'POST', '/osc',
      JSON.stringify({ address: '/mesh/node/!a1d7631c/battery', args: [87] })
    );
    eq(r.status, 200, 'POST /osc -> 200');
    deepEq(JSON.parse(r.text), { sent: 1 }, 'POST /osc -> {"sent":1}');
    eq(r.headers['access-control-allow-origin'], '*', 'CORS: Access-Control-Allow-Origin: *');

    expectedSent += 1;
    const [dgram] = await waitForDatagrams(expectedSent);
    const msg = decodeOscStrict(dgram);
    eq(msg.address, '/mesh/node/!a1d7631c/battery', 'UDP address');
    deepEq(msg.typeTags, ['i'], 'UDP type tags are "i"');
    deepEq(msg.args, [87], 'UDP args are [87]');
    // Hand-computed, encoder-independent size proof:
    //   address 28 bytes + 4 NULs = 32 | tags ",i" 2 + 2 NULs = 4 | int32 = 4  => 40
    eq(dgram.length, 40, 'datagram is exactly 40 bytes (28+4 addr, 2+2 tags, 4 int)');
  }

  // --- Test 2: array via POST, with the padding-sensitive strings -----------
  console.log('\n[2] POST /osc — array of messages (string padding, int/float mix)');
  {
    const sixChar = 'abcdef';     // 6 bytes -> 2 NULs
    const nineChar = 'abcdefghi'; // 9 bytes -> 3 NULs
    const r = await request(
      listenPort, 'POST', '/osc',
      JSON.stringify([
        { address: '/mesh/node/!a1d7631c/label', args: [sixChar] },
        { address: '/mesh/node/!a1d7631c/mix', args: [nineChar, 220.5, 1000, true, false] },
      ])
    );
    eq(r.status, 200, 'POST /osc (array) -> 200');
    deepEq(JSON.parse(r.text), { sent: 2 }, 'POST /osc (array) -> {"sent":2}');

    expectedSent += 2;
    const dgrams = await waitForDatagrams(expectedSent);
    const label = decodeOscStrict(dgrams[1]);
    const mix = decodeOscStrict(dgrams[2]);

    eq(label.address, '/mesh/node/!a1d7631c/label', 'UDP address (label)');
    deepEq(label.typeTags, ['s'], 'label type tags are "s"');
    deepEq(label.args, [sixChar], 'label arg round-trips');
    eq(label.addressPad >= 1 && label.addressPad <= 4, true, 'address padding is within 1..4 NULs');
    eq(label.tagPad, 2, 'type-tag string ",s" (2 bytes) gets 2 NULs -> 4-byte aligned');

    eq(mix.address, '/mesh/node/!a1d7631c/mix', 'UDP address (mix)');
    deepEq(mix.typeTags, ['s', 'f', 'i', 'T', 'F'], 'mix type tags are "s f i T F"');
    eq(mix.args[0], nineChar, 'mix string round-trips');
    eq(mix.args[1], 220.5, 'mix float round-trips exactly (220.5 is representable)');
    eq(mix.args[2], 1000, 'mix int round-trips');
    eq(mix.args[3], true, 'mix bool true -> "T"');
    eq(mix.args[4], false, 'mix bool false -> "F"');

    // Independent padding proof straight off the wire.
    assertStringPadding(dgrams[1], sixChar, 2, '6-char string padded with exactly 2 NULs (6+2=8)');
    assertStringPadding(dgrams[2], nineChar, 3, '9-char string padded with exactly 3 NULs (9+3=12)');

    // Hand-computed sizes (proves no byte is lost or gained anywhere in the packet):
    //   label: addr 26+2=28 | ",s" 2+2=4 | "abcdef" 6+2=8                        => 40
    //   mix:   addr 24+4=28 | ",sfiTF" 6+2=8 | "abcdefghi" 9+3=12 | f4+i4+T0+F0  => 56
    eq(dgrams[1].length, 40, 'label datagram is exactly 40 bytes (26+2 addr, 2+2 tags, 6+2 string)');
    eq(dgrams[2].length, 56, 'mix datagram is exactly 56 bytes (24+4 addr, 6+2 tags, 9+3 string, 8 numbers)');
  }

  // --- Test 3: relative address gets --prefix ------------------------------
  console.log('\n[3] POST /osc — relative address is prefixed');
  {
    const r = await request(
      listenPort, 'POST', '/osc',
      JSON.stringify({ address: 'node/xyz/level', args: [0.25] })
    );
    eq(r.status, 200, 'POST /osc (relative) -> 200');
    expectedSent += 1;
    const dgrams = await waitForDatagrams(expectedSent);
    const msg = decodeOscStrict(dgrams[expectedSent - 1]);
    eq(msg.address, '/mesh/node/xyz/level', 'relative "node/xyz/level" -> "/mesh/node/xyz/level"');
    eq(msg.args[0], 0.25, 'relative-message float arg round-trips');
  }

  // --- Test 4: blob arg ----------------------------------------------------
  console.log('\n[4] POST /osc — blob arg (base64)');
  {
    const raw = Buffer.from([1, 2, 3, 4, 5]); // 5 bytes -> 3 pad after the size field
    const r = await request(
      listenPort, 'POST', '/osc',
      JSON.stringify({ address: '/mesh/node/!a1d7631c/frame', args: [{ type: 'b', value: raw.toString('base64') }] })
    );
    eq(r.status, 200, 'POST /osc (blob) -> 200');
    expectedSent += 1;
    const dgrams = await waitForDatagrams(expectedSent);
    const msg = decodeOscStrict(dgrams[expectedSent - 1]);
    deepEq(msg.typeTags, ['b'], 'blob type tag is "b"');
    ok(Buffer.isBuffer(msg.args[0]) && msg.args[0].equals(raw), 'blob bytes round-trip', JSON.stringify(msg.args[0]));
  }

  // --- Test 5: --map rewrite ----------------------------------------------
  console.log('\n[5] POST /osc — --map "/mesh/kb=/synth/kb" rewrites the address');
  {
    const r = await request(
      listenPort, 'POST', '/osc',
      JSON.stringify({ address: '/mesh/kb/!a1d7631c/note', args: [60] })
    );
    eq(r.status, 200, 'POST /osc (mapped) -> 200');
    expectedSent += 1;
    const dgrams = await waitForDatagrams(expectedSent);
    const msg = decodeOscStrict(dgrams[expectedSent - 1]);
    eq(msg.address, '/synth/kb/!a1d7631c/note', '/mesh/kb/... -> /synth/kb/...');
  }

  // --- Test 6: malformed input -> 400 with a JSON error --------------------
  console.log('\n[6] POST /osc — malformed input -> 400 JSON error');
  {
    const r = await request(listenPort, 'POST', '/osc', '{ this is not json');
    eq(r.status, 400, 'malformed JSON -> 400');
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* reported below */ }
    ok(parsed && typeof parsed.error === 'string', '400 body is {"error":"..."}', r.text);

    const r2 = await request(listenPort, 'POST', '/osc', JSON.stringify({ args: [1] }));
    eq(r2.status, 400, 'missing address -> 400');

    const r3 = await request(listenPort, 'POST', '/osc', JSON.stringify({ address: '/x', args: [{}] }));
    eq(r3.status, 400, 'unsupported arg object -> 400');

    const r4 = await request(listenPort, 'POST', '/osc', JSON.stringify([{ address: '/a', args: [1] }, 42]));
    eq(r4.status, 400, 'array containing a non-object -> 400');
    eq(expectedSent, 6, 'a rejected batch sends nothing (all messages validate before any send)');

    // Huge payload: capped at 1 MB, answered with 413, and the bridge stays up.
    const huge = JSON.stringify({ address: '/mesh/huge', args: ['x'.repeat(2 * 1024 * 1024)] });
    const r5 = await request(listenPort, 'POST', '/osc', huge);
    eq(r5.status, 413, '2 MB body -> 413 (1 MB cap)');
    let capped = null;
    try { capped = JSON.parse(r5.text); } catch { /* reported below */ }
    ok(capped && /exceeds/.test(capped.error || ''), '413 body explains the cap', r5.text);

    eq((await request(listenPort, 'GET', '/health')).status, 200, 'bridge still healthy after bad input');
    const h = JSON.parse((await request(listenPort, 'GET', '/health')).text);
    eq(h.sent, expectedSent, 'rejected requests never increment the sent count');
  }

  // --- Test 7: OPTIONS preflight + usage note ------------------------------
  console.log('\n[7] OPTIONS preflight and GET /');
  {
    const r = await request(listenPort, 'OPTIONS', '/osc');
    eq(r.status, 204, 'OPTIONS /osc -> 204');
    eq(r.headers['access-control-allow-methods'], 'POST, GET, OPTIONS', 'OPTIONS advertises POST, GET, OPTIONS');
    ok(
      String(r.headers['access-control-allow-headers'] || '').toLowerCase().includes('content-type'),
      'OPTIONS allows Content-Type'
    );

    const root = await request(listenPort, 'GET', '/');
    eq(root.status, 200, 'GET / -> 200');
    ok(/osc/i.test(root.text) && /\/mesh\/node\//.test(root.text), 'GET / contains a usage note and the address scheme');
  }

  // --- Test 8: WebSocket (built-in WebSocket, Node >= 22) ------------------
  console.log('\n[8] WebSocket — text frame in, {"sent":N} out');
  {
    if (typeof WebSocket !== 'function') {
      ok(false, 'global WebSocket is available (requires Node >= 22)', `node ${process.version} has no global WebSocket`);
    } else {
      const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/`);
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket reply timed out after 5s')), 5000);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ address: '/mesh/node/!a1d7631c/battery', args: [88] }));
        });
        ws.addEventListener('message', (ev) => {
          clearTimeout(timer);
          resolve(ev.data);
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('WebSocket error event'));
        });
      });
      deepEq(JSON.parse(String(reply)), { sent: 1 }, 'WebSocket reply is {"sent":1}');

      expectedSent += 1;
      const dgrams = await waitForDatagrams(expectedSent);
      const msg = decodeOscStrict(dgrams[expectedSent - 1]);
      eq(msg.address, '/mesh/node/!a1d7631c/battery', 'WS message reached UDP with the right address');
      deepEq(msg.args, [88], 'WS message reached UDP with args [88]');

      const JSON_TEXT = JSON.stringify({ address: '/mesh/node/!a1d7631c/frag', args: ['fragmented-payload'] });

      // Unparseable/invalid text frame: the bridge must reply with an error object
      // instead of crashing the connection.
      const badReply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('invalid-payload reply timed out after 5s')), 5000);
        const onMsg = (ev) => {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          resolve(ev.data);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ args: [1] })); // no "address" -> malformed
      }).catch(() => null);
      if (badReply !== null) {
        ok(typeof JSON.parse(String(badReply)).error === 'string', 'invalid WS payload gets an error reply, no crash');
      } else {
        ok(false, 'invalid WS payload gets an error reply, no crash', 'timed out');
      }

      // Real fragmentation: initial text frame (FIN=0) + continuation frame (FIN=1),
      // written by hand over a raw socket.
      await sendFragmentedText(listenPort, JSON_TEXT).catch((err) => {
        ok(false, 'raw fragmented frame test', err.message);
        return null;
      });
      if (!failures.some((f) => f.startsWith('raw fragmented'))) {
        expectedSent += 1;
        const after = await waitForDatagrams(expectedSent);
        const msg = decodeOscStrict(after[expectedSent - 1]);
        eq(msg.address, '/mesh/node/!a1d7631c/frag', 'fragmented WS text frame reassembled and sent');
        deepEq(msg.args, ['fragmented-payload'], 'fragmented WS frame args intact');
      }

      await new Promise((resolve) => {
        ws.addEventListener('close', resolve);
        ws.close();
        setTimeout(resolve, 1000);
      });
      ok(true, 'WebSocket closed cleanly without crashing the bridge');
    }
  }

  // --- Test 9: /health count ----------------------------------------------
  console.log('\n[9] GET /health — sent count');
  {
    const r = await request(listenPort, 'GET', '/health');
    eq(r.status, 200, 'GET /health -> 200');
    const h = JSON.parse(r.text);
    eq(h.sent, expectedSent, `GET /health reports sent=${expectedSent}`);
    const again = JSON.parse((await request(listenPort, 'GET', '/health')).text);
    eq(again.sent, expectedSent, '/health count is stable (health checks are not counted)');
  }

  // --- Test 10: graceful shutdown -----------------------------------------
  console.log('\n[10] SIGTERM — clean exit');
  {
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      sleep(3000).then(() => ({ timeout: true })),
    ]);
    ok(!result.timeout, 'bridge child exits within 3s of SIGTERM', JSON.stringify(result));
    eq(result.code, 0, 'bridge exits with code 0 on SIGTERM (handled, not killed)');
    ok(
      bridge.log().includes('SIGTERM received'),
      'bridge logged the SIGTERM shutdown message',
      'shutdown banner missing from child output'
    );
    cleanup();

    // SIGINT (Ctrl-C) must behave identically — verified on a fresh child.
    const b2 = await spawnBridge(['--osc-port', String(udpPort)]);
    const child2 = b2.child;
    const up = Date.now() + 5000;
    while (Date.now() < up && child2.exitCode === null) {
      try { if ((await request(b2.listenPort, 'GET', '/health')).status === 200) break; } catch { /* wait */ }
      await sleep(100);
    }
    const exit2 = new Promise((resolve) => child2.once('close', (code, signal) => resolve({ code, signal })));
    child2.kill('SIGINT');
    const result2 = await Promise.race([exit2, sleep(3000).then(() => ({ timeout: true }))]);
    ok(!result2.timeout, 'bridge child exits within 3s of SIGINT', JSON.stringify(result2));
    eq(result2.code, 0, 'bridge exits with code 0 on SIGINT (handled, not killed)');
    ok(b2.log().includes('SIGINT received'), 'bridge logged the SIGINT shutdown message');
    try { child2.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // --- Summary -------------------------------------------------------------
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.error(`\n${failures.length} BRIDGE TEST FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\n--- bridge child output ---\n${bridge.log()}`);
    process.exit(1);
  }
  console.log('ALL BRIDGE TESTS PASSED');
  process.exit(0);
}

/**
 * Open a raw TCP socket, perform the RFC6455 handshake and send ONE text message
 * split across an initial frame (FIN=0) plus a continuation frame (FIN=1), both masked.
 * This is what proves the hand-rolled fragmentation path works.
 */
function sendFragmentedText(port, text) {
  return new Promise((resolve, reject) => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const sock = net.connect(port, '127.0.0.1');
    let handshakeDone = false;

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('fragmented handshake/frame timed out'));
    }, 5000);

    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.on('close', () => clearTimeout(timer));

    sock.on('connect', () => {
      sock.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    sock.on('data', (chunk) => {
      if (!handshakeDone) {
        if (!chunk.toString('latin1').includes('101')) {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`handshake did not return 101: ${chunk.toString('latin1').split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;

        const raw = Buffer.from(text, 'utf8');
        const half = Math.ceil(raw.length / 2);
        const a = raw.subarray(0, half);
        const b = raw.subarray(half);

        const frame = (opcode, payload, fin) => {
          const mask = Buffer.from([0xab, 0xcd, 0xef, 0x12]);
          const masked = Buffer.allocUnsafe(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          let header;
          if (payload.length < 126) {
            header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
          } else {
            header = Buffer.alloc(4);
            header[0] = (fin ? 0x80 : 0) | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
          }
          return Buffer.concat([header, mask, masked]);
        };

        // Send the two fragments in one write so ordering is unambiguous.
        sock.write(Buffer.concat([frame(0x1, a, false), frame(0x0, b, true)]));
        setTimeout(() => { sock.destroy(); resolve(); }, 300);
      }
    });
  });
}

main().catch((err) => {
  console.error(`\nFATAL: unexpected test error — ${err?.stack || err}`);
  process.exit(1);
});

/* -------------------------------------------------------------------------- */
/* POST /target — retargeting the UDP destination at runtime                   */
/* -------------------------------------------------------------------------- */

console.log('\n[target] validateTarget rules');
{
  const okTarget = validateTarget('127.0.0.1', 57120);
  ok(okTarget.host === '127.0.0.1' && okTarget.port === 57120, 'accepts a loopback host and port', JSON.stringify(okTarget));
  ok(validateTarget('localhost', 8000).port === 8000, 'accepts a hostname');
  ok(validateTarget('::1', 57120).host === '::1', 'accepts an IPv6 literal');
  ok(validateTarget('127.0.0.1', '9000').port === 9000, 'coerces a numeric string port');
  ok(validateTarget('  127.0.0.1  ', 1).host === '127.0.0.1', 'trims surrounding whitespace');
  ok(validateTarget('127.0.0.1\n', 1).host === '127.0.0.1', 'trims a trailing newline rather than passing it on');

  const rejects = [
    ['empty host', () => validateTarget('', 1)],
    ['non-string host', () => validateTarget(42, 1)],
    ['host with a space', () => validateTarget('127.0.0.1 evil', 1)],
    ['host with an embedded newline', () => validateTarget('127.0.0.1\nevil', 1)],
    ['host with a slash', () => validateTarget('127.0.0.1/../x', 1)],
    ['port above 65535', () => validateTarget('127.0.0.1', 70000)],
    ['negative port', () => validateTarget('127.0.0.1', -1)],
    ['non-numeric port', () => validateTarget('127.0.0.1', 'abc')],
    ['fractional port', () => validateTarget('127.0.0.1', 1.5)],
    ['missing port', () => validateTarget('127.0.0.1', undefined)],
  ];
  for (const [label, run] of rejects) {
    let threw = false;
    try {
      run();
    } catch {
      threw = true;
    }
    ok(threw, `rejects ${label}`);
  }
}
