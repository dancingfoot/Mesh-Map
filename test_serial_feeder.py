#!/usr/bin/env python3
"""
Test Serial Feeder for Mesh Map
================================
Can be used to test serial parsing or feed mock serial data through a virtual PTY
(pseudoterminal) on Linux/macOS or directly output sample strings.
"""

import time
import json
import math
from datetime import datetime

def generate_sample_meshtastic_json(step: int, lat: float, lon: float, alt: float = 50.0):
    return json.dumps({
        "from": "!28a9df12",
        "type": "position",
        "payload": {
            "latitude_i": int(lat * 1e7),
            "longitude_i": int(lon * 1e7),
            "altitude": round(alt, 1),
            "time": int(time.time())
        }
    })

def generate_sample_gpgga(lat: float, lon: float, alt: float = 50.0):
    d_lat = int(abs(lat))
    m_lat = (abs(lat) - d_lat) * 60.0
    ns = 'N' if lat >= 0 else 'S'

    d_lon = int(abs(lon))
    m_lon = (abs(lon) - d_lon) * 60.0
    ew = 'E' if lon >= 0 else 'W'

    nmea_body = f"GPGGA,{datetime.now().strftime('%H%M%S')},{d_lat:02d}{m_lat:06.3f},{ns},{d_lon:03d}{m_lon:06.3f},{ew},1,09,0.9,{alt:.1f},M,0.0,M,,"
    checksum = 0
    for c in nmea_body:
        checksum ^= ord(c)
    return f"${nmea_body}*{checksum:02X}"

if __name__ == "__main__":
    print("Mesh Map Sample Serial Stream:")
    lat, lon = 37.7749, -122.4194
    for i in range(5):
        lat += 0.0003
        lon += 0.0002
        print("Meshtastic JSON:", generate_sample_meshtastic_json(i, lat, lon))
        print("NMEA GPGGA:     ", generate_sample_gpgga(lat, lon))
        time.sleep(0.5)
