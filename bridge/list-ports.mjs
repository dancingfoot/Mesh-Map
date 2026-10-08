#!/usr/bin/env node
/**
 * Prints the serial ports visible on THIS machine — the same list the dashboard
 * asks the bridge for. Handy for confirming which device to pick in Chrome's
 * port dialog, since a web page cannot enumerate them itself.
 *
 *     npm run list:ports
 */
import { listSerialPorts } from './serial-ports.mjs';

const ports = listSerialPorts();

console.log(`Platform: ${process.platform}`);
if (ports.length === 0) {
  console.log('No serial devices found.');
  console.log('Check that the node is plugged in and that you are running this on the');
  console.log('same machine it is attached to (the dashboard runs in a browser, but');
  console.log('this script runs natively and can see the OS).');
  process.exit(0);
}

console.log(`Found ${ports.length} serial device(s):\n`);
for (const port of ports) {
  console.log(`  ${port.path}`);
  if (port.byId) console.log(`    stable id : ${port.byId}`);
  console.log(`    looks like: ${port.description}`);
}
console.log('\nPick the matching entry in the browser\'s "Scan Hardware" dialog.');
