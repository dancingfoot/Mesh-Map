/**
 * Real serial-port discovery for the bridge.
 *
 * A browser cannot enumerate a machine's serial ports: `navigator.serial.getPorts()`
 * only returns devices the user has already granted to the page, and everything
 * else requires the user to pick from Chrome's own dialog. The bridge, however,
 * runs natively, so it can simply read the OS.
 *
 * Deliberately dependency-free (no `serialport` package) and platform-tolerant:
 * it lists the device nodes USB-serial adapters appear as, plus the stable
 * `/dev/serial/by-id` symlinks when present.
 */

import { readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} SerialPortInfo
 * @property {string} path        Device node, e.g. `/dev/ttyUSB0`.
 * @property {string|null} byId   Stable udev symlink (`/dev/serial/by-id/...`) when one exists.
 * @property {string} description Best-effort human description of the device family.
 */

/** Name patterns that identify USB-serial adapters (not every tty on the box). */
const PORT_PATTERNS = [
  [/^ttyUSB\d+$/, 'USB-to-serial adapter (CH340 / CP210x / FTDI / PL2303)'],
  [/^ttyACM\d+$/, 'USB CDC-ACM device (ESP32-S3 / RP2040 / nRF52 boards)'],
  [/^ttyAMA\d+$/, 'On-board UART (Raspberry Pi GPIO header)'],
  [/^ttyS\d+$/, 'Built-in serial port'],
  [/^cu\..+$/, 'macOS call-out device'],
  [/^tty\.(usbserial|usbmodem|SLAB_USBtoUART|wchusbserial).*$/, 'macOS USB-serial device'],
  [/^COM\d+$/i, 'Windows COM port'],
];

/**
 * Describes a device name, or returns `null` when it is not a serial port.
 *
 * @param {string} name e.g. `ttyUSB0`
 * @returns {string|null}
 */
export function describePortName(name) {
  for (const [pattern, description] of PORT_PATTERNS) {
    if (pattern.test(name)) return description;
  }
  return null;
}

/**
 * Sorts device nodes the way a human expects: ttyUSB0, ttyUSB1, ttyACM0, …
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePortPaths(a, b) {
  const split = (value) => {
    const match = value.match(/^(.*?)(\d*)$/);
    return { prefix: match?.[1] ?? value, number: Number(match?.[2] || 0) };
  };
  const left = split(a);
  const right = split(b);
  if (left.prefix !== right.prefix) return left.prefix < right.prefix ? -1 : 1;
  return left.number - right.number;
}

/**
 * Lists serial devices visible to this machine.
 *
 * @param {string} [devRoot]  Directory to scan; overridable so the behaviour can
 *                            be tested against a synthetic tree (containers have
 *                            no real serial devices).
 * @param {string} [byIdRoot] udev-style symlink directory.
 * @returns {SerialPortInfo[]}
 */
export function listSerialPorts(devRoot = '/dev', byIdRoot = '/dev/serial/by-id') {
  let entries;
  try {
    entries = readdirSync(devRoot);
  } catch {
    return []; // no /dev (Windows, unusual container) — not an error
  }

  // Map device node -> stable by-id symlink so the UI can offer a name that
  // survives replugging.
  /** @type {Map<string, string>} */
  const byId = new Map();
  try {
    for (const link of readdirSync(byIdRoot)) {
      const full = join(byIdRoot, link);
      try {
        byId.set(readlinkSync(full), full);
      } catch {
        /* broken symlink — ignore */
      }
    }
  } catch {
    /* no by-id directory (common on macOS/Windows) — fine */
  }

  /** @type {SerialPortInfo[]} */
  const ports = [];
  for (const name of entries) {
    const description = describePortName(name);
    if (!description) continue;
    const path = join(devRoot, name);
    ports.push({ path, byId: byId.get(path) ?? byId.get(name) ?? null, description });
  }

  return ports.sort((a, b) => comparePortPaths(a.path, b.path));
}
