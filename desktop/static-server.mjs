/**
 * A tiny static file server for the packaged dashboard.
 *
 * ## Why not just load `dist/index.html` with `file://`?
 *
 * `navigator.serial` (Web Serial) is only available in a **secure context**. A
 * `file://` origin is not one, so the map/serial features would silently vanish
 * in the desktop build. Serving the same files from `http://127.0.0.1:<port>`
 * makes the page a secure context (localhost counts) with no certificates.
 *
 * Dependency-free on purpose: the packaged app must not need `node_modules`.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** Enough MIME coverage for a Vite build (plus Leaflet's marker images). */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** How many consecutive ports to try before giving up on the preferred one. */
const PORT_ATTEMPTS = 10;

/**
 * Starts the server on loopback.
 *
 * `preferredPort` matters more than it looks: the origin (`scheme://host:port`)
 * is what scopes `localStorage` and Chromium's serial-port permission. An
 * ephemeral port would therefore hand the app a brand-new origin on every
 * launch — losing the OSC/MIDI configuration, the panel layout and the user's
 * serial grant each time.
 *
 * @param {string} rootDir directory holding the built app (must contain index.html)
 * @param {{preferredPort?: number}} [options]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startStaticServer(rootDir, { preferredPort = 0 } = {}) {
  const root = resolve(rootDir);

  /** Resolves a URL path to a file inside `root`, or null when it escapes. */
  const resolveInside = (urlPath) => {
    const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    const candidate = resolve(join(root, normalize(decoded)));
    if (candidate !== root && !candidate.startsWith(root + sep)) return null; // traversal
    return candidate;
  };

  const server = createServer(async (req, res) => {
    try {
      let filePath = resolveInside(req.url || '/');
      if (!filePath) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = join(filePath, 'index.html');
        info = await stat(filePath).catch(() => null);
      }

      // Single-page app: unknown paths fall back to the shell.
      if (!info?.isFile()) {
        filePath = join(root, 'index.html');
        info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) {
          res.writeHead(404).end('Not found');
          return;
        }
      }

      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        // The bundle is rebuilt on every release; never let a stale copy linger.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(`Internal error: ${error?.message ?? error}`);
    }
  });

  return new Promise((resolvePromise, reject) => {
    /** Ports to try: the preferred one, then its successors, then "any". */
    const candidates = preferredPort > 0
      ? [...Array.from({ length: PORT_ATTEMPTS }, (_, i) => preferredPort + i), 0]
      : [0];
    let attempt = 0;

    const settle = () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    };

    // Only a port clash is worth retrying; anything else is fatal.
    const onError = (error) => {
      if (error?.code === 'EADDRINUSE' && attempt < candidates.length - 1) {
        attempt += 1;
        server.listen(candidates[attempt], '127.0.0.1');
        return;
      }
      reject(error);
    };

    server.on('error', onError);
    // Loopback only: this server must never be reachable from the network.
    server.listen(candidates[0], '127.0.0.1', settle);
  });
}
