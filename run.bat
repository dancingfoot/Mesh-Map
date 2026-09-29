@echo off
REM ==============================================================================
REM Mesh Map - Automated Windows Launcher
REM ==============================================================================

echo ==========================================================
echo   Mesh Map -- Meshtastic Real-Time GPS GIS Tracker
echo ==========================================================

REM 1. Check Python installation
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [-] Python is not installed or not in PATH. Please install Python from https://www.python.org/
    pause
    exit /b 1
)

REM 2. Create virtual environment if missing
if not exist ".venv" (
    echo [+] Creating virtual environment in .venv...
    python -m venv .venv
)

REM 3. Activate virtual environment
call .venv\Scripts\activate.bat

REM 4. Install dependencies
echo [+] Ensuring dependencies are installed...
python -m pip install --upgrade pip --quiet
pip install -r requirements.txt --quiet

REM 5. Launch Streamlit
echo [+] Launching Mesh Map...
streamlit run mesh_map.py

pause
