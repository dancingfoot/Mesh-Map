/**
 * Browser discovery for the desktop launcher.
 *
 * The launcher is a shell around a real Chrome/Chromium install because that is
 * where the built-in serial-port picker lives — so finding the right browser,
 * and degrading predictably when none exists, is worth testing without a
 * browser present.
 */
import { describe, expect, it } from 'vitest';
import { buildLaunchArgs, findBrowser, searchPath } from '../../desktop/browser.mjs';

describe('searchPath', () => {
  it('finds the first candidate in PATH order', () => {
    const present = new Set(['/usr/bin/google-chrome-stable', '/usr/bin/chromium']);
    const found = searchPath(['/usr/bin', '/usr/local/bin'], (p) => present.has(p));
    expect(found).toBe('/usr/bin/google-chrome-stable');
  });

  it('prefers Chrome over Chromium when both exist', () => {
    const present = new Set(['/usr/bin/chromium', '/usr/local/bin/google-chrome']);
    expect(searchPath(['/usr/bin', '/usr/local/bin'], (p) => present.has(p))).toBe(
      '/usr/local/bin/google-chrome'
    );
  });

  it('falls through to Chromium and then Edge', () => {
    expect(searchPath(['/snap/bin'], (p) => p === '/snap/bin/chromium-browser')).toBe(
      '/snap/bin/chromium-browser'
    );
    expect(searchPath(['/usr/bin'], (p) => p === '/usr/bin/microsoft-edge')).toBe(
      '/usr/bin/microsoft-edge'
    );
  });

  it('returns null when nothing matches', () => {
    expect(searchPath(['/usr/bin', '/opt'], () => false)).toBeNull();
    expect(searchPath([], () => true)).toBeNull();
    expect(searchPath(['', ''], () => true)).toBeNull();
  });
});

describe('findBrowser', () => {
  const path = '/usr/bin:/usr/local/bin:/snap/bin';

  it('reports the product name, not just the path', () => {
    const found = findBrowser({
      env: {},
      pathEnv: path,
      isExecutable: (p) => p === '/usr/bin/google-chrome-stable',
    });
    expect(found).toEqual({ name: 'Google Chrome', command: '/usr/bin/google-chrome-stable' });
  });

  it('honours MESH_MAP_BROWSER, which may be a name or a path', () => {
    const byName = findBrowser({
      env: { MESH_MAP_BROWSER: 'chromium' },
      pathEnv: path,
      isExecutable: (p) => p === '/snap/bin/chromium',
    });
    expect(byName?.name).toContain('MESH_MAP_BROWSER');
    expect(byName?.command).toBe('/snap/bin/chromium');

    const byPath = findBrowser({
      env: { MESH_MAP_BROWSER: '/opt/my-browser' },
      pathEnv: path,
      isExecutable: () => false,
    });
    expect(byPath?.command).toBe('/opt/my-browser');
  });

  it('returns null when no Chromium-family browser is installed', () => {
    expect(findBrowser({ env: {}, pathEnv: path, isExecutable: () => false })).toBeNull();
  });

  it('tolerates an empty PATH', () => {
    expect(findBrowser({ env: {}, pathEnv: '', isExecutable: () => true })).toBeNull();
  });
});

describe('buildLaunchArgs', () => {
  it('opens a chromeless app window with its own profile', () => {
    const args = buildLaunchArgs({ url: 'http://127.0.0.1:41234/', profileDir: '/home/u/.config/mesh-map/chrome' });
    expect(args).toContain('--app=http://127.0.0.1:41234/');
    expect(args).toContain('--user-data-dir=/home/u/.config/mesh-map/chrome');
    expect(args).toContain('--no-first-run');
  });

  it('never passes a flag that would disable the serial picker', () => {
    const args = buildLaunchArgs({ url: 'http://127.0.0.1:1/', profileDir: '/tmp/p' }).join(' ');
    expect(args).not.toMatch(/disable-web-security|no-sandbox|disable-features=[^ ]*Serial/);
  });
});
