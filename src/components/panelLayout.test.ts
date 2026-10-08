import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEY,
  clamp,
  clampPanelX,
  clampPanelY,
  clearPanelLayout,
  defaultFloatPosition,
  defaultPanelLayout,
  floatPanelLayout,
  loadPanelLayout,
  resolveInitialLayout,
  resolveResize,
  savePanelLayout,
  viewport,
} from './panelLayout';
import type { PanelLayoutState } from './panelLayout';

// ------------------------------------------------------------------ helpers ---

/** Minimal in-memory `Storage` stand-in (jsdom is not installed in this repo). */
function createStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string): void => void map.set(key, String(value)),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    get length(): number {
      return map.size;
    },
    /** Raw view, for asserting on the persisted JSON. */
    raw: map,
  };
}

function installWindow(storage = createStorage(), width = 1280, height = 800) {
  vi.stubGlobal('window', { localStorage: storage, innerWidth: width, innerHeight: height });
  return storage;
}

const DEFAULTS = { defaultWidth: 360, defaultHeight: 320, minWidth: 220, minHeight: 140 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------- clamp ----

describe('clamp', () => {
  it('keeps values inside the bounds and pins outside ones', () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(500, 0, 100)).toBe(100);
  });

  it('falls back to min for non-finite input', () => {
    expect(clamp(Number.NaN, 7, 100)).toBe(7);
    expect(clamp(Number.POSITIVE_INFINITY, 7, 100)).toBe(7);
  });

  it('tolerates an inverted range', () => {
    expect(clamp(50, 100, 10)).toBe(100);
  });

  it('clampPanelX keeps 120px of the panel reachable', () => {
    expect(clampPanelX(0, 360, 1280)).toBe(0);
    expect(clampPanelX(-9999, 360, 1280)).toBe(120 - 360);
    expect(clampPanelX(9999, 360, 1280)).toBe(1280 - 140);
  });

  it('clampPanelY keeps the header on screen', () => {
    expect(clampPanelY(-50, 800)).toBe(0);
    expect(clampPanelY(9999, 800)).toBe(800 - 48);
  });
});

// ---------------------------------------------------------------- viewport ----

describe('viewport', () => {
  it('reads the window size', () => {
    installWindow(createStorage(), 1024, 768);
    expect(viewport()).toEqual({ width: 1024, height: 768 });
  });

  it('falls back to a stable size without a window', () => {
    expect(typeof window).toBe('undefined');
    expect(viewport()).toEqual({ width: 1280, height: 800 });
  });
});

// ------------------------------------------------------------ persistence ----

describe('panel layout persistence', () => {
  it('returns an empty map when nothing is stored', () => {
    installWindow();
    expect(loadPanelLayout()).toEqual({});
  });

  it('never throws on malformed JSON and returns defaults', () => {
    installWindow(createStorage({ [STORAGE_KEY]: '{not valid json' }));
    expect(() => loadPanelLayout()).not.toThrow();
    expect(loadPanelLayout()).toEqual({});
  });

  it('rejects non-object payloads instead of leaking them', () => {
    for (const payload of ['[1,2,3]', '"a string"', 'null', '42', 'true']) {
      installWindow(createStorage({ [STORAGE_KEY]: payload }));
      expect(loadPanelLayout()).toEqual({});
    }
  });

  it('round-trips a saved layout and does not clobber sibling panels', () => {
    const storage = installWindow();
    savePanelLayout('alpha', { floating: true, x: 10, y: 20, width: 300, height: 200 });
    savePanelLayout('beta', { collapsed: true });

    const loaded = loadPanelLayout();
    expect(loaded.alpha).toEqual({ floating: true, x: 10, y: 20, width: 300, height: 200 });
    expect(loaded.beta).toEqual({ collapsed: true });
    expect(JSON.parse(storage.raw.get(STORAGE_KEY)!)).toHaveProperty('alpha');

    // Malformed foreign entries alongside valid ones must not break the read.
    storage.raw.set(STORAGE_KEY, '{"alpha":{"x":10},"beta":"nope"}');
    expect(loadPanelLayout().alpha).toEqual({ x: 10 });
  });

  it('clearPanelLayout removes every persisted layout', () => {
    const storage = installWindow();
    savePanelLayout('alpha', { x: 1 });
    expect(storage.raw.has(STORAGE_KEY)).toBe(true);

    clearPanelLayout();
    expect(storage.raw.has(STORAGE_KEY)).toBe(false);
    expect(loadPanelLayout()).toEqual({});
  });

  it('is a no-op without a window', () => {
    expect(loadPanelLayout()).toEqual({});
    expect(() => savePanelLayout('alpha', { x: 1 })).not.toThrow();
    expect(() => clearPanelLayout()).not.toThrow();
  });
});

// ----------------------------------------------------------- float position ----

describe('defaultFloatPosition', () => {
  it('is deterministic for a given id', () => {
    installWindow();
    expect(defaultFloatPosition('panel-a', 360)).toEqual({ x: 512, y: 124 });
    expect(defaultFloatPosition('panel-a', 360)).toEqual(defaultFloatPosition('panel-a', 360));
  });

  it('offsets different ids so stacked panels do not overlap exactly', () => {
    installWindow();
    expect(defaultFloatPosition('panel-b', 360)).toEqual({ x: 538, y: 150 });
    expect(defaultFloatPosition('panel-b', 360)).not.toEqual(defaultFloatPosition('panel-a', 360));
  });

  it('stays finite for ids far longer than the offset seed range', () => {
    installWindow();
    const long = defaultFloatPosition('!'.repeat(2000) + 'node', 360);
    expect(Number.isFinite(long.x)).toBe(true);
    expect(Number.isFinite(long.y)).toBe(true);
  });
});

// --------------------------------------------------------- initial layout ----

describe('resolveInitialLayout', () => {
  it('uses the defaults when nothing is stored', () => {
    installWindow();
    const layout = resolveInitialLayout('telemetry', undefined, DEFAULTS);
    expect(layout.collapsed).toBe(false);
    expect(layout.floating).toBe(false);
    expect(layout.width).toBe(360);
    expect(layout.height).toBe(320);
    expect(layout.x).toBe(defaultFloatPosition('telemetry', 360).x);
    expect(layout.y).toBe(defaultFloatPosition('telemetry', 360).y);
  });

  it('clamps stored geometry so the panel stays reachable', () => {
    installWindow();
    const layout = resolveInitialLayout(
      'telemetry',
      { x: -9999, y: 9999, width: 99999, height: 1, floating: true },
      DEFAULTS
    );
    expect(layout.floating).toBe(true);
    expect(layout.width).toBe(1280);
    expect(layout.height).toBe(140);
    expect(layout.x).toBe(120 - layout.width);
    expect(layout.y).toBe(800 - 48);
  });

  it('ignores wrong-typed stored fields instead of throwing', () => {
    installWindow();
    const stored = {
      collapsed: 'yes',
      floating: 1,
      x: 'nope',
      y: null,
      width: null,
      height: {},
    } as unknown as Parameters<typeof resolveInitialLayout>[1];
    const layout = resolveInitialLayout('telemetry', stored, DEFAULTS);
    expect(layout.collapsed).toBe(false);
    expect(layout.floating).toBe(false);
    expect(layout.width).toBe(360);
    expect(layout.height).toBe(320);
    expect(Number.isFinite(layout.x)).toBe(true);
  });
});

// ----------------------------------------------------------- panel actions ----

describe('defaultPanelLayout', () => {
  it('restores docked, expanded defaults', () => {
    installWindow();
    const layout = defaultPanelLayout('map', 500, 400);
    expect(layout).toEqual({
      collapsed: false,
      floating: false,
      width: 500,
      height: 400,
      x: defaultFloatPosition('map', 500).x,
      y: defaultFloatPosition('map', 500).y,
    });
  });
});

describe('floatPanelLayout', () => {
  const floating: PanelLayoutState = {
    collapsed: false,
    floating: true,
    x: 40,
    y: 60,
    width: 300,
    height: 200,
  };

  it('docks an already floating panel without touching its geometry', () => {
    installWindow();
    expect(floatPanelLayout(floating, 'map', 220, 140)).toEqual({ ...floating, floating: false });
  });

  it('keeps an on-screen position when floating', () => {
    installWindow();
    const result = floatPanelLayout({ ...floating, floating: false }, 'map', 220, 140);
    expect(result.floating).toBe(true);
    expect(result.x).toBe(40);
    expect(result.y).toBe(60);
  });

  it('falls back to the deterministic position when off-screen', () => {
    installWindow();
    const result = floatPanelLayout(
      { collapsed: false, floating: false, x: 5000, y: -500, width: 300, height: 200 },
      'map',
      220,
      140
    );
    expect(result.x).toBe(defaultFloatPosition('map', 300).x);
    expect(result.y).toBe(defaultFloatPosition('map', 300).y);
  });
});

describe('resolveResize', () => {
  const bounds = {
    x: 100,
    y: 100,
    minWidth: 220,
    minHeight: 140,
    viewportWidth: 1280,
    viewportHeight: 800,
  };

  it('applies the pointer delta', () => {
    expect(
      resolveResize({ width: 300, height: 200 }, { dx: 50, dy: -25 }, bounds)
    ).toEqual({ width: 350, height: 175 });
  });

  it('never goes below the minimum size', () => {
    expect(
      resolveResize({ width: 300, height: 200 }, { dx: -9999, dy: -9999 }, bounds)
    ).toEqual({ width: 220, height: 140 });
  });

  it('stops at the viewport edge', () => {
    const grown = resolveResize({ width: 300, height: 200 }, { dx: 9999, dy: 9999 }, bounds);
    expect(grown.width).toBe(1280 - 100 - 8);
    expect(grown.height).toBe(800 - 100 - 8);
  });
});
