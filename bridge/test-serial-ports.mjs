// Tests for the bridge's system serial-port scanner. Plain node, no framework.
// Builds a synthetic /dev tree so the behaviour is provable without hardware.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comparePortPaths, describePortName, listSerialPorts } from './serial-ports.mjs';

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const root = mkdtempSync(join(tmpdir(), 'meshmap-ports-'));
const dev = join(root, 'dev');
const byId = join(dev, 'serial', 'by-id');
mkdirSync(byId, { recursive: true });

// A realistic Linux box: two USB adapters, one CDC ACM, board UART plus noise.
for (const name of [
  'ttyUSB1',
  'ttyUSB0',
  'ttyUSB10',
  'ttyACM0',
  'ttyAMA0',
  'ttyS0',
  'null',
  'random',
  'tty',
  'pts',
  'snd',
  'loop0',
]) {
  writeFileSync(join(dev, name), '');
}
// Stable udev symlinks for the two USB adapters.
symlinkSync(join(dev, 'ttyUSB0'), join(byId, 'usb-Silicon_Labs_CP2102_-if00-port0'));
symlinkSync(join(dev, 'ttyUSB1'), join(byId, 'usb-1a86_USB_Serial-if00-port0'));
// A dangling symlink must not break the scan.
symlinkSync(join(dev, 'ttyUSB9'), join(byId, 'usb-Ghost-if00-port0'));

console.log('[1] listing a synthetic /dev');
const ports = listSerialPorts(dev, byId);
const paths = ports.map((p) => p.path);
check('finds the USB adapters and CDC device', paths.length === 6, paths.join(', '));
check('ignores non-serial nodes (null, random, loop0, snd, pts)', !paths.some((p) => /null|random|loop0|snd|pts$/.test(p)));
check('includes ttyUSB0/1/10 and ttyACM0/ttyAMA0/ttyS0', ['ttyUSB0', 'ttyUSB1', 'ttyUSB10', 'ttyACM0', 'ttyAMA0', 'ttyS0'].every((n) => paths.some((p) => p.endsWith(n))));
check('sorts numerically, not lexically (USB0, USB1 … USB10)', paths.filter((p) => p.includes('ttyUSB')).map((p) => p.split('/').pop()).join(',') === 'ttyUSB0,ttyUSB1,ttyUSB10', paths.filter((p) => p.includes('ttyUSB')).join(', '));
const usb0 = ports.find((p) => p.path.endsWith('ttyUSB0'));
check('attaches the stable by-id path', usb0?.byId === join(byId, 'usb-Silicon_Labs_CP2102_-if00-port0'), String(usb0?.byId));
check('describes the USB adapter family', /USB-to-serial/.test(usb0?.description ?? ''), usb0?.description);
const acm = ports.find((p) => p.path.endsWith('ttyACM0'));
check('describes the CDC-ACM family', /CDC-ACM/.test(acm?.description ?? ''), acm?.description);
check('a dangling by-id symlink does not throw or leak in', ports.every((p) => p.path !== join(dev, 'ttyUSB9')));

console.log('\n[2] name classification');
check('ttyUSB3 is serial', describePortName('ttyUSB3') !== null);
check('ttyACM2 is serial', describePortName('ttyACM2') !== null);
check('cu.usbserial-1410 (macOS) is serial', describePortName('cu.usbserial-1410') !== null);
check('COM7 (Windows) is serial', describePortName('COM7') !== null);
check('tty1 is NOT treated as serial', describePortName('tty1') === null);
check('sda is NOT treated as serial', describePortName('sda') === null);

console.log('\n[3] missing directories are not errors');
check('absent /dev returns []', listSerialPorts(join(root, 'nope'), join(root, 'nope')).length === 0);
check('absent by-id still lists devices', listSerialPorts(dev, join(root, 'nope')).length === 6);

console.log('\n[4] sorting helper');
check('numeric order', ['b10', 'b2', 'a1'].sort(comparePortPaths).join(',') === 'a1,b2,b10', ['b10', 'b2', 'a1'].sort(comparePortPaths).join(','));

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('ALL SERIAL-PORT TESTS PASSED');
