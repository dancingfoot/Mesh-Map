/**
 * Pure layout maths + persistence for the {@link Panel} chrome.
 *
 * Everything in this module is React-free and DOM-optional: it takes plain data
 * and returns plain data (the only outside dependency is `window.localStorage`,
 * guarded so it can also run in tests / during SSR-like evaluation). Moving it
 * out of `Panel.tsx` keeps the React component focused on rendering and pointer
 * gestures, and makes the geometry/persistence rules unit-testable.
 *
 * Layout (collapsed / floating / x / y / width / height) is persisted in
 * `localStorage` and read back defensively: malformed JSON, wrong types or
 * missing keys all fall back to the defaults instead of throwing.
 */

/** `localStorage` bucket holding every panel's persisted layout. */
export const STORAGE_KEY = 'meshmap:panel-layout:v1';

/** Persisted (and therefore untrusted) shape of a single panel's layout. */
export interface StoredPanelLayout {
  collapsed?: boolean;
  floating?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export type StoredPanelLayouts = Record<string, StoredPanelLayout>;

/** Live, fully-resolved layout of a mounted panel. */
export interface PanelLayoutState {
  collapsed: boolean;
  floating: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-panel defaults supplied through `PanelProps`. */
export interface PanelLayoutDefaults {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
}

/** Reads (and sanitises) the persisted layout map. Never throws. */
export function loadPanelLayout(): StoredPanelLayouts {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StoredPanelLayouts;
  } catch {
    return {};
  }
}

/** Read-modify-write so panels mounting at different times do not clobber each other. */
export function savePanelLayout(id: string, layout: StoredPanelLayout): void {
  try {
    if (typeof window === 'undefined') return;
    const all = loadPanelLayout();
    all[id] = layout;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage disabled / quota exceeded — layout simply does not persist */
  }
}

/** Removes every persisted panel layout (used by "Reset layout"). */
export function clearPanelLayout(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Clamps `value` into `[min, max]`; non-finite input falls back to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, min), upper);
}

/** Current viewport size, with a stable fallback when there is no `window`. */
export function viewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Deterministic starting position so stacked panels do not open exactly on top of each other. */
export function defaultFloatPosition(id: string, width: number): { x: number; y: number } {
  const { width: vw, height: vh } = viewport();
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const offset = (seed % 5) * 26;
  return {
    x: clamp(Math.round(vw / 2 - width / 2) + offset, 8, Math.max(8, vw - 140)),
    y: clamp(72 + offset, 8, Math.max(8, vh - 60)),
  };
}

/** Horizontal drag/restore clamp that keeps at least 120px of the panel reachable. */
export function clampPanelX(x: number, width: number, viewportWidth: number): number {
  return clamp(x, 120 - width, Math.max(8, viewportWidth - 140));
}

/** Vertical drag/restore clamp that keeps the header on screen. */
export function clampPanelY(y: number, viewportHeight: number): number {
  return clamp(y, 0, Math.max(8, viewportHeight - 48));
}

/** Resolves the initial layout of a mounted panel from stored + default values. */
export function resolveInitialLayout(
  id: string,
  stored: StoredPanelLayout | undefined,
  defaults: PanelLayoutDefaults
): PanelLayoutState {
  const { defaultWidth, defaultHeight, minWidth, minHeight } = defaults;
  const { width: vw, height: vh } = viewport();
  const width = clamp(
    typeof stored?.width === 'number' ? stored.width : defaultWidth,
    minWidth,
    Math.max(minWidth, vw)
  );
  const height = clamp(
    typeof stored?.height === 'number' ? stored.height : defaultHeight,
    minHeight,
    Math.max(minHeight, vh)
  );
  const fallback = defaultFloatPosition(id, width);
  return {
    collapsed: stored?.collapsed === true,
    floating: stored?.floating === true,
    width,
    height,
    x: clampPanelX(typeof stored?.x === 'number' ? stored.x : fallback.x, width, vw),
    y: clampPanelY(typeof stored?.y === 'number' ? stored.y : fallback.y, vh),
  };
}

/** Layout applied by the "Reset layout" nonce: defaults, docked and expanded. */
export function defaultPanelLayout(
  id: string,
  defaultWidth: number,
  defaultHeight: number
): PanelLayoutState {
  const fallback = defaultFloatPosition(id, defaultWidth);
  return {
    collapsed: false,
    floating: false,
    width: defaultWidth,
    height: defaultHeight,
    x: fallback.x,
    y: fallback.y,
  };
}

/**
 * Next layout for the float/dock toggle.
 *
 * When floating, re-clamps the current size to the viewport and keeps the panel
 * where it is if it is still (mostly) visible; otherwise it re-opens at the
 * deterministic default position.
 */
export function floatPanelLayout(
  prev: PanelLayoutState,
  id: string,
  minWidth: number,
  minHeight: number
): PanelLayoutState {
  if (prev.floating) return { ...prev, floating: false };
  const { width: vw, height: vh } = viewport();
  const width = clamp(prev.width, minWidth, Math.max(minWidth, vw - 24));
  const height = clamp(prev.height, minHeight, Math.max(minHeight, vh - 24));
  const inView = prev.x + width > 40 && prev.x < vw - 40 && prev.y >= 0 && prev.y < vh - 40;
  const fallback = defaultFloatPosition(id, width);
  return {
    ...prev,
    floating: true,
    width,
    height,
    x: inView ? prev.x : fallback.x,
    y: inView ? prev.y : fallback.y,
  };
}

/** Size produced by dragging the bottom-right resize handle. */
export function resolveResize(
  origin: { width: number; height: number },
  delta: { dx: number; dy: number },
  bounds: {
    x: number;
    y: number;
    minWidth: number;
    minHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  }
): { width: number; height: number } {
  const { x, y, minWidth, minHeight, viewportWidth, viewportHeight } = bounds;
  const maxWidth = Math.max(minWidth, viewportWidth - x - 8);
  const maxHeight = Math.max(minHeight, viewportHeight - y - 8);
  return {
    width: clamp(origin.width + delta.dx, minWidth, maxWidth),
    height: clamp(origin.height + delta.dy, minHeight, maxHeight),
  };
}
