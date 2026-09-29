import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { GpsPoint } from '../types';
import { Maximize2, Minimize2, Layers, LocateFixed, Eye, X } from 'lucide-react';

interface FoliumMapProps {
  points: GpsPoint[];
  autoCenter?: boolean;
  onToggleAutoCenter?: () => void;
}

export const FoliumMap: React.FC<FoliumMapProps> = ({
  points,
  autoCenter = true,
  onToggleAutoCenter,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const polylineOutlineRef = useRef<L.Polyline | null>(null);
  const baseLayersRef = useRef<{ osm: L.TileLayer; satellite: L.TileLayer } | null>(null);
  const [activeLayer, setActiveLayer] = React.useState<'osm' | 'satellite'>('osm');
  const [isFullscreen, setIsFullscreen] = React.useState<boolean>(false);

  // Toggle Full Screen (supports HTML5 fullscreen + CSS overlay fallback)
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
    const initialLat = points.length > 0 ? points[points.length - 1].latitude : 37.7749;
    const initialLon = points.length > 0 ? points[points.length - 1].longitude : -122.4194;
    const initialZoom = points.length > 0 ? 15 : 13;

    const map = L.map(mapContainerRef.current, {
      center: [initialLat, initialLon],
      zoom: initialZoom,
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

  // Update Path and Markers whenever points change
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    if (points.length === 0) {
      polylineRef.current = null;
      polylineOutlineRef.current = null;
      return;
    }

    const latLngs: [number, number][] = points.map((p) => [p.latitude, p.longitude]);

    // Continuous PolyLine path trace line representing route taken today
    if (latLngs.length > 1) {
      // High contrast white halo outline
      const outline = L.polyline(latLngs, {
        color: '#FFFFFF',
        weight: 7,
        opacity: 0.6,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(layerGroup);
      polylineOutlineRef.current = outline;

      // Laser cobalt route PolyLine
      const routeLine = L.polyline(latLngs, {
        color: '#2563EB',
        weight: 4,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(layerGroup);
      polylineRef.current = routeLine;

      routeLine.bindTooltip(`Today's Route (${points.length} points logged)`, {
        sticky: true,
        className: 'font-sans text-xs bg-slate-900 text-white border-0 px-2 py-1 rounded shadow-md',
      });
    }

    // 1. Green Start Marker (fa-play equivalent)
    const startPt = points[0];
    const startIcon = L.divIcon({
      className: 'custom-start-marker',
      html: `
        <div style="
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: #059669;
          border: 3px solid #FFFFFF;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-weight: bold;
          font-size: 14px;
        ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const startMarker = L.marker([startPt.latitude, startPt.longitude], { icon: startIcon }).addTo(layerGroup);
    startMarker.bindPopup(`
      <div style="font-family: system-ui, sans-serif; min-width: 180px; padding: 2px;">
        <div style="font-size: 11px; font-weight: 700; color: #059669; text-transform: uppercase; margin-bottom: 4px;">
          ▶ START LOCATION
        </div>
        <div style="font-size: 13px; font-weight: 600; color: #0f172a; margin-bottom: 2px;">
          ${startPt.latitude.toFixed(6)}°, ${startPt.longitude.toFixed(6)}°
        </div>
        <div style="font-size: 12px; color: #64748b; line-height: 1.4;">
          Time: ${new Date(startPt.timestamp).toLocaleTimeString()}<br/>
          Alt: ${startPt.altitude !== null ? `${startPt.altitude} m` : 'N/A'}<br/>
          Source: ${startPt.source}
        </div>
      </div>
    `);

    // 2. Red Current Location Marker (crosshairs / pulse)
    const currentPt = points[points.length - 1];
    const currentIcon = L.divIcon({
      className: 'custom-current-marker',
      html: `
        <div style="position: relative; width: 34px; height: 34px;">
          <!-- Pulsing ripple effect -->
          <div style="
            position: absolute;
            top: 0;
            left: 0;
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: rgba(239, 68, 68, 0.4);
            animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
          "></div>
          <!-- Center Red Marker -->
          <div style="
            position: relative;
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: #DC2626;
            border: 3px solid #FFFFFF;
            box-shadow: 0 4px 12px rgba(220, 38, 38, 0.45);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="22" y1="12" x2="18" y2="12"></line>
              <line x1="6" y1="12" x2="2" y2="12"></line>
              <line x1="12" y1="6" x2="12" y2="2"></line>
              <line x1="12" y1="22" x2="12" y2="18"></line>
            </svg>
          </div>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    const currentMarker = L.marker([currentPt.latitude, currentPt.longitude], { icon: currentIcon }).addTo(layerGroup);
    currentMarker.bindPopup(`
      <div style="font-family: system-ui, sans-serif; min-width: 200px; padding: 2px;">
        <div style="font-size: 11px; font-weight: 700; color: #DC2626; text-transform: uppercase; margin-bottom: 4px;">
          ● CURRENT LOCATION (LATEST)
        </div>
        <div style="font-size: 13px; font-weight: 600; color: #0f172a; margin-bottom: 4px;">
          ${currentPt.latitude.toFixed(6)}°, ${currentPt.longitude.toFixed(6)}°
        </div>
        <div style="font-size: 12px; color: #475569; line-height: 1.5;">
          <strong>Time:</strong> ${new Date(currentPt.timestamp).toLocaleTimeString()}<br/>
          <strong>Altitude:</strong> ${currentPt.altitude !== null ? `${currentPt.altitude} m` : 'N/A'}<br/>
          <strong>Speed:</strong> ${currentPt.speed_kmh !== null ? `${currentPt.speed_kmh} km/h` : 'N/A'}<br/>
          <strong>Source:</strong> ${currentPt.source}<br/>
          ${currentPt.node_id ? `<strong>Node:</strong> ${currentPt.node_id}<br/>` : ''}
          ${currentPt.satellites ? `<strong>Sats:</strong> ${currentPt.satellites}<br/>` : ''}
        </div>
      </div>
    `);

    // Accuracy Circle
    L.circle([currentPt.latitude, currentPt.longitude], {
      radius: 18,
      color: '#EF4444',
      weight: 1.5,
      fillColor: '#EF4444',
      fillOpacity: 0.15,
      dashArray: '4, 4',
    }).addTo(layerGroup);

    // Auto-center map if enabled
    if (autoCenter) {
      map.panTo([currentPt.latitude, currentPt.longitude], { animate: true, duration: 0.6 });
    }
  }, [points, autoCenter]);

  // Fit bounds helper
  const handleFitBounds = () => {
    const map = mapInstanceRef.current;
    if (!map || points.length === 0) return;
    const latLngs: [number, number][] = points.map((p) => [p.latitude, p.longitude]);
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
          ? "fixed inset-0 z-[5000] w-screen h-screen bg-slate-950 flex flex-col"
          : "relative w-full h-[620px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm bg-slate-100 dark:bg-slate-900"
      }
    >
      {/* Real Leaflet container */}
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Floating Center Badge in Full Screen Mode */}
      {isFullscreen && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[450] bg-slate-900/95 backdrop-blur-md text-white px-4 py-1.5 rounded-full border border-slate-700 shadow-xl text-xs flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-semibold">Full Screen Map Active</span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">ESC to exit</span>
          <button
            onClick={handleToggleFullscreen}
            className="ml-1 p-1 hover:bg-slate-800 rounded-full text-slate-300 hover:text-white"
            title="Exit full screen"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Floating HUD Controls (Street / Satellite) */}
      <div className="absolute top-4 left-4 z-[400] flex items-center gap-2 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm text-xs">
        <span className="font-semibold text-slate-800 dark:text-slate-200">Map View:</span>
        <button
          onClick={() => handleToggleLayer('osm')}
          className={`px-2 py-1 rounded font-medium transition-colors ${
            activeLayer === 'osm'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Street
        </button>
        <button
          onClick={() => handleToggleLayer('satellite')}
          className={`px-2 py-1 rounded font-medium transition-colors ${
            activeLayer === 'satellite'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
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
          title={isFullscreen ? "Exit Full Screen (Esc)" : "Full Screen Map View"}
          className={`flex items-center gap-1.5 backdrop-blur-md px-3 py-1.5 rounded-lg border shadow-sm text-xs font-semibold transition-colors ${
            isFullscreen
              ? 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500'
              : 'bg-white/95 dark:bg-slate-900/95 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          {isFullscreen ? (
            <Minimize2 className="w-3.5 h-3.5 text-white" />
          ) : (
            <Maximize2 className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          )}
          <span>{isFullscreen ? "Exit Full Screen" : "Full Screen"}</span>
        </button>

        <button
          onClick={handleFitBounds}
          disabled={points.length === 0}
          title="Fit entire route bounds"
          className="flex items-center gap-1.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5 text-blue-600" />
          <span>Fit Route</span>
        </button>

        <button
          onClick={handleCenterLatest}
          disabled={points.length === 0}
          title="Center on latest location"
          className="flex items-center gap-1.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
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
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
                : 'bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${autoCenter ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            <span>Auto-Center</span>
          </button>
        )}
      </div>

      {/* Legend at bottom right */}
      <div className="absolute bottom-5 right-14 z-[400] bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 shadow-md text-xs flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-emerald-600 flex items-center justify-center text-[8px] text-white font-bold">▶</div>
          <span className="text-slate-700 dark:text-slate-300 font-medium">Start Marker</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-600 flex items-center justify-center text-[8px] text-white font-bold">●</div>
          <span className="text-slate-700 dark:text-slate-300 font-medium">Current Location</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-1 bg-blue-600 rounded"></div>
          <span className="text-slate-700 dark:text-slate-300 font-medium">PolyLine Path Trace</span>
        </div>
      </div>

      {/* Empty State Overlay */}
      {points.length === 0 && (
        <div className="absolute inset-0 z-[300] bg-slate-900/20 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
          <div className="bg-white/95 dark:bg-slate-900/95 px-6 py-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-lg text-center max-w-sm">
            <div className="text-2xl mb-1">📡</div>
            <h4 className="text-sm font-semibold text-slate-900 dark:text-white">Awaiting Meshtastic GPS Fix</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Connect a serial node or click <strong>"Start Demo"</strong> in the sidebar to stream simulated coordinates.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
