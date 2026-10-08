import React, { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { GpsPoint } from '../types';
import { summariseNodes } from '../utils/nodes';
import { type NodeIdentityMap } from '../utils/nodeNames';
import {
  buildLegendData,
  currentMarkerHtml,
  currentPopupHtml,
  initialMapView,
  startMarkerHtml,
  startPopupHtml,
  timeWindowLabel,
  toLatLngs,
  traceTooltipHtml,
} from '../utils/mapLayers';
import { TimeWindowSelector } from './TimeWindowSelector';
import { usePanelView } from './Panel';
import { Maximize2, Minimize2, Layers, LocateFixed, RadioTower, X } from 'lucide-react';

interface FoliumMapProps {
  /**
   * Packets to draw: already filtered by time window and node visibility.
   * All traces/markers/legend derive from this list, one trace per node.
   */
  points: GpsPoint[];
  /** Total logged packets (unfiltered) so "N of M packets" stays discoverable. */
  totalCount?: number;
  autoCenter?: boolean;
  onToggleAutoCenter?: () => void;
  /** Selected time window in ms (`null` = All); the control lives in the map header. */
  timeWindowMs?: number | null;
  onTimeWindowChange?: (ms: number | null) => void;
  /**
   * Node-name map. When supplied, traces, tooltips, markers and popups show the
   * node's human name (e.g. `Inov_Bas`) instead of its raw address.
   */
  identities?: NodeIdentityMap;
  /**
   * Optional element rendered on top of the map surface (bottom-left), used for
   * the node list. Positioned by this component so it never fights Leaflet's own
   * controls.
   */
  overlay?: React.ReactNode;
}

/**
 * Leaflet map chrome.
 *
 * Everything that can be expressed as plain data (popup/marker HTML, trace
 * coordinates, legend model, initial view) lives in `../utils/mapLayers` and is
 * unit-tested there; this component keeps the map instance, the React state and
 * the imperative `L.*` effect that mutates it.
 */
export const FoliumMap: React.FC<FoliumMapProps> = ({
  points,
  totalCount,
  autoCenter = true,
  onToggleAutoCenter,
  timeWindowMs = null,
  onTimeWindowChange,
  identities,
  overlay,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const baseLayersRef = useRef<{ osm: L.TileLayer; satellite: L.TileLayer } | null>(null);
  const [activeLayer, setActiveLayer] = React.useState<'osm' | 'satellite'>('osm');
  const [isFullscreen, setIsFullscreen] = React.useState<boolean>(false);

  // When the map lives in a floating panel it fills the (resizable) body.
  const { floating } = usePanelView();

  const nodeSummaries = useMemo(() => summariseNodes(points, identities), [points, identities]);
  const legend = useMemo(() => buildLegendData(nodeSummaries), [nodeSummaries]);

  const total = totalCount ?? points.length;
  const windowLabel = timeWindowLabel(timeWindowMs);

  // Toggle Full Screen (CSS overlay — no browser fullscreen request needed)
  const handleToggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
  };

  // Resize Leaflet map when entering/exiting fullscreen
  useEffect(() => {
    const timer1 = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 50);
    const timer2 = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 250);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [isFullscreen]);

  // Keep Leaflet in sync with container size (panel resize, rail resize, dock/float)
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // rAF avoids "ResizeObserver loop completed with undelivered notifications".
      window.requestAnimationFrame(() => {
        mapInstanceRef.current?.invalidateSize();
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    // Default center (San Francisco)
    const { center, zoom } = initialMapView(points);

    const map = L.map(mapContainerRef.current, {
      center,
      zoom,
      zoomControl: false,
    });

    // Custom Zoom control at bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Scale control at bottom left (matching Folium control_scale=True)
    L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);

    // Base layers
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });

    const satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      }
    );

    osmLayer.addTo(map);
    baseLayersRef.current = { osm: osmLayer, satellite: satelliteLayer };

    const layerGroup = L.layerGroup().addTo(map);
    layerGroupRef.current = layerGroup;
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Switch Base Layer
  const handleToggleLayer = (layer: 'osm' | 'satellite') => {
    const map = mapInstanceRef.current;
    const baseLayers = baseLayersRef.current;
    if (!map || !baseLayers) return;

    if (layer === 'osm') {
      map.removeLayer(baseLayers.satellite);
      map.addLayer(baseLayers.osm);
    } else {
      map.removeLayer(baseLayers.osm);
      map.addLayer(baseLayers.satellite);
    }
    setActiveLayer(layer);
  };

  // Redraw one trace + start/current markers per VISIBLE node.
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    if (points.length === 0) return;

    const latestOverall = points[points.length - 1];

    for (const node of nodeSummaries) {
      const latLngs: [number, number][] = toLatLngs(node.points);

      // Per-node trace: white halo for contrast on satellite imagery, then
      // the node's own palette colour.
      if (latLngs.length > 1) {
        L.polyline(latLngs, {
          color: '#FFFFFF',
          weight: 7,
          opacity: 0.55,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layerGroup);

        const routeLine = L.polyline(latLngs, {
          color: node.color,
          weight: 3.5,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layerGroup);

        routeLine.bindTooltip(traceTooltipHtml(node), {
          sticky: true,
          className:
            'font-sans text-xs bg-slate-900 text-white border-0 px-2 py-1 rounded shadow-md',
        });
      }

      // Start marker of this node (first packet).
      const startPt = node.points[0];
      const startIcon = L.divIcon({
        className: 'custom-node-start-marker',
        html: startMarkerHtml(node),
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      L.marker([startPt.latitude, startPt.longitude], { icon: startIcon })
        .addTo(layerGroup)
        .bindPopup(startPopupHtml(node, startPt));

      // Current (latest) marker of this node.
      const currentPt = node.lastPoint;
      const isLatestNode = currentPt === latestOverall;
      const currentIcon = L.divIcon({
        className: 'custom-node-current-marker',
        html: currentMarkerHtml(node),
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      L.marker([currentPt.latitude, currentPt.longitude], {
        icon: currentIcon,
        zIndexOffset: isLatestNode ? 1000 : 400,
      })
        .addTo(layerGroup)
        .bindPopup(currentPopupHtml(node, currentPt));

      // Small accuracy halo around the node's latest fix.
      L.circle([currentPt.latitude, currentPt.longitude], {
        radius: 18,
        color: node.color,
        weight: 1.5,
        fillColor: node.color,
        fillOpacity: 0.12,
        dashArray: '4, 4',
      }).addTo(layerGroup);
    }

    // Auto-center on the newest fix across all visible nodes.
    if (autoCenter) {
      map.panTo([latestOverall.latitude, latestOverall.longitude], {
        animate: true,
        duration: 0.6,
      });
    }
  }, [points, nodeSummaries, autoCenter]);

  // Fit bounds helper (visible packets only)
  const handleFitBounds = () => {
    const map = mapInstanceRef.current;
    if (!map || points.length === 0) return;
    const latLngs: [number, number][] = toLatLngs(points);
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 16);
    } else {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 17 });
    }
  };

  const handleCenterLatest = () => {
    const map = mapInstanceRef.current;
    if (!map || points.length === 0) return;
    const latest = points[points.length - 1];
    map.setView([latest.latitude, latest.longitude], 16, { animate: true });
  };

  return (
    <div
      ref={mapWrapperRef}
      className={
        isFullscreen
          ? 'fixed inset-0 z-[5000] w-screen h-screen bg-slate-950 flex flex-col'
          : `relative w-full ${floating ? 'h-full min-h-[260px]' : 'h-[620px]'} flex flex-col bg-slate-800`
      }
    >
      {/* Map Header: time-window selector + packet accounting */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-slate-900 border-b border-slate-800 shrink-0 z-[420]">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <RadioTower className="w-3.5 h-3.5 text-blue-600" />
          <span>Live Node Traces</span>
        </span>

        {onTimeWindowChange && (
          <TimeWindowSelector value={timeWindowMs} onChange={onTimeWindowChange} />
        )}

        <span className="ml-auto text-[11px] font-mono text-slate-400 whitespace-nowrap">
          {points.length} of {total} packets
          <span className="text-slate-400">
            {' '}
            · window {windowLabel} · {nodeSummaries.length} node
            {nodeSummaries.length === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      {/* Map surface */}
      <div className="relative flex-1 min-h-0">
        {/* Real Leaflet container */}
        <div ref={mapContainerRef} className="absolute inset-0 z-0" />

        {/*
          Caller-supplied overlay (the node list lives here). Anchored bottom-left
          because Leaflet's zoom control and the map-view switch own the top-left,
          the HUD buttons own the top-right and the legend owns the bottom-right.
        */}
        {overlay && <div className="absolute bottom-14 left-4 z-[440] max-w-[70%]">{overlay}</div>}

        {/* Floating Center Badge in Full Screen Mode */}
        {isFullscreen && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[450] bg-white/85 backdrop-blur-md text-slate-700 px-4 py-1.5 rounded-full border border-white/70 shadow-xl text-xs flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold">Full Screen Map Active</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-400">ESC to exit</span>
            <button
              onClick={handleToggleFullscreen}
              className="ml-1 p-1 hover:bg-white rounded-full text-slate-500 hover:text-slate-800"
              title="Exit full screen"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Floating HUD Controls (Street / Satellite) */}
        <div className="absolute top-4 left-4 z-[400] flex items-center gap-2 bg-white/75 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/70 shadow-sm text-xs">
          <span className="font-semibold text-slate-600">Map View:</span>
          <button
            onClick={() => handleToggleLayer('osm')}
            className={`px-2 py-1 rounded font-medium transition-colors ${
              activeLayer === 'osm'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Street
          </button>
          <button
            onClick={() => handleToggleLayer('satellite')}
            className={`px-2 py-1 rounded font-medium transition-colors ${
              activeLayer === 'satellite'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Satellite
          </button>
        </div>

        {/* Top Right Quick Actions */}
        <div className="absolute top-4 right-4 z-[400] flex items-center gap-2">
          {/* REQUIREMENT: Add a button to full screen the map */}
          <button
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Exit Full Screen (Esc)' : 'Full Screen Map View'}
            className={`flex items-center gap-1.5 backdrop-blur-md px-3 py-1.5 rounded-lg border shadow-sm text-xs font-semibold transition-colors ${
              isFullscreen
                ? 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500'
                : 'bg-white/80 border-white/70 text-slate-700 hover:bg-white'
            }`}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5 text-white" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5 text-blue-600" />
            )}
            <span>{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>

          <button
            onClick={handleFitBounds}
            disabled={points.length === 0}
            title="Fit entire route bounds"
            className="flex items-center gap-1.5 bg-white/75 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/70 shadow-sm text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5 text-blue-600" />
            <span>Fit Route</span>
          </button>

          <button
            onClick={handleCenterLatest}
            disabled={points.length === 0}
            title="Center on latest location"
            className="flex items-center gap-1.5 bg-white/75 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/70 shadow-sm text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 transition-colors"
          >
            <LocateFixed className="w-3.5 h-3.5 text-red-600" />
            <span>Latest Pin</span>
          </button>

          {onToggleAutoCenter && (
            <button
              onClick={onToggleAutoCenter}
              title={autoCenter ? 'Auto-centering is ON' : 'Auto-centering is OFF'}
              className={`flex items-center gap-1.5 backdrop-blur-md px-3 py-1.5 rounded-lg border shadow-sm text-xs font-medium transition-colors ${
                autoCenter
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : 'bg-white/80 border-white/70 text-slate-500'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${autoCenter ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`}
              />
              <span>Auto-Center</span>
            </button>
          )}
        </div>

        {/* Legend: one row per visible node, colour-matched to its trace */}
        <div className="absolute bottom-5 right-14 z-[400] bg-white/80 backdrop-blur-md px-3 py-2 rounded-lg border border-white/70 shadow-md text-xs flex flex-col gap-1.5 max-w-[240px]">
          <div className="flex items-center gap-1.5 text-slate-700 font-semibold">
            <Layers className="w-3 h-3 text-blue-600" />
            <span>Visible nodes ({legend.length})</span>
          </div>
          {legend.length === 0 ? (
            <span className="text-[11px] text-slate-500">No packets displayed</span>
          ) : (
            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-0.5">
              {legend.map((entry) => (
                <div key={entry.key} className="flex items-center gap-2">
                  <span
                    className="w-4 h-1 rounded shrink-0"
                    style={{ backgroundColor: entry.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="w-2 h-2 rounded-full shrink-0 border border-slate-400"
                    style={{ backgroundColor: entry.color }}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-[11px] text-slate-700 truncate max-w-[110px]">
                    {entry.label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400 tabular-nums">
                    {entry.count}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="pt-1 border-t border-slate-300/60 flex items-center gap-2 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="text-[8px]">▶</span> start
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-[8px]">●</span> latest
            </span>
          </div>
        </div>

        {/* Empty State Overlay */}
        {points.length === 0 && (
          <div className="absolute inset-0 z-[300] bg-slate-900/20 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
            <div className="bg-white/85 px-6 py-4 rounded-xl border border-white/70 shadow-lg text-center max-w-sm">
              <div className="text-2xl mb-1">{total > 0 ? '🔍' : '📡'}</div>
              <h4 className="text-sm font-semibold text-slate-100">
                {total > 0 ? 'No packets match the current filters' : 'Awaiting Meshtastic GPS Fix'}
              </h4>
              <p className="text-xs text-slate-400 mt-1">
                {total > 0 ? (
                  <>
                    {total} packets are logged, but none are inside the selected time window or
                    visible-node set. Widen the window or show more nodes.
                  </>
                ) : (
                  <>
                    Connect a serial node or click <strong>"Start Demo"</strong> in the left rail to
                    stream simulated coordinates.
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
