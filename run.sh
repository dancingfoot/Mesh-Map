#!/usr/bin/env bash
# ==============================================================================
# Mesh Map - Automated Launcher
# Handles Python Virtual Environment (PEP 668) & Streamlit dependencies
# ==============================================================================

set -e

# Change to script directory
cd "$(dirname "$0")"

echo "=========================================================="
echo "  Mesh Map — Meshtastic Real-Time GPS GIS Tracker"
echo "=========================================================="

# 1. Check Python installation
if ! command -v python3 &> /dev/null; then
    echo "[-] Error: python3 is not installed."
    echo "    On Debian/Ubuntu/Raspberry Pi: sudo apt update && sudo apt install python3 python3-venv python3-pip"
    exit 1
fi

VENV_DIR=".venv"

# 2. Create virtual environment if not already present
if [ ! -d "$VENV_DIR" ]; then
    echo "[+] Creating Python virtual environment in $VENV_DIR..."
    if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
        echo "[-] python3-venv is missing on this system."
        echo "    Install it with: sudo apt update && sudo apt install python3-venv python3-pip"
        echo "    Attempting installation with --break-system-packages..."
        pip install --break-system-packages -r requirements.txt
        exec python3 -m streamlit run mesh_map.py
    fi
fi

# 3. Activate virtual environment
echo "[+] Activating virtual environment..."
source "$VENV_DIR/bin/activate"

# 4. Upgrade pip and install requirements
echo "[+] Ensuring dependencies (streamlit, folium, pyserial) are installed..."
pip install --upgrade pip --quiet
pip install -r requirements.txt --quiet

# 5. Launch Mesh Map via Streamlit
echo "[+] Launching Mesh Map..."
echo "=========================================================="
echo "  Opening browser at http://localhost:8501"
echo "=========================================================="
exec streamlit run mesh_map.py "$@"
