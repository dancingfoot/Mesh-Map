import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  GripVertical,
  PictureInPicture2,
} from 'lucide-react';
import {
  clampPanelX,
  clampPanelY,
  defaultPanelLayout,
  floatPanelLayout,
  loadPanelLayout,
  resolveInitialLayout,
  resolveResize,
  savePanelLayout,
  viewport,
} from './panelLayout';
import type { PanelLayoutState } from './panelLayout';

/**
 * Reusable chrome for every dashboard panel.
 *
 * Features
 * --------
 * - **collapse / expand** — chevron in the header, collapsed = header only.
 * - **float / dock** — the PIP button detaches the panel into a free-floating
 *   window (`position: fixed`, so it escapes the scrolling rail for real);
 *   the same button (now "dock") returns it to its slot in the layout.
 * - **move** — while floating, the header can be dragged with pointer events.
 *   A docked panel is not draggable (its slot is part of the page flow).
 * - **resize** — while floating, the bottom-right corner handle changes the
 *   window size (min sizes enforced). The docked left rail is resized by its
 *   own edge handle in `App.tsx`.
 *
 * Layout (collapsed / floating / x / y / width / height) is persisted in
 * `localStorage` and read back defensively: malformed JSON, wrong types or
 * missing keys all fall back to the defaults instead of throwing. The
 * storage/geometry half of that lives in `panelLayout.ts` (pure + tested); this
 * file owns the React state, the contexts and the pointer gestures.
 *
 * `PanelResetContext` carries a counter; `App` bumps it after clearing storage
 * so every mounted panel snaps back to its default layout.
 */

export { clearPanelLayout } from './panelLayout';

/** z-index stack for floating windows (kept below the fullscreen map at 5000). */
let floatingZCounter = 3200;

/** Counter that, when changed, makes every mounted panel restore its defaults. */
export const PanelResetContext = createContext<number>(0);

/** Lets children (e.g. the Leaflet map) adapt to a floating, fixed-height body. */
export interface PanelViewContext {
  floating: boolean;
  collapsed: boolean;
}

export const PanelViewContext = createContext<PanelViewContext>({
  floating: false,
  collapsed: false,
});

/** Access the surrounding panel's view state (defaults outside a panel). */
export function usePanelView(): PanelViewContext {
  return useContext(PanelViewContext);
}

export interface PanelProps {
  /** Stable persistence id — must be unique per panel instance. */
  id: string;
  title: string;
  icon?: React.ReactNode;
  /** Slot rendered on the right side of the header (badges, buttons, …). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** `dark` matches the left rail, `light` the main workspace. */
  variant?: 'light' | 'dark';
  className?: string;
  bodyClassName?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  collapsible?: boolean;
  floatable?: boolean;
  resizable?: boolean;
  /** Hides the float button (docked-only panels). */
  hideFloatButton?: boolean;
}

export const Panel: React.FC<PanelProps> = ({
  id,
  title,
  icon,
  actions,
  children,
  variant = 'light',
  className = '',
  bodyClassName = 'p-3 overflow-auto',
  defaultWidth = 360,
  defaultHeight = 320,
  minWidth = 220,
  minHeight = 140,
  collapsible = true,
  floatable = true,
  resizable = true,
  hideFloatButton = false,
}) => {
  const resetNonce = useContext(PanelResetContext);

  const [layout, setLayout] = useState<PanelLayoutState>(() =>
    resolveInitialLayout(id, loadPanelLayout()[id], {
      defaultWidth,
      defaultHeight,
      minWidth,
      minHeight,
    })
  );

  // Latest layout for gesture-end persistence (state updates are async).
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // True while dragging/resizing: skip per-frame writes, persist on pointer-up.
  const gestureRef = useRef(false);

  useEffect(() => {
    if (gestureRef.current) return;
    savePanelLayout(id, layout);
  }, [id, layout]);

  // "Reset layout" support: restore defaults whenever the nonce changes.
  const lastResetRef = useRef(resetNonce);
  useEffect(() => {
    if (resetNonce === lastResetRef.current) return;
    lastResetRef.current = resetNonce;
    gestureRef.current = false;
    setLayout(defaultPanelLayout(id, defaultWidth, defaultHeight));
  }, [resetNonce, id, defaultWidth, defaultHeight]);

  const [zIndex, setZIndex] = useState<number>(floatingZCounter);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const raisable = useCallback(() => {
    floatingZCounter += 1;
    setZIndex(floatingZCounter);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setLayout((prev) => ({ ...prev, collapsed: !prev.collapsed }));
  }, []);

  const toggleFloat = useCallback(() => {
    setLayout((prev) => floatPanelLayout(prev, id, minWidth, minHeight));
    raisable();
  }, [id, minHeight, minWidth, raisable]);

  // ---------------------------------------------------------------- drag ----
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!layout.floating) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: layout.x,
      originY: layout.y,
    };
    gestureRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — dragging still works via pointermove */
    }
    setDragging(true);
    raisable();
  };

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const { width: vw, height: vh } = viewport();
    const nextX = clampPanelX(drag.originX + (e.clientX - drag.startX), layout.width, vw);
    const nextY = clampPanelY(drag.originY + (e.clientY - drag.startY), vh);
    setLayout((prev) => ({ ...prev, x: nextX, y: nextY }));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    gestureRef.current = false;
    savePanelLayout(id, layoutRef.current);
  };

  // -------------------------------------------------------------- resize ----
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!layout.floating) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originW: layout.width,
      originH: layout.height,
    };
    gestureRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — resizing still works via pointermove */
    }
    setResizing(true);
    raisable();
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    const { width: vw, height: vh } = viewport();
    const next = resolveResize(
      { width: resize.originW, height: resize.originH },
      { dx: e.clientX - resize.startX, dy: e.clientY - resize.startY },
      { x: layout.x, y: layout.y, minWidth, minHeight, viewportWidth: vw, viewportHeight: vh }
    );
    setLayout((prev) => ({ ...prev, width: next.width, height: next.height }));
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    setResizing(false);
    gestureRef.current = false;
    savePanelLayout(id, layoutRef.current);
  };

  // -------------------------------------------------------------- styles ----
  const isDark = variant === 'dark';
  const shellTone = isDark
    ? 'bg-slate-950/70 border-slate-800 text-slate-200'
    : 'bg-slate-900 border-slate-800 text-slate-100 shadow-sm';
  const headerTone = isDark
    ? 'bg-slate-900/80 border-slate-800 text-slate-200'
    : 'bg-slate-950 border-slate-800 text-slate-300';
  const iconTone = isDark ? 'text-blue-400' : 'text-blue-600';
  const controlTone = isDark
    ? 'text-slate-400 hover:text-white hover:bg-slate-800'
    : 'text-slate-400 hover:text-white hover:bg-slate-700/70';

  const buttonClass = `p-1 rounded-md transition-colors ${controlTone}`;

  const header = (
    <div
      onPointerDown={handleHeaderPointerDown}
      onPointerMove={handleHeaderPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={floatable ? toggleFloat : undefined}
      title={layout.floating ? 'Drag to move · double-click to dock' : 'Double-click to float'}
      className={`flex items-center gap-2 px-3 py-2 border-b select-none shrink-0 ${headerTone} ${
        layout.floating ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      style={{ touchAction: layout.floating ? 'none' : undefined }}
    >
      {collapsible && (
        <button
          type="button"
          onClick={toggleCollapsed}
          className={buttonClass}
          title={layout.collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-expanded={!layout.collapsed}
        >
          {layout.collapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>
      )}

      {icon && <span className={`shrink-0 ${iconTone}`}>{icon}</span>}
      <span className="text-xs font-semibold truncate">{title}</span>
      {layout.floating && <GripVertical className="w-3 h-3 opacity-40 shrink-0" />}

      <div className="ml-auto flex items-center gap-1 shrink-0">
        {actions}
        {floatable && !hideFloatButton && (
          <button
            type="button"
            onClick={toggleFloat}
            className={buttonClass}
            title={layout.floating ? 'Dock panel back into the layout' : 'Float panel (detach)'}
            aria-label={layout.floating ? 'Dock panel' : 'Float panel'}
          >
            {layout.floating ? (
              <CornerDownLeft className="w-3.5 h-3.5" />
            ) : (
              <PictureInPicture2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );

  const floatingWindow = layout.floating ? (
    <div
      className={`fixed flex flex-col rounded-xl border shadow-2xl overflow-hidden ${shellTone} ${className}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.collapsed ? undefined : layout.height,
        zIndex: dragging || resizing ? 4000 : zIndex,
      }}
      onPointerDownCapture={raisable}
    >
      {header}
      {!layout.collapsed && (
        <PanelViewContext.Provider value={{ floating: true, collapsed: false }}>
          <div className={`flex-1 min-h-0 flex flex-col ${bodyClassName}`}>{children}</div>
        </PanelViewContext.Provider>
      )}
      {resizable && !layout.collapsed && (
        <div
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          title="Drag to resize"
          aria-label="Resize panel"
          role="separator"
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
          style={{ touchAction: 'none' }}
        >
          <svg viewBox="0 0 16 16" className="w-4 h-4 opacity-50" aria-hidden="true">
            <path d="M15 6 L6 15 M15 11 L11 15" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      )}
    </div>
  ) : null;

  if (layout.floating) {
    return (
      <>
        {floatingWindow}
        {/* In-flow anchor so floating a panel does not collapse the layout. */}
        <div
          className={`flex items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-[11px] ${
            isDark
              ? 'border-slate-700 bg-slate-950/40 text-slate-400'
              : 'border-slate-700 bg-slate-950 text-slate-400'
          }`}
        >
          {icon && <span className={iconTone}>{icon}</span>}
          <span className="font-semibold truncate">{title}</span>
          <span className="opacity-70">· floating</span>
          <button
            type="button"
            onClick={toggleFloat}
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors ${
              isDark
                ? 'border-slate-700 hover:bg-slate-800 text-slate-300'
                : 'border-slate-700 hover:bg-slate-700 text-slate-400'
            }`}
          >
            <CornerDownLeft className="w-3 h-3" />
            <span>Dock</span>
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={`relative flex flex-col rounded-xl border overflow-hidden ${shellTone} ${className}`}>
      {header}
      {!layout.collapsed && (
        <PanelViewContext.Provider value={{ floating: false, collapsed: false }}>
          <div className={bodyClassName}>{children}</div>
        </PanelViewContext.Provider>
      )}
    </div>
  );
};
