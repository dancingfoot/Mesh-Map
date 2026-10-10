/**
 * A real MQTT broker for tests and local end-to-end checks.
 *
 * Wraps `aedes` (a pure-JS MQTT 3.1.1 broker) so the bridge is exercised against
 * an independent broker implementation rather than a hand-rolled mock that would
 * share the bridge's own assumptions.
 *
 *   node bridge/test-broker.mjs [--port 1883] [--publish] [--quiet]
 *
 * Prints the listening port on the first stdout line; with `--publish` it also
 * emits one BirdNET, one Meshtastic and one weather message every 1.5s so a
 * subscriber has something to receive.
 */
// aedes v1 exports the class as a named export (the old default export throws).
import { Aedes } from 'aedes';
import { createServer } from 'node:net';

const argv = process.argv.slice(2);
const take = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const port = Number(take('--port', 0));
const shouldPublish = argv.includes('--publish');
const quiet = argv.includes('--quiet');

const SAMPLE_MESSAGES = [
  [
    'birdnet/detections',
    {
      common_name: 'Eurasian Wren',
      scientific_name: 'Troglodytes troglodytes',
      confidence: '0.83',
      image: '/img/wren.jpg',
      timestamp: '2026-01-01T08:00:00Z',
    },
  ],
  [
    'msh/2/json',
    {
      from: 123456,
      type: 'telemetry',
      temperature: 21.5,
      relative_humidity: 44,
      battery_level: 100,
      voltage: 4.02,
    },
  ],
  ['weather/station/1', { temperature: 18.4, humidity: 52, pressure: 1015, wind_speed: 3.1, rain: 0 }],
];

// aedes v1: `new Aedes()` never starts listening; the async static factory
// returns a broker that is ready to accept connections.
const aedes = await Aedes.createBroker();
const server = createServer(aedes.handle);

server.listen(port, '127.0.0.1', () => {
  // First line is the port: callers read it to learn the ephemeral port.
  console.log(server.address().port);
  if (!quiet) console.error(`[broker] listening on 127.0.0.1:${server.address().port}`);
});

if (!quiet) {
  aedes.on('client', (client) => console.error(`[broker] client connected: ${client?.id}`));
  aedes.on('clientDisconnect', (client) => console.error(`[broker] client disconnected: ${client?.id}`));
  aedes.on('subscribe', (subscriptions, client) =>
    console.error(`[broker] ${client?.id} subscribed to ${subscriptions.map((s) => s.topic).join(', ')}`)
  );
  aedes.on('publish', (packet, client) => {
    if (client) console.error(`[broker] ${client.id} published to ${packet.topic}`);
  });
  aedes.on('clientError', (client, error) => console.error(`[broker] clientError ${client?.id}: ${error?.message}`));
  aedes.on('connectionError', (client, error) => console.error(`[broker] connectionError ${client?.id}: ${error?.message}`));
  aedes.on('clientReady', (client) => console.error(`[broker] clientReady ${client?.id}`));
}

if (shouldPublish) {
  setTimeout(() => {
    setInterval(() => {
      for (const [topic, payload] of SAMPLE_MESSAGES) {
        aedes.publish(
          { cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain: false },
          () => {}
        );
      }
    }, 1500);
  }, 500);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
