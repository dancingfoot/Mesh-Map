/**
 * The desktop launcher's static server.
 *
 * The port is the origin, and the origin scopes both `localStorage` and
 * Chromium's serial-port permission — so a stable port is a correctness
 * requirement, not a nicety. These tests pin that behaviour: reuse the preferred
 * port, step to the next one when it is busy, and never leak outside the served
 * directory.
 *
 * The served directory is a throwaway fixture rather than the real `dist/`: that
 * is a build artifact (and gitignored), so depending on it made these tests pass
 * only on a machine that had already run `npm run build`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer } from '../../desktop/static-server.mjs';

/** Shape returned by the launcher's static server. */
interface StaticServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const open: StaticServerHandle[] = [];

/** Fixture root; the served directory is `<tempRoot>/dist`, as in the app. */
let tempRoot = '';
let servedDir = '';

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'meshmap-static-server-'));
  servedDir = join(tempRoot, 'dist');
  mkdirSync(join(servedDir, 'assets'), { recursive: true });
  writeFileSync(
    join(servedDir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  writeFileSync(join(servedDir, 'assets', 'app.js'), 'console.log("fixture");');

  // Decoys *outside* the served directory. The traversal test asserts none of
  // these ever reach a client, so they must contain recognisable markers.
  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ name: 'mesh-map' }));
  mkdirSync(join(tempRoot, 'desktop'), { recursive: true });
  writeFileSync(join(tempRoot, 'desktop', 'main.mjs'), 'const DEFAULT_APP_PORT = 6374;\n');
});

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (let server = open.pop(); server; server = open.pop()) {
    await server.close();
  }
});

async function start(options?: { preferredPort?: number }): Promise<StaticServerHandle> {
  const server = (await startStaticServer(servedDir, options)) as StaticServerHandle;
  open.push(server);
  return server;
}

describe('startStaticServer', () => {
  it('reuses the preferred port across launches so the origin stays stable', async () => {
    // Simulate two launches: the first server closes, the next run asks for the
    // same port and must get it — otherwise the origin changes and the app
    // forgets its saved configuration.
    const first = await start({ preferredPort: 0 });
    const wanted = first.port;
    await first.close();
    open.splice(open.indexOf(first), 1);

    const second = await start({ preferredPort: wanted });
    expect(second.port).toBe(wanted);
  });

  it('steps to the next port when the preferred one is taken', async () => {
    const held = await start({ preferredPort: 0 });
    const other = await start({ preferredPort: held.port });
    // 0 would mean "any"; we specifically want an ordered fallback.
    expect(other.port).not.toBe(held.port);
    expect([held.port + 1, held.port + 2, held.port + 3]).toContain(other.port);
  });

  it('falls back to an ephemeral port when told to', async () => {
    const server = await start({});
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it('binds loopback only, never a public interface', async () => {
    const server = await start({ preferredPort: 0 });
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('serves the app shell and falls back to it for unknown paths', async () => {
    const server = await start({ preferredPort: 0 });
    const root = await fetch(server.url);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    const deep = await fetch(`${server.url}does/not/exist`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<div id="root">');
  });

  it('never serves a file from outside the served directory', async () => {
    const server = await start({ preferredPort: 0 });
    for (const path of [
      '../package.json',
      '%2e%2e%2fpackage.json',
      '../desktop/main.mjs',
      '%2e%2e%2fdesktop%2fmain.mjs',
      '..%2f..%2f..%2fetc%2fpasswd',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      const body = await response.text();
      expect(body).not.toContain('"name":"mesh-map"'); // leaked package.json
      expect(body).not.toContain('DEFAULT_APP_PORT'); // leaked desktop/main.mjs
      expect(body).not.toContain('root:x:'); // leaked /etc/passwd
    }
  });
});
