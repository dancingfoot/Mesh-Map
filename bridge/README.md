# Mesh Map bridges

Two small local Node bridges for the Mesh-Map dashboard: an **OSC bridge** (below)
and an **MQTT ingest bridge** ([further down](#mqtt-ingest-bridge)). Both exist because
a browser cannot open raw TCP or UDP sockets itself.

## OSC Bridge

A tiny, **zero-dependency** OSC 1.0 bridge for the Mesh-Map dashboard.

The dashboard runs in a browser and browsers cannot open UDP sockets. This local Node
process accepts JSON over **HTTP POST** or a **WebSocket** (both on the same port),
encodes real **OSC 1.0** packets itself, and forwards them over UDP to any OSC
receiver — SuperCollider, TouchDesigner, Max, Pd, Pure Data, a microcontroller, etc.

Requires **Node >= 20** (the test additionally uses the built-in `WebSocket`, i.e.
Node >= 22; Node 24 recommended). No npm packages, no `npm install`.

## Run it

```bash
npm run bridge                 # listens on 127.0.0.1:9000, sends to 127.0.0.1:57120
node bridge/osc-bridge.mjs --help
node bridge/osc-bridge.mjs --listen 9100 --osc-host 192.168.1.50 --osc-port 8000
node bridge/osc-bridge.mjs --map /mesh=/synth --verbose
node bridge/osc-bridge.mjs --dry-run          # encode + log, send nothing
```

### CLI

| Option | Default | Meaning |
| --- | --- | --- |
| `--listen <port>` | `9000` | HTTP/WebSocket port (`0` = OS-assigned) |
| `--bind <addr>` | `127.0.0.1` | bind address |
| `--osc-host <host>` | `127.0.0.1` | UDP target host |
| `--osc-port <port>` | `57120` | UDP target port (SuperCollider's default) |
| `--prefix <path>` | `/mesh` | prefix applied to addresses that don't start with `/` |
| `--map <a=b,c=d>` | – | address rewrite rules, applied after prefixing |
| `--dry-run` | off | log OSC messages instead of sending |
| `--verbose` | off | log every message |
| `--help` | – | usage |

Options also accept `--opt=value` form. Startup prints a banner with the listen
address and the OSC target. `SIGINT`/`SIGTERM` shut down cleanly.

## Address scheme

```
/mesh/node/<nodeId>/<metric>
```

Examples: `/mesh/node/!a1d7631c/battery`, `/mesh/node/!a1d7631c/rssi`,
`/mesh/node/!a1d7631c/position`.

An `address` that does **not** start with `/` is treated as relative and gets the
prefix prepended:

```
"node/xyz/level"  ->  "/mesh/node/xyz/level"
```

`--map` rewrites addresses after prefixing. A rule matches the exact address or the
address followed by `/`, and replaces that leading segment:

```bash
--map /mesh=/synth        # /mesh/node/x/battery -> /synth/node/x/battery
--map /mesh/kb=/synth/kb  # /mesh/kb/1/note     -> /synth/kb/1/note
```

## HTTP contract

Both endpoints are permissively CORS-enabled (`Access-Control-Allow-Origin: *`,
`POST, GET, OPTIONS`, `Content-Type`, `OPTIONS` → `204`), so the dashboard can post
from `http://localhost:3000`.

### `POST /osc`

One message, or an array of messages:

```json
{"address": "/mesh/node/!a1d7631c/battery", "args": [87]}
```

```json
[
  {"address": "/mesh/node/!a1d7631c/battery", "args": [87]},
  {"address": "/mesh/node/!a1d7631c/label",   "args": ["abcdef", 220.5, true]}
]
```

Reply: `200 {"sent":N}`. Malformed JSON, a missing `address`, or an unsupported arg
type gives `400 {"error":"..."}`. A body over 1 MB gives `413`. `args` is optional
and defaults to `[]`.

Arg mapping (JSON → OSC type tag):

| JSON | OSC tag |
| --- | --- |
| integer in int32 range | `i` |
| integer outside int32 range | `h` (int64) |
| other number | `f` (float32) |
| string | `s` |
| `true` / `false` | `T` / `F` |
| `{"type":"b","value":"<base64>"}` | `b` |

### `GET /health`

```json
{"ok":true,"oscTarget":"127.0.0.1:57120","sent":123,"uptime":12.3}
```

`sent` counts messages handed to the OS; `/health` and `/` requests never increment it.

### `GET /`

Short plain-text usage note.

### curl

```bash
curl -s http://127.0.0.1:9000/health
curl -s -X POST http://127.0.0.1:9000/osc \
  -H 'Content-Type: application/json' \
  -d '{"address":"/mesh/node/!a1d7631c/battery","args":[87]}'

curl -s -X POST http://127.0.0.1:9000/osc \
  -H 'Content-Type: application/json' \
  -d '[{"address":"/mesh/node/a/temp","args":[21.5]},{"address":"/mesh/node/a/tag","args":["abcdefghi",true]}]'
```

## WebSocket contract

Connect to `ws://127.0.0.1:9000/` (any path). The server is a minimal RFC6455
implementation written by hand with `node:crypto` + `node:http` — no `ws` package.

- Each **text** frame is the same JSON shape as the POST body: a single object or an
  array. Fragmented text messages (continuation frames) are reassembled.
- The reply is a text frame: `{"sent":N}`, or `{"error":"..."}` for bad input.
- `ping` is answered with `pong`; binary frames are ignored; `close` is echoed.

```js
const ws = new WebSocket('ws://127.0.0.1:9000/');
ws.onopen = () => ws.send(JSON.stringify({ address: 'node/!a1d7631c/battery', args: [87] }));
ws.onmessage = (e) => console.log(e.data); // {"sent":1}
```

## OSC encoding notes

OSC 1.0: address string, comma-prefixed type-tag string, then 4-byte-aligned
big-endian arguments. **Every string and blob is padded with 1–4 NUL bytes to a
4-byte boundary** (a string of length L takes L + 1..4 bytes; a blob is an int32 byte
count, the bytes, then 0–3 NULs). That padding is the classic bug this bridge is
tested against — `bridge/test-osc-bridge.mjs` decodes the datagrams with an
independent decoder and asserts the exact NUL counts for a 6-char and a 9-char
string.

### What the receiver actually sees

Verified end-to-end against a real UDP listener with a Meshtastic-style batch
(`/mesh/node/!28a9df12/{batteryLevel,voltage,position,rxSNR,rxRSSI,longName}`):

| Sent | Type tag | Received |
| --- | --- | --- |
| `87` | `i` | `87` — exact |
| `-69` | `i` | `-69` — exact |
| `4.02` | `f` | `4.02` |
| `37.7749` | `f` | `37.774898529052734` |
| `"Sim Ridge Relay"` | `s` | `Sim Ridge Relay` — exact |
| `[37.7749, -122.4194, 42.5, 38]` | `fffi` | 4 args, tags `fffi` |

**Floats are IEEE-754 single precision (32-bit) — that is OSC 1.0, not a bridge
limitation.** A latitude of `37.7749` therefore arrives as `37.774898529052734`
(≈ 1e-5 degrees, roughly 1 m). If your receiver needs more precision, send the value
as a string, or in a scaled integer form as an int64 (`h`) — OSC 1.0 has no double
type.

## Tests

```bash
npm run test:bridge
```

Starts the bridge as a child process on an OS-assigned ephemeral port
(`--listen 0`), with a UDP listener the test creates itself, then exercises POST
(single + array), the address prefix, blobs, `--map`, `400`/`413` handling, CORS
preflight, WebSocket (including a hand-written fragmented frame) and `/health`. It
decodes every datagram with an independent decoder and asserts exact byte lengths
for the 6-char and 9-char padding cases. It prints `ALL BRIDGE TESTS PASSED` on
success and exits non-zero with the failing checks otherwise.

## Receiving

**SuperCollider** — scsynth's default OSC port is 57120, so with default settings
just evaluate:

```supercollider
s.boot;
// /mesh/node/!a1d7631c/battery with one int arg -> control bus 0, or:
OSCdef(\battery, { |msg| msg.postln }, '/mesh/node/!a1d7631c/battery');
// Whole-tree listener while you explore the address space:
OSCdef(\meshAll, { |msg| msg.postln }, '/mesh');
```

Note that `OSCdef` patterns match by address prefix, so `'/mesh'` catches everything.

**TouchDesigner** — add an **OSC In DAT** (or CHOP) with Network Port `57120`,
activate it, and its Address column receives `/mesh/node/...`. To read a metric into
a channel, use an **OSC In CHOP** and set its *OSC Address Scope* to
`/mesh/node/!a1d7631c/*`. Set the bridge's `--osc-host` to the machine running
TouchDesigner if it isn't local.

**Max / Pd** — `udpreceive 57120` → `oscparse` (Max) or `netreceive -u -b 57120` (Pd).

## Deliberately not included

No OSC bundles, timetags, `d`/`S`/`c`/`r`/`m` type tags, no OSC 1.1 features, no TCP
OSC transport, no message queuing/retry (UDP is fire-and-forget), no auth/TLS, and
no `--osc-port 0` discovery. There is no browser-side client here — the dashboard
component lives under `src/`. The WebSocket server implements only what the
contract above needs.

---

# MQTT ingest bridge

`bridge/mqtt-bridge.mjs` subscribes to an MQTT broker and relays every message to the
dashboard over **Server-Sent Events**. It exists for the same reason as the OSC bridge:
a browser cannot open a raw TCP connection to a broker's port 1883/8883. Credentials
live in the bridge (never in the page), the subscription runs whether or not the tab is
open, and the relay is a plain HTTP `GET /stream`.

It speaks **MQTT 3.1.1** itself, so it needs no `mqtt` package and the AppImage ships no
`node_modules`. Unknown topics are still forwarded — the dashboard classifies each
message by topic into a **BirdNET-Pi**, **Meshtastic** or **weather-station** feed.

## Run it

```sh
npm run bridge:mqtt                       # HTTP + SSE on 127.0.0.1:9300
node bridge/mqtt-bridge.mjs --help
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--listen <port>` | HTTP/SSE port for the dashboard | `9300` |
| `--bind <host>` | bind address | `127.0.0.1` |
| `--config <path>` | JSON file the broker config is read from and persisted to | `bridge/mqtt-config.json` |
| `--launch-mosquitto` | also spawn a local `mosquitto -c bridge/mosquitto.example.conf` if installed | off |

Start the **first** instance with `--launch-mosquitto` to get a local broker with no
system setup; otherwise point it at any broker you already run.

## Broker

Any MQTT 3.1.1 broker works; **Mosquitto** is the usual choice.

```sh
sudo apt install mosquitto            # Debian/Ubuntu
mosquitto -c bridge/mosquitto.example.conf
```

`bridge/mosquitto.example.conf` listens on `1883` (MQTT) and `9001` (WebSockets),
allows anonymous clients, and enables persistence — intended for a trusted LAN, so add
a password file and TLS before exposing it. For a broker **without** Mosquitto, use the
bundled real-broker fixture:

```sh
npm run broker:test                   # aedes on an ephemeral port, publishing samples every 1.5s
```

## Topics

The dashboard subscribes to three wildcard-capable topics, editable in the **MQTT** tab:

| Source | Default topic | Notes |
| --- | --- | --- |
| BirdNET-Pi | `birdnet/detections` | BirdNET-Pi's MQTT output; `common_name`, `scientific_name`, `confidence`, `image` |
| Meshtastic | `msh/+/json` | Meshtastic's JSON MQTT gateway (`+` matches the channel) |
| Weather station | `weather/#` | e.g. `weather/station/1`; `temperature`, `humidity`, `pressure`, … |

`+` matches exactly one topic level and `#` everything below it; the dashboard uses the
same rules to decide which feed a message belongs to.

## HTTP contract

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | `{ok, connected, host, port, messages, uptime}` |
| `/config` | `GET` | the active config (password omitted from the reply) |
| `/config` | `POST` | `{broker, topics}` — validated (400 on a bad port/host), persisted, applied live |
| `/stream` | `GET` | `text/event-stream` of `data: {…}` frames |

Each SSE frame is a JSON object:

```jsonc
{ "type": "status",  "connected": true, "host": "127.0.0.1", "port": 1883, "error": null, "receivedAt": 1767225600000 }
{ "type": "config",  "config": { "broker": { … }, "topics": { … } } }
{ "type": "message", "topic": "birdnet/detections", "payloadText": "{\"common_name\":\"Eurasian Wren\"}", "receivedAt": 1767225600123 }
```

The stream starts with `retry: 3000` and a comment `: ping` every 15s, so a browser
`EventSource` reconnects on its own. A `POST /config` that does not actually change the
broker or topics will **not** disturb the live connection.

## Tests

```sh
npm run test:mqtt                     # codec + mock broker + HTTP/SSE, then the real aedes broker
node bridge/test-broker.mjs --publish # run the fixture broker on its own
```

`bridge/test-broker.mjs` wraps [`aedes`](https://github.com/moscajs/aedes) — a real,
independent MQTT 3.1.1 broker. The suite runs the bridge against it as well as against a
hand-rolled mock, because a mock that shares the bridge's framing assumptions cannot
catch a malformed packet (the aedes pass is what proves the CONNECT/SUBSCRIBE bytes are
actually valid).

## Deliberately not included

No MQTT 5 features, no QoS 2, no retained-message replay on subscribe, no TLS client
certificates, no `$SYS` handling, and no auth beyond username/password. The bridge
relays messages verbatim — parsing into the three feeds happens in the browser
(`src/utils/mqttParse.ts`).
