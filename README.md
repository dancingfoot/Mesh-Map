# Mesh Map — Meshtastic Real-Time GPS & Telemetry Dashboard

[![CI](https://github.com/dancingfoot/Mesh-Map/actions/workflows/ci.yml/badge.svg)](https://github.com/dancingfoot/Mesh-Map/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dancingfoot/Mesh-Map?label=download)](https://github.com/dancingfoot/Mesh-Map/releases/latest)

A browser dashboard that reads a Meshtastic node over **Web Serial**, parses
everything the mesh sends — GPS fixes *and* telemetry — and shows it per node on
an interactive Leaflet map. Telemetry can be re-emitted as **OSC** or **MIDI** to
drive music/visual software. Linux builds are published to
[Releases](https://github.com/dancingfoot/Mesh-Map/releases) as an AppImage.

## Quick start

```bash
npm install
npm run dev                # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on :3000 |
| `npm run build` | production bundle in `dist/` |
| `npm run preview` | serve the built bundle |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | vitest unit suite (110 tests) |
| `npm run test:watch` | vitest in watch mode |
| `npm run bridge` | the local OSC bridge (see below) |
| `npm run test:bridge` | bridge self-test (69 checks) |

No radio handy? Click **Start Demo** in the left rail: it streams simulated
Meshtastic JSON, NMEA sentences *and* telemetry (device metrics, environment,
link quality, node info) along a chosen route, so every view has data.

## Connecting a real node

1. Plug the node in over USB.
2. In the left rail pick the port, or press **Scan Hardware** to authorise a new
   device (Chromium browsers only — Web Serial is not available in Firefox or
   Safari).
3. Baud `115200` is the Meshtastic standard.
4. Press **Connect** and pick the device in the browser dialog.

## Views

* **Live Map** — one coloured polyline per node plus start/current markers, with a
  Street/Satellite switch, auto-centre, fit-route, latest-pin and fullscreen
  controls. The header's **time window** selector (All, 1 min, 30 min, 1 h, 3 h,
  6 h, 12 h) filters which packets are displayed.
* **Serial Monitor** — the raw stream, ANSI colour codes stripped, with manual
  line injection.
* **Points Log** — the packet table for the current window.
* **Telemetry** — every non-position field per node (see below).
* **Outputs** — OSC and MIDI emission (see below).

### Nodes panel

Every `node_id` seen in the current window gets a row with:

* a colour swatch (each node gets its own colour, distinct and stable),
* packet count, distance travelled and last-seen age,
* **👁 Visible** — hide/show that node's trace and markers,
* **Solo** — show only that node; press again to return to normal.

**All** / **None** toggle every node at once.

### Telemetry tab

The requirement is *show everything that arrives, per node* — so the parser has no
fixed schema. It flattens whatever key/value data a packet or firmware log line
carries and tags it with a coarse kind: `device`, `power`, `environment`,
`airQuality`, `health`, `localStats`, `position`, `link`, `nodeinfo`, `network`,
`unknown`.

For the selected node you get one card per kind that actually has data, plus an
always-present **Other fields** card so an unfamiliar field is never hidden. Each
metric shows a friendly label, its raw field name, the latest value, a unit when
known (%, V, °C, hPa, dB, dBm, s, ms, kΩ) and an inline-SVG sparkline once two or
more numeric points exist. There is a per-view time window and an **Export CSV**
button covering every sample.

### Outputs tab — OSC

Browsers cannot open UDP sockets, so OSC goes through a small local bridge:

```
browser ──HTTP/WebSocket──► bridge (Node) ──UDP──► SuperCollider / TouchDesigner / Max / Pd
```

```bash
npm run bridge                       # listens on 127.0.0.1:9000, sends to 127.0.0.1:57120
npm run bridge -- --osc-host 192.168.1.50 --osc-port 9000
npm run bridge -- --map /mesh=/synth --verbose
```

See [bridge/README.md](bridge/README.md) for the full CLI, the HTTP/WebSocket
contract and receiver notes. The address scheme is:

```
/mesh/node/<nodeId>/<metric>        e.g. /mesh/node/!a1d7631c/batteryLevel
/mesh/node/<nodeId>/position        lat, lon, altitude, satellites
```

In the dashboard, enable OSC, point it at the bridge URL (default
`http://127.0.0.1:9000`), optionally change the prefix, and use **Health check**
to confirm the bridge is reachable. Live counters show messages sent/failed and
the last error, and a preview lists the exact addresses that will be emitted for
the selected node.

> **OSC 1.0 floats are 32-bit.** A latitude of `37.7749` arrives as
> `37.774898529052734` (≈ 1 m). Send a scaled int64 or a string if you need more
> precision — OSC 1.0 has no double type.

### Outputs tab — MIDI

Uses the **Web MIDI API**, so any OS MIDI port can be targeted — including
virtual ones such as **QMidiNet / RTP-MIDI** on Linux and Windows, or the **IAC
Driver** on macOS. They appear in the port list like any other device; pick one
and press Refresh ports after creating it.

The mapping editor is a table of rules — `metric`, `type` (CC or Note), `CC/note
number`, `channel mode` (per-node channels or fixed), `resolution`, and min/max
for scaling the real value onto the MIDI range. Add or remove rules as needed;
everything is stored in `localStorage`. A **Panic** button sends all-notes-off
and resets controllers.

Web MIDI needs permission: Chrome asks on first use. If it is denied or the
browser has no MIDI support, the panel says so instead of failing silently.

### MQTT tab — live BirdNET / Meshtastic / weather feeds

Browsers cannot open a raw TCP connection to an MQTT broker, so a small local Node
bridge subscribes on your behalf and relays everything to the page over
**Server-Sent Events**. Start it next to the dashboard:

```sh
npm run bridge:mqtt                    # subscribes to 127.0.0.1:1883 by default
npm run bridge:mqtt -- --launch-mosquitto   # also spawn a local Mosquitto, if installed
```

Then open the **MQTT** tab, set the broker (host, port, TLS, username, password) and
the topic for each source, and press **Connect**:

| Source | Default topic |
| --- | --- |
| BirdNET-Pi detections | `birdnet/detections` |
| Meshtastic JSON gateway | `msh/+/json` |
| Weather stations | `weather/#` |

The panel shows a live feed per source: BirdNET detections (species, scientific name,
confidence), Meshtastic node telemetry (temperature, humidity, pressure, battery,
voltage, position) and weather readings. MQTT wildcards work — `+` matches one topic
level and `#` matches everything below it. Config is stored in `localStorage` and
mirrored into the bridge, so credentials never live in the page bundle and the
subscription keeps running while you use other tabs.

No broker yet? `npm run broker:test` starts a real `aedes` broker that publishes sample
BirdNET, Meshtastic and weather messages every 1.5s. See
[`bridge/README.md`](bridge/README.md#mqtt-ingest-bridge) for the CLI flags, the
HTTP/SSE contract and Mosquitto setup.

### Panels

Every panel (left-rail sections, map, serial monitor, points log, node list,
telemetry, outputs) can be

* **collapsed** — the chevron in its header,
* **detached and moved** — the float button turns it into a free-floating window
  you can drag anywhere by its header (double-click the header to dock it again),
* **resized** — drag the corner handle of a floating panel; the left rail width is
  resized by dragging its edge.

Layout, sizes and collapse state are remembered in `localStorage`; **Reset
layout** restores the defaults.

## Supported input formats

All parsing is tolerance-based — no strict schema is required. Three families are
understood and can be interleaved on the same port:

* **Meshtastic firmware console log** (the default USB serial output):

  ```
  DEBUG | 11:36:30 67 [Router] POSITION node=a1d7631c l=33 lat=386993383 lon=-92322000 msl=105 siv=8 ...
  INFO  | 11:36:30 67 [Router] updatePosition REMOTE node=0xa1d7631c time=1790681791 lat=386993383 lon=-92322000
  DEBUG | 11:36:30 67 [RadioIf] Lora RX (fr=0xa1d7631c Ch=0x41 len=55 rxSNR=5.75 rxRSSI=-54 hopStart=3)
  INFO  | 11:36:11 48 [Router] Node status update: 4 online, 80 total
  ```

  Coordinates are 1e7-scaled integers, `msl=` is the altitude, and ANSI colour
  escapes are stripped before matching. Unquoted, quoted and single-quoted
  `key=value` pairs are all handled.

* **Meshtastic JSON** — positions and telemetry:

  ```json
  {"from":"!28a9df12","type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":42}}
  {"sender":"!a1d7631c","type":"telemetry","payload":{"deviceMetrics":{"batteryLevel":87,"voltage":4.02},"time":1790681791}}
  {"payload":{"environmentMetrics":{"temperature":21.4,"relativeHumidity":48.2,"barometricPressure":1013.2}}}
  {"from":"!28a9df12","type":"nodeinfo","payload":{"longName":"Sim Ridge Relay","shortName":"SIM1"}}
  ```

  One packet can carry several metric containers; each becomes its own sample, and
  fields outside the modelled containers are still kept.

* **NMEA 0183** — `$GPGGA`/`$GNGGA`, `$GPRMC`/`$GNRMC` (any talker), with
  `ddmm.mmmm`/`dddmm.mmmm` converted to decimal degrees.

Malformed input (`"lat": null`, `"lat": "N/A"`, non-numeric values, `(0,0)`
no-fix placeholders, truncated JSON) is dropped quietly instead of breaking the
reader.

## Desktop app (Linux AppImage)

The dashboard also runs as a desktop application:

```bash
npm run desktop        # build + run
npm run desktop:build  # produce release/Mesh-Map-<version>-x86_64.AppImage
npm run desktop:smoke  # boot offscreen, check the page rendered, exit
```

**It is a launcher, not a re-implementation.** It serves the built app on
`http://127.0.0.1:<random port>`, starts the OSC bridge, and opens the page in
Chrome/Chromium (Edge and Brave also work) with `--app=`, which gives a chromeless
window. The reason is the serial picker: Chromium's built-in port selector only
exists in a real browser — Electron exposes `navigator.serial` but requires the app
to implement `select-serial-port` itself, and a hand-rolled picker is always worse
than the real one.

- `MESH_MAP_BROWSER=<name-or-path>` chooses the browser explicitly.
- `--embedded` forces the app into an Electron window instead (fallback path).
- `--no-bridge` skips the OSC bridge, for when one is already running.
- The browser gets its own `--user-data-dir`, so its serial-port grant belongs to
  this app and closing its window shuts the server down.

If no Chromium-family browser is installed, it falls back to an embedded Electron
window — everything works except that the port picker is the basic built-in one.

Why it is built this way:

- **Served over loopback rather than `file://`.** Web Serial only exists in a secure
  context, and `file://` is not one — loading the HTML directly would silently
  remove every serial feature.
- **The bridge is spawned, not bundled into the page.** `bridge/` ships in
  `resources/` (extraResources) and runs on Electron's own binary with
  `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is required.
- **No `node_modules` ship in the AppImage.** Vite pre-bundles the renderer and the
  main process plus the bridge use only Node/Electron builtins, so `app.asar` is
  ~600 KB and the AppImage is ~125 MB (almost all Electron runtime, which is what
  provides the bundled Node).

**Offline:** Leaflet's stylesheet is bundled rather than fetched from unpkg, so the
only thing needing the network is the map tiles themselves.

| Target | Output |
|---|---|
| `linux` | `release/Mesh-Map-1.0.0-x86_64.AppImage` (also `release/linux-unpacked/`) |
| icon | `build/icon.png` (512×512 RGBA, generated from `build/icon.svg`) |

### Releases (CI)

`.github/workflows/ci.yml` runs the test suite (`lint`, `vitest`, and the three
bridge suites) on every push to `main` and every pull request, then builds the
AppImage. The AppImage is published to **GitHub Releases** when you push a version
tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

That attaches `Mesh-Map-1.0.0-x86_64.AppImage` plus a `SHA256SUMS.txt` to a new
release with generated notes. Re-running the same tag replaces the asset rather than
failing.

To build and attach a release without tagging, run the **CI** workflow from the
Actions tab with `release_tag` set (e.g. `v1.0.0`); leaving it empty just produces a
downloadable workflow artifact. Keep `version` in `package.json` in step with the tag
so the filename matches.

## Requirements

* **Node ≥ 20**
* A Chromium-based browser for real hardware and MIDI (demo mode works anywhere)

## Project layout

```
src/
  App.tsx                     state, serial/Web Serial plumbing, tab layout
  components/
    FoliumMap.tsx             Leaflet map: one trace per node
    mapLayers.ts*             pure map helpers (popups, markers, legend)
    Panel.tsx                 collapsible · movable · resizable panel shell
    panelLayout.ts*           pure layout/persistence helpers for Panel
    NodesPanel.tsx            node list (colour / visible / solo)
    TelemetryPanel.tsx        per-node telemetry dashboard
    TelemetryMetricCard.tsx   one metric: label, value, unit, sparkline
    Sparkline.tsx             inline SVG sparkline
    OutputsPanel.tsx          OSC + MIDI configuration
    Sidebar.tsx               serial connection controls
    SerialTerminal.tsx        raw stream view
    PointsTable.tsx           packet table
    MetricsBar.tsx            packet / distance / position metrics
    TimeWindowSelector.tsx    All · 1 min · 30 min · 1 h · 3 h · 6 h · 12 h
  utils/
    parser.ts                 NMEA + Meshtastic JSON + firmware log parsing
    telemetry.ts              generic telemetry capture + per-node roll-up
    telemetryMetrics.ts       metric labels and units
    oscClient.ts              batched HTTP/WebSocket client for the bridge
    midi.ts                   Web MIDI outputs, CC/note mapping
    nodes.ts                  per-node grouping, colours, time windows
    haversine.ts              distance maths, CSV/GeoJSON/GPX export
bridge/
  osc-bridge.mjs              zero-dependency OSC bridge (HTTP + WebSocket → UDP)
  test-osc-bridge.mjs         69-check self-test
(* = extracted from the component it supports; see the tests below)
```

## Tests

```bash
npm test               # 110 vitest unit tests (parsers, telemetry, layout, map helpers)
npm run test:bridge    # 69 bridge checks, including an independent OSC decoder
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Connect does nothing | Web Serial needs Chrome/Edge and a `localhost` or HTTPS origin |
| Port not listed | press **Scan Hardware** and accept the browser prompt |
| Connected but no points | your node may be reporting only its own boot log; the parser needs `lat=`/`lon=`, Meshtastic JSON or NMEA lines — check the Serial Monitor tab |
| Telemetry tab is empty | position alone is not telemetry; wait for `[DeviceTelemetry]`/`telemetry` packets, or press **Start Demo** |
| OSC health check fails | the bridge is not running — `npm run bridge`, and check the URL/port match |
| OSC arrives but no MIDI | MIDI needs permission (Chrome prompts) and an output port; create a virtual port (QMidiNet/IAC) then press **Refresh ports** |
| Map tiles blank | the map needs internet access for the OpenStreetMap/Esri tiles |
| AppImage will not start | some systems block the FUSE mount; run it with `--appimage-extract-and-run`, or `./Mesh-Map-*.AppImage --no-sandbox` |
| Desktop window opens but no serial ports | only ports Chromium can see are listed; check the node is plugged in and you have permission (`dialout`/`uucp` group) |
| OSC does nothing in the desktop app | check the Serial Monitor for a bridge port clash — `--no-bridge` uses an existing bridge |
