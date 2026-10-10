// Tests for bridge/mqtt-bridge.mjs — the MQTT 3.1.1 codec and the client against a
// hand-rolled mock broker, plus the HTTP/SSE surface. Plain node, no framework.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeConnectPacket,
  encodeSubscribePacket,
  encodePingreqPacket,
  encodeRemainingLength,
  decodeRemainingLength,
  decodePublishPacket,
  mqttPacketType,
  mqttPacketBoundary,
  sanitiseConfig,
  createMqttBridge,
} from './mqtt-bridge.mjs';

let passed = 0;
const failures = [];
function ok(condition, label, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function deepEq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/** Polls until the predicate is true (CONNACK and SUBSCRIBE are asynchronous). */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

console.log('\n[codec]');
{
  const rl = encodeRemainingLength(321);
  deepEq([...rl], [0xc1, 0x02], 'encodes remaining length 321');
  deepEq(decodeRemainingLength(Buffer.from([0xc1, 0x02]), 0), { value: 321, length: 2 }, 'decodes remaining length 321');
  eq(encodeRemainingLength(0)[0], 0, 'encodes zero');

  const connect = encodeConnectPacket({ clientId: 'abc', username: 'u', password: 'p', keepalive: 30 });
  eq(mqttPacketType(connect[0]), 1, 'CONNECT packet type');
  ok(connect.toString('utf8', 2, 8).includes('MQTT'), 'CONNECT carries the MQTT protocol name');

  const sub = encodeSubscribePacket(0x0001, [{ topic: 'a/b', qos: 0 }, { topic: 'c/#', qos: 1 }]);
  eq(mqttPacketType(sub[0]), 8, 'SUBSCRIBE packet type');
  ok(sub.toString('utf8').includes('a/b'), 'SUBSCRIBE carries the topic');

  eq(mqttPacketType(encodePingreqPacket()[0]), 12, 'PINGREQ packet type');
}

console.log('\n[decode PUBLISH]');
{
  const topic = Buffer.from('birdnet/detections');
  const payload = Buffer.from('{"x":1}');
  const body = Buffer.concat([Buffer.from([topic.length >> 8, topic.length & 0xff]), topic, payload]);
  const packet = Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);

  const decoded = decodePublishPacket(packet);
  eq(decoded.topic, 'birdnet/detections', 'decodes topic');
  eq(decoded.qos, 0, 'decodes qos 0');
  eq(decoded.payload.toString('utf8'), '{"x":1}', 'decodes payload');
  eq(decoded.packetId, null, 'no packet id for qos 0');

  const body1 = Buffer.concat([Buffer.from([topic.length >> 8, topic.length & 0xff]), topic, Buffer.from([0x00, 0x2a]), payload]);
  const packet1 = Buffer.concat([Buffer.from([0x32]), encodeRemainingLength(body1.length), body1]);
  const d1 = decodePublishPacket(packet1);
  eq(d1.qos, 1, 'decodes qos 1');
  eq(d1.packetId, 42, 'decodes packet id');
}

console.log('\n[framing]');
{
  const topic = Buffer.from('t');
  const body = Buffer.concat([Buffer.from([0, 1]), topic, Buffer.from('hi')]);
  const pkt = Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
  eq(mqttPacketBoundary(pkt), pkt.length, 'reports a complete packet length');
  eq(mqttPacketBoundary(pkt.subarray(0, 2)), 0, 'waits for a partial packet');
  eq(mqttPacketBoundary(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0xff])), -1, 'flags a malformed length (5 continuation bytes)');
  eq(mqttPacketBoundary(Buffer.concat([pkt, pkt])), pkt.length, 'finds the first of two packets');
}

console.log('\n[config]');
{
  const clean = sanitiseConfig({ broker: { host: '  localhost ', port: 8883, tls: true, username: 'u', password: 'p' }, topics: { birdnet: 'b/#', meshtastic: '', weather: 'w/+' } });
  eq(clean.broker.host, 'localhost', 'trims the host');
  eq(clean.broker.port, 8883, 'keeps a valid port');
  eq(clean.topics.birdnet, 'b/#', 'keeps a wildcard topic');
  eq(clean.topics.meshtastic, 'msh/+/json', 'falls back to the default topic when blank');
  eq(sanitiseConfig({ broker: { port: 999999 } }).broker.port, 1883, 'rejects an out-of-range port');
  eq(sanitiseConfig(null).broker.host, '127.0.0.1', 'sanitises null to defaults');
}

/**
 * A tiny MQTT 3.1.1 broker. The returned `broker` buffers publishes until the
 * client connects, which removes any ordering dependency in the tests.
 */
async function startMockBroker() {
  const broker = {
    subscriptions: [],
    socket: null,
    pending: [],
    publish(topic, payload, qos = 0, packetId = 1) {
      const build = () => {
        const t = Buffer.from(topic);
        let body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t]);
        if (qos > 0) body = Buffer.concat([body, Buffer.from([packetId >> 8, packetId & 0xff])]);
        body = Buffer.concat([body, Buffer.from(payload)]);
        const header = 0x30 | (qos << 1);
        return Buffer.concat([Buffer.from([header]), encodeRemainingLength(body.length), body]);
      };
      if (this.socket) this.socket.write(build());
      else this.pending.push(build());
    },
  };

  const server = net.createServer((socket) => {
    broker.socket = socket;
    for (const p of broker.pending.splice(0)) socket.write(p);

    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      while (true) {
        const boundary = mqttPacketBoundary(received);
        if (boundary === 0) break;
        if (boundary < 0) return socket.destroy();
        const packet = received.subarray(0, boundary);
        received = received.subarray(boundary);
        const type = mqttPacketType(packet[0]);
        if (type === 1) {
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK
        } else if (type === 8) {
          const rl = decodeRemainingLength(packet, 1);
          const packetId = packet.readUInt16BE(1 + rl.length);
          let cursor = 1 + rl.length + 2;
          while (cursor < 1 + rl.length + rl.value) {
            const tlen = packet.readUInt16BE(cursor); cursor += 2;
            const topic = packet.toString('utf8', cursor, cursor + tlen); cursor += tlen;
            broker.subscriptions.push({ topic, qos: packet[cursor] }); cursor += 1;
          }
          socket.write(Buffer.from([0x90, 0x03, packetId >> 8, packetId & 0xff, 0x00])); // SUBACK
        } else if (type === 12) {
          socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
        }
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, broker };
}

console.log('\n[mock broker]');
{
  const mock = await startMockBroker();
  const received = [];
  const bridge = createMqttBridge({
    config: { broker: { host: '127.0.0.1', port: mock.port, tls: false, username: '', password: '', keepalive: 60 }, topics: { birdnet: 'birdnet/detections', meshtastic: 'msh/+/json', weather: 'weather/#' } },
    configPath: '/tmp/mqtt-test-config.json',
    log: () => {},
    listen: 0,
  });
  await bridge.listen();
  await bridge.start();
  await waitFor(() => bridge.connection.connected);

  const conn = bridge.connection;
  conn.onMessage = (topic, payload) => received.push({ topic, payload: payload.toString('utf8') });

  ok(conn.connected, 'client connects and receives CONNACK');
  eq(conn.subscribedTopics.size, 3, 'subscribes to all three topics');
  eq(mock.broker.subscriptions.length, 3, 'broker received three SUBSCRIBE topics');

  mock.broker.publish('birdnet/detections', '{"common_name":"Eurasian Wren"}', 0);
  await new Promise((r) => setTimeout(r, 200));
  eq(received.length, 1, 'a QoS 0 PUBLISH reaches the client');
  deepEq(received[0], { topic: 'birdnet/detections', payload: '{"common_name":"Eurasian Wren"}' }, 'topic and payload are intact');

  mock.broker.publish('msh/2/json', '{"from":123}', 1, 7);
  await new Promise((r) => setTimeout(r, 200));
  eq(received.length, 2, 'a QoS 1 PUBLISH reaches the client');
  eq(received[1].topic, 'msh/2/json', 'QoS 1 topic decoded');

  await bridge.close();
  mock.server.close();
  eq(conn.closed, true, 'close() stops the client cleanly');
}

console.log('\n[http/sse]');
{
  const mock = await startMockBroker();
  const bridge = createMqttBridge({
    config: { broker: { host: '127.0.0.1', port: mock.port, tls: false, username: '', password: '', keepalive: 60 }, topics: { birdnet: 'b', meshtastic: 'm', weather: 'w' } },
    configPath: '/tmp/mqtt-test-config.json',
    log: () => {},
    listen: 0,
  });
  const addr = await bridge.listen();
  const base = `http://127.0.0.1:${addr.port}`;

  const health = await (await fetch(`${base}/health`)).json();
  ok(health.ok === true && health.host === '127.0.0.1', 'GET /health reports the broker');

  const before = await (await fetch(`${base}/config`)).json();
  deepEq(before.topics, { birdnet: 'b', meshtastic: 'm', weather: 'w' }, 'GET /config returns the topics');

  const sse = await fetch(`${base}/stream`);
  const reader = sse.body.getReader();
  const events = [];
  const collect = async () => {
    let buffer = '';
    try {
      // The bridge also emits a status event on connect, so stop on the message
      // rather than on a fixed event count.
      while (!events.some((e) => e.type === 'message')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* stream cancelled */ }
    try { await reader.cancel(); } catch { /* closed */ }
  };

  const collecting = collect();
  await bridge.start();
  await waitFor(() => bridge.connection.connected);
  mock.broker.publish('birdnet/#', '{"n":1}');
  await Promise.race([collecting, new Promise((r) => setTimeout(r, 3000))]);
  ok(events.some((e) => e.type === 'message'), 'SSE stream delivers a message event');
  ok(events.some((e) => e.type === 'config'), 'SSE stream delivers the config event');
  ok(events.some((e) => e.type === 'status'), 'SSE stream delivers a status event');

  const changed = await (await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ broker: { host: 'broker.local', port: 8883, tls: true }, topics: { birdnet: 'birdnet/#' } }),
  })).json();
  eq(changed.ok, true, 'POST /config accepts a new broker');
  eq(changed.config.broker.host, 'broker.local', 'config persists in the bridge');

  const bad = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broker":{"port":"nope"}}',
  });
  eq(bad.status, 400, 'POST /config rejects a malformed config');

  await bridge.close();
  mock.server.close();
}

/**
 * The integration above uses a hand-rolled mock, which shares the bridge's own
 * framing assumptions and so cannot catch a malformed packet. This section runs
 * the bridge against `aedes` — an independent MQTT 3.1.1 broker — so a broken
 * CONNECT/SUBSCRIBE or a dropped TLS/keepalive expectation fails loudly here.
 */
async function testAgainstRealBroker() {
  console.log('\n[real broker: aedes]');
  const dir = await mkdtemp(join(tmpdir(), 'meshmap-mqtt-'));
  const configPath = join(dir, 'config.json');
  const broker = spawn(process.execPath, [new URL('./test-broker.mjs', import.meta.url).pathname, '--publish', '--quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const brokerPort = await new Promise((resolve, reject) => {
    let out = '';
    broker.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const line = out.split('\n')[0].trim();
      if (line && /^\d+$/.test(line)) resolve(Number(line));
    });
    broker.on('error', reject);
    setTimeout(() => reject(new Error('aedes broker did not report a port')), 5000).unref();
  });
  ok(Number.isInteger(brokerPort) && brokerPort > 0, 'real broker starts on an ephemeral port', String(brokerPort));

  let bridge;
  try {
    bridge = createMqttBridge({
      config: {
        broker: { host: '127.0.0.1', port: brokerPort, tls: false, username: '', password: '', keepalive: 60 },
        topics: { birdnet: 'birdnet/detections', meshtastic: 'msh/+/json', weather: 'weather/#' },
      },
      configPath,
      listen: 0,
      log: () => {},
    });
    const address = await bridge.listen();
    const base = `http://127.0.0.1:${address.port}`;
    await bridge.start();

    await waitFor(() => bridge.connection.connected, 5000);
    ok(bridge.connection.connected, 'bridge completes the CONNECT/CONNACK handshake with a real broker');
    await waitFor(() => bridge.connection.subscribedTopics.size >= 3, 3000);
    eq(bridge.connection.subscribedTopics.size, 3, 'bridge SUBSCRIBEs to all three topics on a real broker');

    // The fixture publishes every 1.5s; read the SSE stream until a message lands.
    const controller = new AbortController();
    const events = [];
    const reader = (async () => {
      const response = await fetch(`${base}/stream`, { signal: controller.signal });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try { events.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
          }
        }
        if (events.some((e) => e.type === 'message')) break;
      }
    })().catch(() => {});
    await waitFor(() => events.some((e) => e.type === 'message'), 8000);
    controller.abort();
    await reader;

    const message = events.find((e) => e.type === 'message');
    ok(Boolean(message), 'a PUBLISH from a real broker reaches the SSE stream');
    ok(Boolean(message && message.topic), 'the relayed message carries its topic', message?.topic);
    ok(
      typeof message?.payloadText === 'string' && message.payloadText.includes('common_name'),
      'the relayed message preserves the JSON payload',
      message?.payloadText?.slice(0, 60)
    );
    const health = await (await fetch(`${base}/health`)).json();
    ok(health.messages > 0, 'the bridge counts messages received from a real broker', String(health.messages));
    eq(health.connected, true, 'health reports the real-broker connection as live');
  } finally {
    if (bridge) await bridge.close().catch(() => {});
    broker.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await testAgainstRealBroker();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('ALL MQTT BRIDGE TESTS PASSED');
process.exit(0);
