#!/usr/bin/env python3
"""
Mesh Map - Real-Time Meshtastic GPS Tracker & GIS Dashboard
============================================================
A lightweight single-script Python application using Streamlit, Folium
(via streamlit-folium), and PySerial to track Meshtastic node movement
in real time over a serial connection.

Features:
- Configurable serial connection (e.g. /dev/ttyUSB0, COM3, 115200 baud).
- Background worker thread with thread-safe queue.
- Dual parsing support:
    * Meshtastic JSON payloads (scaled integer `latitude_i`/`longitude_i` or float `lat`/`lon`)
    * Standard NMEA sentences ($GPGGA, $GNGGA, $GPRMC, $GNRMC) with coordinate conversion
- Folium GIS map with:
    * Continuous PolyLine path trace of route
    * Green Start Marker (fa-play / marker-icon)
    * Red Current Location Marker (fa-dot-circle-o / pulse)
    * Real-time auto-centering
- Sidebar controls:
    * Port & Baud selection
    * Connection Start / Stop
    * "Clear Path" button to purge coordinates
    * Refresh interval & simulated test generator
- Single executable script: run with `streamlit run mesh_map.py` or `python mesh_map.py`.
"""

from __future__ import annotations

import sys
import os
import time
import json
import re
import math
import threading
import queue
from datetime import datetime
from typing import Optional, Tuple, Dict, Any, List

# Core UI & Mapping dependencies
try:
    import streamlit as st
except ImportError:
    st = None

try:
    import folium
    from folium import plugins
except ImportError:
    folium = None

try:
    from streamlit_folium import st_folium
    HAS_STREAMLIT_FOLIUM = True
except ImportError:
    HAS_STREAMLIT_FOLIUM = False

try:
    import serial
    import serial.tools.list_ports
    HAS_PYSERIAL = True
except ImportError:
    HAS_PYSERIAL = False


# ==============================================================================
# GPS & Meshtastic Parsing Logic
# ==============================================================================

def parse_nmea_coordinate(raw_val: str, direction: str) -> Optional[float]:
    """
    Convert NMEA degree-minute format to decimal degrees.
    Example: '4807.038' (48 deg, 07.038 min) -> 48.1173
             '01131.000' (11 deg, 31.000 min) -> 11.516667
    """
    try:
        raw_float = float(raw_val)
        # Latitude has 2 degree digits (ddmm.mmmm), Longitude has 3 (dddmm.mmmm)
        # Dividing by 100 separates degrees as the integer part
        degrees = int(raw_float / 100)
        minutes = raw_float - (degrees * 100)
        decimal = degrees + (minutes / 60.0)
        if direction.upper() in ['S', 'W']:
            decimal = -decimal
        return round(decimal, 6)
    except (ValueError, TypeError, ZeroDivisionError):
        return None


def parse_nmea_sentence(line: str) -> Optional[Dict[str, Any]]:
    """
    Parse standard NMEA sentences: $GPGGA, $GNGGA, $GPRMC, $GNRMC.
    Returns dictionary with lat, lon, alt, speed, sats, and source if valid.
    """
    line = line.strip()
    if not line.startswith('$'):
        return None

    # Strip checksum if present
    content = line[1:]
    if '*' in content:
        content, _ = content.split('*', 1)

    parts = content.split(',')
    sentence_type = parts[0].upper()

    # GGA Sentence: Global Positioning System Fix Data
    # $GPGGA,time,lat,N/S,lon,E/W,quality,numSV,HDOP,alt,altUnit,geoid,geoidUnit,dgpsAge,dgpsStationId
    if sentence_type in ['GPGGA', 'GNGGA', 'GAGGA']:
        if len(parts) >= 10 and parts[2] and parts[3] and parts[4] and parts[5]:
            lat = parse_nmea_coordinate(parts[2], parts[3])
            lon = parse_nmea_coordinate(parts[4], parts[5])
            if lat is not None and lon is not None:
                altitude = None
                try:
                    altitude = float(parts[9])
                except (ValueError, IndexError):
                    pass
                sats = None
                try:
                    sats = int(parts[7])
                except (ValueError, IndexError):
                    pass
                return {
                    "latitude": lat,
                    "longitude": lon,
                    "altitude": altitude,
                    "satellites": sats,
                    "source": f"NMEA ({sentence_type})",
                    "timestamp": datetime.now().isoformat(),
                    "raw": line
                }

    # RMC Sentence: Recommended Minimum Specific GNSS Data
    # $GPRMC,time,status,lat,N/S,lon,E/W,speedKnots,trackAngle,date,var,varDir,mode
    elif sentence_type in ['GPRMC', 'GNRMC', 'GARMC']:
        if len(parts) >= 7 and parts[2] == 'A' and parts[3] and parts[4] and parts[5] and parts[6]:
            lat = parse_nmea_coordinate(parts[3], parts[4])
            lon = parse_nmea_coordinate(parts[5], parts[6])
            if lat is not None and lon is not None:
                speed_knots = None
                try:
                    speed_knots = float(parts[7])
                except (ValueError, IndexError):
                    pass
                speed_kmh = round(speed_knots * 1.852, 1) if speed_knots is not None else None
                return {
                    "latitude": lat,
                    "longitude": lon,
                    "speed_kmh": speed_kmh,
                    "source": f"NMEA ({sentence_type})",
                    "timestamp": datetime.now().isoformat(),
                    "raw": line
                }

    return None


def parse_meshtastic_json(line: str) -> Optional[Dict[str, Any]]:
    """
    Parse Meshtastic serial JSON outputs. Supports:
    1) {"type":"position","payload":{"latitude_i":377749000,"longitude_i":-1224194000,"altitude":42}}
    2) {"from":"!28a9df12","type":"position","lat":37.7749,"lon":-122.4194}
    3) {"sender":"^all","decoded":{"position":{"latitudeI":377749000,"longitudeI":-1224194000}}}
    """
    # Look for JSON structure { ... }
    match = re.search(r'\{.*\}', line)
    if not match:
        return None

    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None

    lat = None
    lon = None
    alt = None
    node_id = data.get("from") or data.get("sender") or data.get("node_id")

    # Search in root level
    if "lat" in data and "lon" in data:
        lat = float(data["lat"])
        lon = float(data["lon"])
    elif "latitude" in data and "longitude" in data:
        lat = float(data["latitude"])
        lon = float(data["longitude"])
    elif "latitude_i" in data and "longitude_i" in data:
        lat = float(data["latitude_i"]) / 1e7
        lon = float(data["longitude_i"]) / 1e7

    # Search in 'payload' dictionary
    payload = data.get("payload")
    if isinstance(payload, dict):
        if "lat" in payload and "lon" in payload:
            lat = float(payload["lat"])
            lon = float(payload["lon"])
        elif "latitude" in payload and "longitude" in payload:
            lat = float(payload["latitude"])
            lon = float(payload["longitude"])
        elif "latitude_i" in payload and "longitude_i" in payload:
            lat = float(payload["latitude_i"]) / 1e7
            lon = float(payload["longitude_i"]) / 1e7
        elif "latitudeI" in payload and "longitudeI" in payload:
            lat = float(payload["latitudeI"]) / 1e7
            lon = float(payload["longitudeI"]) / 1e7
        if "altitude" in payload:
            alt = payload["altitude"]

    # Search in 'decoded' -> 'position'
    decoded = data.get("decoded")
    if isinstance(decoded, dict):
        pos = decoded.get("position")
        if isinstance(pos, dict):
            if "latitudeI" in pos and "longitudeI" in pos:
                lat = float(pos["latitudeI"]) / 1e7
                lon = float(pos["longitudeI"]) / 1e7
            elif "latitude" in pos and "longitude" in pos:
                lat = float(pos["latitude"])
                lon = float(pos["longitude"])
            if "altitude" in pos:
                alt = pos["altitude"]

    if alt is None:
        alt = data.get("altitude") or (payload.get("altitude") if isinstance(payload, dict) else None)

    # Validate coordinate boundaries
    if lat is not None and lon is not None:
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            # Ignore zero island (0, 0) often output before GPS fix
            if abs(lat) > 0.0001 or abs(lon) > 0.0001:
                return {
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "altitude": alt,
                    "node_id": node_id,
                    "source": "Meshtastic JSON",
                    "timestamp": datetime.now().isoformat(),
                    "raw": line.strip()
                }

    return None


def parse_serial_stream_line(raw_line: str) -> Optional[Dict[str, Any]]:
    """Unified parser trying Meshtastic JSON first, then standard NMEA sentences."""
    if not raw_line:
        return None
    raw_str = raw_line.strip()
    if not raw_str:
        return None

    # Check for Meshtastic JSON
    if '{' in raw_str and '}' in raw_str:
        parsed_json = parse_meshtastic_json(raw_str)
        if parsed_json:
            return parsed_json

    # Check for NMEA
    if '$' in raw_str:
        nmea_start = raw_str.find('$')
        parsed_nmea = parse_nmea_sentence(raw_str[nmea_start:])
        if parsed_nmea:
            return parsed_nmea

    return None


def calculate_haversine_distance(coord1: Tuple[float, float], coord2: Tuple[float, float]) -> float:
    """Calculate distance in meters between two lat/lon coordinates."""
    r = 6371000.0  # Earth radius in meters
    lat1, lon1 = math.radians(coord1[0]), math.radians(coord1[1])
    lat2, lon2 = math.radians(coord2[0]), math.radians(coord2[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2.0)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0)**2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r * c


# ==============================================================================
# Thread-Safe Serial Manager (Background Worker)
# ==============================================================================

class SerialManager:
    """
    Manages background serial port connection and continuous reading thread.
    Thread-safe queue stores new parsed coordinates and raw serial log lines.
    """
    def __init__(self):
        self.port: Optional[str] = None
        self.baudrate: int = 115200
        self.serial_inst = None
        self.thread: Optional[threading.Thread] = None
        self.is_running: bool = False
        self.lock = threading.Lock()
        self.coord_queue: queue.Queue = queue.Queue()
        self.log_queue: queue.Queue = queue.Queue(maxsize=100)
        self.status_msg: str = "Disconnected"
        self.bytes_received: int = 0
        self.packets_parsed: int = 0
        self.sim_thread: Optional[threading.Thread] = None
        self.sim_running: bool = False

    def get_available_ports_info(self) -> List[Tuple[str, str]]:
        """Scans system and returns list of (device_path, formatted_display_label) for all available ports."""
        detected = []
        if HAS_PYSERIAL:
            try:
                ports = serial.tools.list_ports.comports()
                for p in ports:
                    desc = f" — {p.description}" if p.description and p.description != "n/a" else ""
                    hwid = f" [{p.hwid[:24]}]" if hasattr(p, 'hwid') and p.hwid and p.hwid != "n/a" else ""
                    detected.append((p.device, f"{p.device}{desc}{hwid}"))
            except Exception:
                pass

        if not detected:
            # Provide comprehensive cross-platform ports if no hardware is currently enumerated
            return [
                ("/dev/ttyUSB0", "/dev/ttyUSB0 (Standard Linux/Raspberry Pi USB)"),
                ("/dev/ttyACM0", "/dev/ttyACM0 (Standard Linux/Mac USB CDC)"),
                ("COM3", "COM3 (Standard Windows USB-Serial)"),
                ("COM4", "COM4 (Standard Windows USB-Serial)"),
                ("COM1", "COM1 (Standard Windows Port)"),
                ("/dev/cu.usbserial", "/dev/cu.usbserial (macOS USB Serial)"),
                ("/dev/cu.usbmodem", "/dev/cu.usbmodem (macOS USB Modem)"),
            ]
        return detected

    def get_available_ports(self) -> List[str]:
        return [dev for dev, _ in self.get_available_ports_info()]

    def connect(self, port: str, baudrate: int = 115200) -> bool:
        if not HAS_PYSERIAL:
            self.status_msg = "PySerial not installed. Run: pip install pyserial"
            return False

        with self.lock:
            self.disconnect()
            self.port = port
            self.baudrate = baudrate
            try:
                self.serial_inst = serial.Serial(
                    port=port,
                    baudrate=baudrate,
                    timeout=1.0,
                    xonxoff=False,
                    rtscts=False
                )
                self.is_running = True
                self.thread = threading.Thread(target=self._worker_loop, daemon=True)
                self.thread.start()
                self.status_msg = f"Connected to {port} @ {baudrate} baud"
                return True
            except Exception as e:
                self.status_msg = f"Connection failed: {e}"
                self.is_running = False
                return False

    def disconnect(self):
        self.is_running = False
        self.sim_running = False
        if self.serial_inst:
            try:
                self.serial_inst.close()
            except Exception:
                pass
            self.serial_inst = None
        self.status_msg = "Disconnected"

    def _worker_loop(self):
        """Continuously reads lines from the active serial port."""
        buffer = ""
        while self.is_running and self.serial_inst and self.serial_inst.is_open:
            try:
                line_bytes = self.serial_inst.readline()
                if line_bytes:
                    self.bytes_received += len(line_bytes)
                    line_str = line_bytes.decode('utf-8', errors='replace').strip()
                    if line_str:
                        # Log raw line for monitoring
                        try:
                            if self.log_queue.full():
                                self.log_queue.get_nowait()
                            self.log_queue.put_nowait(f"[{datetime.now().strftime('%H:%M:%S')}] {line_str}")
                        except Exception:
                            pass

                        # Attempt GPS parse
                        parsed = parse_serial_stream_line(line_str)
                        if parsed:
                            self.packets_parsed += 1
                            self.coord_queue.put(parsed)
            except Exception as e:
                self.status_msg = f"Serial read error: {e}"
                time.sleep(0.5)

    def start_simulator(self, base_lat=37.7749, base_lon=-122.4194):
        """Generates realistic Meshtastic JSON and NMEA packets for testing without hardware."""
        self.disconnect()
        self.sim_running = True
        self.status_msg = "Demo Simulation Active (San Francisco Walk)"
        self.sim_thread = threading.Thread(
            target=self._simulator_loop,
            args=(base_lat, base_lon),
            daemon=True
        )
        self.sim_thread.start()

    def _simulator_loop(self, base_lat, base_lon):
        step = 0
        lat, lon = base_lat, base_lon
        alt = 45.0
        while self.sim_running:
            time.sleep(2.0)
            if not self.sim_running:
                break
            # Wander in a realistic path
            heading = (step * 25) % 360
            distance_deg = 0.00035 + 0.0001 * math.sin(step * 0.2)
            lat += distance_deg * math.cos(math.radians(heading))
            lon += distance_deg * math.sin(math.radians(heading))
            alt += 0.5 * math.sin(step)
            step += 1

            # Alternate between Meshtastic JSON and NMEA GPGGA
            if step % 2 == 0:
                payload = {
                    "from": "!28a9df12",
                    "type": "position",
                    "payload": {
                        "latitude_i": int(lat * 1e7),
                        "longitude_i": int(lon * 1e7),
                        "altitude": round(alt, 1),
                        "time": int(time.time())
                    }
                }
                raw_str = json.dumps(payload)
                parsed = {
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "altitude": round(alt, 1),
                    "node_id": "!28a9df12",
                    "source": "Meshtastic JSON (Simulated)",
                    "timestamp": datetime.now().isoformat(),
                    "raw": raw_str
                }
            else:
                # Generate valid NMEA $GPGGA string
                d_lat = int(abs(lat))
                m_lat = (abs(lat) - d_lat) * 60.0
                ns = 'N' if lat >= 0 else 'S'

                d_lon = int(abs(lon))
                m_lon = (abs(lon) - d_lon) * 60.0
                ew = 'E' if lon >= 0 else 'W'

                nmea_body = f"GPGGA,{datetime.now().strftime('%H%M%S')},{d_lat:02d}{m_lat:06.3f},{ns},{d_lon:03d}{m_lon:06.3f},{ew},1,09,0.9,{alt:.1f},M,0.0,M,,"
                # XOR checksum
                checksum = 0
                for c in nmea_body:
                    checksum ^= ord(c)
                raw_str = f"${nmea_body}*{checksum:02X}"

                parsed = {
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "altitude": round(alt, 1),
                    "satellites": 9,
                    "source": "NMEA GPGGA (Simulated)",
                    "timestamp": datetime.now().isoformat(),
                    "raw": raw_str
                }

            self.packets_parsed += 1
            self.coord_queue.put(parsed)
            try:
                if self.log_queue.full():
                    self.log_queue.get_nowait()
                self.log_queue.put_nowait(f"[{datetime.now().strftime('%H:%M:%S')}] {raw_str}")
            except Exception:
                pass


def _safe_cache_resource(func):
    if st is not None and hasattr(st, "cache_resource"):
        return st.cache_resource(func)
    return func

@_safe_cache_resource
def get_serial_manager() -> SerialManager:
    """Returns singleton SerialManager instance preserved across reruns."""
    return SerialManager()


# ==============================================================================
# Folium Map Generator
# ==============================================================================

def create_folium_map(points: List[Dict[str, Any]]) -> folium.Map:
    """
    Renders an interactive Folium map centered on the latest received coordinates.
    Plots all logged GPS coordinates as a continuous path trace line (Folium PolyLine).
    Adds a Start marker (green) and Current Location marker (red).
    """
    # Default center if no points logged yet
    default_lat, default_lon = 37.7749, -122.4194
    zoom_start = 13

    if points:
        latest = points[-1]
        center_lat = latest["latitude"]
        center_lon = latest["longitude"]
        zoom_start = 16
    else:
        center_lat, center_lon = default_lat, default_lon

    # Initialize Folium Map with clean cartographic tiles
    m = folium.Map(
        location=[center_lat, center_lon],
        zoom_start=zoom_start,
        tiles="OpenStreetMap",
        control_scale=True
    )

    # Add alternate map layers
    folium.TileLayer(
        tiles='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attr='Esri Satellite',
        name='Satellite View'
    ).add_to(m)

    # REQUIREMENT: Add a button to full screen the map (Folium native plugin)
    if hasattr(plugins, "Fullscreen"):
        plugins.Fullscreen(
            position="topright",
            title="Full Screen Map",
            title_cancel="Exit Full Screen",
            force_separate_button=True
        ).add_to(m)

    if not points:
        folium.LayerControl().add_to(m)
        return m

    # Extract coordinate path
    coord_tuples = [[p["latitude"], p["longitude"]] for p in points]

    # Plot continuous path trace line (Folium PolyLine)
    if len(coord_tuples) > 1:
        folium.PolyLine(
            locations=coord_tuples,
            color="#2563EB",       # Laser cobalt
            weight=5,
            opacity=0.85,
            tooltip=f"Route Path ({len(coord_tuples)} points)",
            smooth_factor=1.0
        ).add_to(m)

        # Subtle shadow / outline for high contrast over satellite imagery
        folium.PolyLine(
            locations=coord_tuples,
            color="#FFFFFF",
            weight=7,
            opacity=0.35,
            dash_array="2, 6"
        ).add_to(m)

    # 1. Start Marker (Green)
    start_pt = points[0]
    start_popup_html = f"""
    <div style="font-family: sans-serif; font-size: 13px; line-height: 1.4;">
        <b style="color: #059669;">▶ START LOCATION</b><br/>
        <b>Lat:</b> {start_pt['latitude']:.6f}<br/>
        <b>Lon:</b> {start_pt['longitude']:.6f}<br/>
        <b>Time:</b> {start_pt.get('timestamp', 'N/A')[:19]}<br/>
        <b>Alt:</b> {start_pt.get('altitude') or 'N/A'} m
    </div>
    """
    folium.Marker(
        location=[start_pt["latitude"], start_pt["longitude"]],
        popup=folium.Popup(start_popup_html, max_width=250),
        tooltip="Start Location",
        icon=folium.Icon(color="green", icon="play", prefix="fa")
    ).add_to(m)

    # 2. Current Location Marker (Red) - only if points exist
    current_pt = points[-1]
    current_popup_html = f"""
    <div style="font-family: sans-serif; font-size: 13px; line-height: 1.4;">
        <b style="color: #DC2626;">● CURRENT LOCATION</b><br/>
        <b>Lat:</b> {current_pt['latitude']:.6f}<br/>
        <b>Lon:</b> {current_pt['longitude']:.6f}<br/>
        <b>Time:</b> {current_pt.get('timestamp', 'N/A')[:19]}<br/>
        <b>Alt:</b> {current_pt.get('altitude') or 'N/A'} m<br/>
        <b>Source:</b> {current_pt.get('source', 'Unknown')}
    </div>
    """
    folium.Marker(
        location=[current_pt["latitude"], current_pt["longitude"]],
        popup=folium.Popup(current_popup_html, max_width=250),
        tooltip="Current Node Position",
        icon=folium.Icon(color="red", icon="crosshairs", prefix="fa")
    ).add_to(m)

    # Add pulsating circle around current position
    folium.CircleMarker(
        location=[current_pt["latitude"], current_pt["longitude"]],
        radius=12,
        color="#EF4444",
        weight=2,
        fill=True,
        fill_color="#EF4444",
        fill_opacity=0.25,
        tooltip="GPS Fix Accuracy Region"
    ).add_to(m)

    folium.LayerControl().add_to(m)
    return m


# ==============================================================================
# Streamlit Application Main Entry Point
# ==============================================================================

def main():
    if st is None or folium is None:
        print("\n=======================================================")
        print("  Mesh Map - Meshtastic Real-Time Tracker")
        print("=======================================================")
        print("Missing required libraries. Please install dependencies:")
        print("  pip install -r requirements.txt")
        print("\nThen run the Streamlit app with:")
        print("  streamlit run mesh_map.py")
        print("=======================================================\n")
        sys.exit(1)

    st.set_page_config(
        page_title="Mesh Map - Meshtastic Real-Time Tracker",
        page_icon="📡",
        layout="wide",
        initial_sidebar_state="expanded"
    )

    # Ensure Session State storage for coordinates
    if "gps_points" not in st.session_state:
        st.session_state.gps_points = []
    if "auto_refresh" not in st.session_state:
        st.session_state.auto_refresh = True
    if "refresh_interval" not in st.session_state:
        st.session_state.refresh_interval = 2.0

    manager = get_serial_manager()

    # Drain any new coordinates from the background thread queue
    new_points_added = 0
    while not manager.coord_queue.empty():
        try:
            pt = manager.coord_queue.get_nowait()
            st.session_state.gps_points.append(pt)
            new_points_added += 1
        except queue.Empty:
            break

    # ==========================================================================
    # Sidebar Controls
    # ==========================================================================
    with st.sidebar:
        st.title("📡 Mesh Map")
        st.caption("Meshtastic Real-Time Serial Tracker")
        st.markdown("---")

        # Serial Configuration Section
        st.subheader("Serial Connection")

        # Scan all available system ports
        ports_info = manager.get_available_ports_info()
        port_devices = [p[0] for p in ports_info]
        port_labels = {p[0]: p[1] for p in ports_info}

        col_p1, col_p2 = st.columns([3, 1])
        with col_p1:
            st.caption("Detected System Ports:")
        with col_p2:
            if st.button("🔄 Rescan", help="Rescan system for newly plugged USB serial devices", use_container_width=True):
                st.rerun()

        # REQUIREMENT: Dropdown with all ports available on the system
        selected_port = st.selectbox(
            "Serial Port",
            options=port_devices,
            format_func=lambda dev: port_labels.get(dev, dev),
            index=0,
            help="Select any USB/Serial port currently available on your system."
        )

        baud_rates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
        selected_baud = st.selectbox(
            "Baud Rate",
            options=baud_rates,
            index=baud_rates.index(115200) if 115200 in baud_rates else 4,
            help="Standard Meshtastic serial baud rate is 115200."
        )

        # Connection Buttons
        col_conn1, col_conn2 = st.columns(2)
        with col_conn1:
            if st.button("Connect", type="primary", use_container_width=True, disabled=manager.is_running):
                success = manager.connect(selected_port, selected_baud)
                if success:
                    st.toast(f"Connected to {selected_port}!", icon="🟢")
                else:
                    st.error(manager.status_msg)
                st.rerun()

        with col_conn2:
            if st.button("Disconnect", use_container_width=True, disabled=(not manager.is_running and not manager.sim_running)):
                manager.disconnect()
                st.toast("Serial connection closed.", icon="⚪")
                st.rerun()

        # Connection Status Readout
        status_color = "🟢" if (manager.is_running or manager.sim_running) else "⚪"
        st.markdown(f"**Status:** {status_color} `{manager.status_msg}`")

        # Simulator Demo Button (For testing when no hardware is attached)
        st.markdown("---")
        st.subheader("Hardware Simulation")
        col_sim1, col_sim2 = st.columns(2)
        with col_sim1:
            if st.button("Start Demo", use_container_width=True, disabled=manager.sim_running):
                manager.start_simulator()
                st.toast("Simulation feed started!", icon="🚀")
                st.rerun()
        with col_sim2:
            if st.button("Stop Demo", use_container_width=True, disabled=not manager.sim_running):
                manager.disconnect()
                st.rerun()

        st.markdown("---")
        # Route Controls Section
        st.subheader("Route Management")

        # REQUIREMENT: Provide a "Clear Path" button in the sidebar to purge logged coordinates and reset the map
        if st.button("Clear Path", type="secondary", use_container_width=True, help="Purge all logged coordinates and reset the map"):
            st.session_state.gps_points.clear()
            st.toast("All route coordinates purged.", icon="🗑️")
            st.rerun()

        st.markdown("---")
        # Auto-refresh UI Logic
        st.subheader("Display & Auto-Refresh")
        st.session_state.auto_refresh = st.toggle("Auto-Refresh UI", value=st.session_state.auto_refresh)
        st.session_state.refresh_interval = st.slider(
            "Refresh Interval (seconds)",
            min_value=1.0,
            max_value=10.0,
            value=float(st.session_state.refresh_interval),
            step=0.5
        )

        # Raw Serial Console Log Expander
        with st.expander("Live Serial Log (Last 10 Lines)"):
            logs = list(manager.log_queue.queue)
            if logs:
                st.code("\n".join(logs[-10:]), language="text")
            else:
                st.caption("No incoming serial data recorded yet.")

    # ==========================================================================
    # Main Dashboard Area
    # ==========================================================================
    points = st.session_state.gps_points

    # Telemetry Header Metrics
    total_points = len(points)
    total_dist_km = 0.0
    for i in range(1, len(points)):
        c1 = (points[i-1]["latitude"], points[i-1]["longitude"])
        c2 = (points[i]["latitude"], points[i]["longitude"])
        total_dist_km += calculate_haversine_distance(c1, c2) / 1000.0

    latest_pt = points[-1] if points else None

    # Top Metrics Row
    m_col1, m_col2, m_col3, m_col4, m_col5 = st.columns(5)
    with m_col1:
        st.metric("Total Route Points", f"{total_points:,}")
    with m_col2:
        st.metric("Distance Covered", f"{total_dist_km:.2f} km")
    with m_col3:
        if latest_pt:
            st.metric("Current Latitude", f"{latest_pt['latitude']:.5f}°")
        else:
            st.metric("Current Latitude", "—")
    with m_col4:
        if latest_pt:
            st.metric("Current Longitude", f"{latest_pt['longitude']:.5f}°")
        else:
            st.metric("Current Longitude", "—")
    with m_col5:
        if latest_pt and latest_pt.get("altitude") is not None:
            st.metric("Altitude", f"{latest_pt['altitude']} m")
        else:
            st.metric("Altitude", "—")

    # Interactive Folium Map
    if "is_fullscreen" not in st.session_state:
        st.session_state.is_fullscreen = False

    col_map_title, col_map_fs = st.columns([3, 1])
    with col_map_title:
        st.markdown("### 🗺️ Live Route Map")
    with col_map_fs:
        # REQUIREMENT: Add a button to full screen the map
        fs_btn_label = "🗗 Standard View" if st.session_state.is_fullscreen else "⛶ Full Screen Map"
        if st.button(fs_btn_label, use_container_width=True, help="Toggle full screen view of the Folium tracking map"):
            st.session_state.is_fullscreen = not st.session_state.is_fullscreen
            st.rerun()

    map_height = 940 if st.session_state.is_fullscreen else 620
    folium_map = create_folium_map(points)

    if HAS_STREAMLIT_FOLIUM:
        st_folium(folium_map, width="100%", height=map_height, returned_objects=[])
    else:
        # Fallback if streamlit-folium is not installed
        import streamlit.components.v1 as components
        map_html = folium_map._repr_html_()
        components.html(map_html, height=map_height)

    # Logged GPS Points Table
    with st.expander("Logged GPS Points Trace", expanded=False):
        if points:
            display_data = []
            for idx, p in enumerate(reversed(points[-50:])):
                display_data.append({
                    "Index": len(points) - idx,
                    "Timestamp": p.get("timestamp", "N/A"),
                    "Latitude": p["latitude"],
                    "Longitude": p["longitude"],
                    "Altitude (m)": p.get("altitude", "—"),
                    "Source": p.get("source", "—"),
                    "Node ID": p.get("node_id", "—")
                })
            st.dataframe(display_data, use_container_width=True)
        else:
            st.info("No GPS coordinates recorded yet. Connect your Meshtastic device or click 'Start Demo' in the sidebar.")

    # Seamless auto-refresh trigger
    if st.session_state.auto_refresh and (manager.is_running or manager.sim_running):
        time.sleep(st.session_state.refresh_interval)
        st.rerun()


if __name__ == "__main__":
    main()
