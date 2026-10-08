/**
 * Mesh Map desktop shell (Electron).
 *
 * The dashboard is a web app, so the desktop build is deliberately thin: it
 * serves the built `dist/` over loopback, starts the OSC bridge as a child
 * process, and wires up the two things a browser cannot do on its own —
 * Web Serial port selection and a real application window.
 *
 * Run from source:   npm run desktop          (builds first)
 * Package an AppImage: npm run desktop:build
 * Self-check:        npm run desktop:smoke
 */

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { buildLaunchArgs, findBrowser } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = app.isPackaged ? app.getAppPath() : join(here, '..');

/** `--smoke-test` boots everything headless, checks the page, and exits. */
const SMOKE_TEST = process.argv.includes('--smoke-test');
/** `--no-bridge` skips the OSC bridge (useful when one is already running). */
const NO_BRIDGE = process.argv.includes('--no-bridge');
/**
 * `--embedded` forces the app to render in this Electron window instead of
 * handing the UI to Chrome. Only useful for debugging the fallback path, since
 * Electron lacks Chromium's serial-port picker (see desktop/browser.mjs).
 */
const FORCE_EMBEDDED = process.argv.includes('--embedded');

/**
 * Default loopback port for the app.
 *
 * Stable by design: `localStorage` and Chromium's serial permission are scoped to
 * the origin, so a changing port would silently reset the OSC/MIDI configuration
 * and re-prompt for the serial port on every launch.
 */
const DEFAULT_APP_PORT = 6374;

/** Reads the port used last time, so the origin stays identical across launches. */
function storedAppPort() {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'app-port.json'), 'utf8');
    const value = JSON.parse(raw)?.port;
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {
    /* first run */
  }
  return DEFAULT_APP_PORT;
}

function rememberAppPort(port) {
  try {
    writeFileSync(join(app.getPath('userData'), 'app-port.json'), JSON.stringify({ port }));
  } catch (error) {
    console.warn(`[launcher] could not persist the port: ${error?.message ?? error}`);
  }
}

/** Where the OSC bridge lives: extraResources when packaged, the repo otherwise. */
const bridgeScript = app.isPackaged
  ? join(process.resourcesPath, 'bridge', 'osc-bridge.mjs')
  : join(appRoot, 'bridge', 'osc-bridge.mjs');

let mainWindow = null;
let staticServer = null;
let bridgeProcess = null;
let launcherProcess = null;

/* -------------------------------------------------------------------------- */
/* OSC bridge                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Starts the local OSC bridge alongside the window.
 *
 * A browser cannot send UDP, so without this the Outputs tab has nowhere to
 * send. Failure is not fatal — the dashboard still runs, it just cannot reach
 * OSC targets — so a port clash is reported rather than thrown.
 */
function startBridge() {
  if (NO_BRIDGE) return;
  if (!existsSync(bridgeScript)) {
    console.warn(`[bridge] not found at ${bridgeScript} — OSC output unavailable`);
    return;
  }

  bridgeProcess = spawn(process.execPath, [bridgeScript, '--listen', '9000', '--osc-port', '57120'], {
    // Electron's binary doubles as Node when this flag is set, so the shipped
    // runtime needs no separate Node install.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  bridgeProcess.stdout?.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`));
  bridgeProcess.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    process.stderr.write(`[bridge] ${text}`);
    if (/EADDRINUSE/.test(text)) {
      console.warn('[bridge] port 9000 is already in use — using the existing bridge');
    }
  });
  bridgeProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.warn(`[bridge] exited with code ${code}`);
    bridgeProcess = null;
  });
}

function stopBridge() {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill('SIGTERM');
    bridgeProcess = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Web Serial                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Grants Web Serial and answers Chromium's port picker.
 *
 * `navigator.serial.requestPort()` in the renderer triggers `select-serial-port`
 * here; Chromium hands us the list of ports it discovered on the machine and
 * waits for a `portId`. With one device there is nothing to ask, so it is
 * selected silently; with several the user chooses.
 */
function wireSerialSupport(window) {
  const session = window.webContents.session;

  session.setPermissionCheckHandler((_contents, permission) => permission === 'serial');
  session.setDevicePermissionHandler((details) => details.deviceType === 'serial');

  session.on('select-serial-port', (event, portList, _contents, callback) => {
    event.preventDefault();

    if (!portList || portList.length === 0) {
      callback('');
      return;
    }

    const label = (port) => {
      const name = port.displayName || port.portName || port.portId;
      const ids = [port.vendorId, port.productId].filter(Boolean).join(':');
      return ids ? `${name} (${ids})` : name;
    };

    if (portList.length === 1) {
      callback(portList[0].portId);
      return;
    }

    const buttons = [...portList.map(label), 'Cancel'];
    dialog
      .showMessageBox(window, {
        type: 'question',
        title: 'Select serial port',
        message: 'Which serial device should Mesh Map open?',
        detail: portList.map((port, index) => `${index + 1}. ${label(port)}`).join('\n'),
        buttons,
        defaultId: 0,
        cancelId: portList.length,
        noLink: true,
      })
      .then(({ response }) => {
        callback(response < portList.length ? portList[response].portId : '');
      })
      .catch(() => callback(''));
  });
}

/* -------------------------------------------------------------------------- */
/* Browser launch                                                              */
/* -------------------------------------------------------------------------- */

/** Where the launched browser keeps its profile (and its serial permissions). */
function browserProfileDir() {
  return join(app.getPath('userData'), 'browser-profile');
}

/**
 * Hands the UI to Chrome/Chromium, which owns the real serial-port picker.
 *
 * @returns {import('node:child_process').ChildProcess | null}
 */
function launchBrowser(url) {
  const browser = findBrowser();
  if (!browser) {
    console.warn(
      '[launcher] no Chrome/Chromium/Edge/Brave found — falling back to the embedded window.\n' +
        '           That window can open serial ports, but its port picker is the basic built-in one.\n' +
        '           Install Chrome/Chromium (or set MESH_MAP_BROWSER) for the native picker.'
    );
    return null;
  }

  const args = buildLaunchArgs({ url, profileDir: browserProfileDir() });
  console.log(`[launcher] opening ${url} in ${browser.name}`);

  const child = spawn(browser.command, args, { stdio: 'ignore', detached: false });
  child.on('error', (error) => console.error(`[launcher] could not start ${browser.command}: ${error.message}`));
  // The app exists to serve that window: when it closes, shut everything down.
  child.on('exit', (code) => {
    console.log(`[launcher] browser exited (code ${code}) — stopping`);
    app.quit();
  });
  return child;
}

/* -------------------------------------------------------------------------- */
/* Window                                                                      */
/* -------------------------------------------------------------------------- */

function buildMenu(window) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Meshtastic documentation',
            click: () => shell.openExternal('https://meshtastic.org/docs/'),
          },
        ],
      },
    ])
  );
}

async function createWindow(url) {
  if (!url) throw new Error('createWindow requires the static server URL');

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#020617',
    title: 'Mesh Map',
    // Present in the repo, intentionally absent from the packaged app (the
    // AppImage carries its own icon), so only point at it when it exists.
    ...(existsSync(join(appRoot, 'build', 'icon.png'))
      ? { icon: join(appRoot, 'build', 'icon.png') }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Web Serial needs the permission machinery below, not Node in the page.
      sandbox: false,
    },
  });

  wireSerialSupport(mainWindow);

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE_TEST) mainWindow.show();
  });

  // A desktop window opening an external link should use the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const relayConsole = (event) => {
    const level = typeof event?.level === 'number' ? event.level : event?.level;
    const message = event?.message ?? '';
    const isError = level === 3 || level === 'error';
    if (isError) console.error(`[renderer] ${message}`);
    else if (SMOKE_TEST) console.log(`[renderer:${level}] ${message}`);
  };
  mainWindow.webContents.on('console-message', relayConsole);

  await mainWindow.loadURL(url);
  buildMenu(mainWindow);
}

/**
 * Boots the app, verifies the page actually rendered, prints a JSON result and
 * exits. Used by `npm run desktop:smoke` so the packaging can be checked without
 * a human watching the window.
 */
async function runSmokeTest() {
  const result = await mainWindow.webContents.executeJavaScript(`(() => ({
    title: document.title,
    hasRoot: !!document.getElementById('root'),
    buttons: document.querySelectorAll('button').length,
    mapContainer: !!document.querySelector('.leaflet-container'),
    stylesheets: document.styleSheets.length,
    bridgeReachable: location.origin,
  }))()`);

  // The bridge is a separate process; give it a moment to bind.
  await new Promise((done) => setTimeout(done, 1200));

  let health = null;
  try {
    const response = await fetch('http://127.0.0.1:9000/health');
    health = await response.json();
  } catch (error) {
    health = { error: String(error?.message ?? error) };
  }

  const browser = findBrowser();
  console.log(
    `SMOKE_RESULT ${JSON.stringify({
      ...result,
      bridge: health,
      browser: browser ? browser.name : null,
    })}`
  );

  const ok = result.hasRoot && result.buttons > 0 && result.mapContainer;
  console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAILED');
  app.exit(ok ? 0 : 1);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

// A second launch should focus the existing window, not start a rival bridge.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    startBridge();

    const distDir = join(appRoot, 'dist');
    if (!existsSync(join(distDir, 'index.html'))) {
      dialog.showErrorBox(
        'Mesh Map is not built yet',
        `No index.html in ${distDir}.\n\nRun "npm run build" (or "npm run desktop", which builds first).`
      );
      app.exit(1);
      return;
    }

    // Preferred path: serve the app and open it in a real Chromium browser.
    const preferredPort = storedAppPort();
    staticServer = await startStaticServer(distDir, { preferredPort });
    if (staticServer.port !== preferredPort) {
      console.warn(
        `[launcher] port ${preferredPort} was busy; using ${staticServer.port}. ` +
          'A different origin means the app starts with default settings (and may re-ask for the serial port).'
      );
    }
    rememberAppPort(staticServer.port);
    launcherProcess = FORCE_EMBEDDED || SMOKE_TEST ? null : launchBrowser(staticServer.url);

    // Fallback (or an explicit --embedded): render inside this window.
    if (!launcherProcess) await createWindow(staticServer.url);

    if (SMOKE_TEST && mainWindow) {
      // Wait for the renderer to settle before inspecting it.
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          runSmokeTest().catch((error) => {
            console.error(`SMOKE_ERROR ${error?.message ?? error}`);
            app.exit(1);
          });
        }, 2500);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', async () => {
    stopBridge();
    if (launcherProcess && !launcherProcess.killed) launcherProcess.kill('SIGTERM');
    if (staticServer) await staticServer.close().catch(() => undefined);
  });

  app.on('before-quit', stopBridge);
}
