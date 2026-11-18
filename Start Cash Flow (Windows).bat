@echo off
REM Double-click on Windows: starts Cash Flow at http://localhost:8765 and opens it.
cd /d "%~dp0"
python scripts\make-config.py || py scripts\make-config.py
start "" "http://localhost:8765/"
echo Cash Flow is running at http://localhost:8765  (close this window to stop it)
python -m http.server 8765 --bind 127.0.0.1 || py -m http.server 8765 --bind 127.0.0.1
