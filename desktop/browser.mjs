/**
 * Finding a Chromium-based browser to host the dashboard.
 *
 * ## Why the desktop app launches a browser at all
 *
 * Electron *is* Chromium, but it does not ship Chromium's serial-port picker:
 * `navigator.serial.requestPort()` requires the app to implement
 * `select-serial-port` itself. A real Chrome/Chromium installation does have the
 * built-in picker, so the desktop shell serves the app and hands the UI to the
 * browser instead of reimplementing that dialog badly.
 *
 * `--app=<url>` gives a chromeless window, so it still looks like a desktop app
 * rather than a browser tab, and a dedicated `--user-data-dir` keeps the
 * session's serial permissions in the app's own profile.
 *
 * This module is pure and injectable on purpose: browser discovery is exactly
 * the kind of thing that should be testable without the browser present.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Chromium-family browsers that support Web Serial, in order of preference. */
export const BROWSER_CANDIDATES = [
  { name: 'Google Chrome', commands: ['google-chrome-stable', 'google-chrome', 'chrome'] },
  { name: 'Chromium', commands: ['chromium', 'chromium-browser', 'chromium-freeworld'] },
  { name: 'Microsoft Edge', commands: ['microsoft-edge-stable', 'microsoft-edge'] },
  { name: 'Brave', commands: ['brave-browser', 'brave'] },
  { name: 'Vivaldi', commands: ['vivaldi-stable', 'vivaldi'] },
];

/**
 * Searches PATH-like directories for the first existing candidate.
 *
 * @param {string[]} dirs directories to search, in order
 * @param {(path: string) => boolean} isExecutable predicate, injected for tests
 * @returns {string | null} absolute path of the first match
 */
export function searchPath(dirs, isExecutable) {
  for (const candidate of BROWSER_CANDIDATES) {
    for (const command of candidate.commands) {
      for (const dir of dirs) {
        if (!dir) continue;
        const full = join(dir, command);
        if (isExecutable(full)) return full;
      }
    }
  }
  return null;
}

/**
 * Finds one specific command on a PATH-like list.
 *
 * @param {string[]} dirs
 * @param {string} name
 * @param {(path: string) => boolean} isExecutable
 * @returns {string | null}
 */
export function findOnPath(dirs, name, isExecutable) {
  for (const dir of dirs) {
    if (!dir) continue;
    const full = join(dir, name);
    if (isExecutable(full)) return full;
  }
  return null;
}

/** True when `path` exists and is executable by this user. */
export function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates a usable browser.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] environment (for the override)
 * @param {string} [options.pathEnv] PATH-style string
 * @param {(path: string) => boolean} [options.isExecutable]
 * @returns {{name: string, command: string} | null}
 */
export function findBrowser({
  env = process.env,
  pathEnv = process.env.PATH ?? '',
  isExecutable = isExecutableFile,
} = {}) {
  // An explicit choice always wins, and may be any command name or path.
  const override = (env.MESH_MAP_BROWSER ?? '').trim();
  if (override) {
    const resolved = override.includes('/')
      ? override
      : findOnPath((pathEnv || '').split(delimiter), override, isExecutable);
    // Unresolved is still returned: an explicit choice should fail loudly at
    // spawn time rather than silently falling back to some other browser.
    return { name: `MESH_MAP_BROWSER (${override})`, command: resolved ?? override };
  }

  const command = searchPath((pathEnv || '').split(delimiter), isExecutable);
  if (!command) return null;

  const base = command.split('/').pop() ?? command;
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate.commands.includes(base)) return { name: candidate.name, command };
  }
  return { name: base, command };
}

/**
 * Builds the browser arguments for an app-style window.
 *
 * `--app=` removes the tab bar and omnibox; the dedicated profile keeps the
 * serial-port grant for this app and stops the launch from attaching to (and
 * being kept alive by) the user's everyday browser session.
 *
 * @param {{url: string, profileDir: string}} options
 * @returns {string[]}
 */
export function buildLaunchArgs({ url, profileDir }) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    // Otherwise a first launch opens a "make Chrome default" tab in front of the app.
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
}
