#!/bin/bash
# Double-click on a Mac: starts CashFlow at http://localhost:8765 and opens it in your browser.
cd "$(dirname "$0")"
python3 scripts/make-config.py || exit 1
( sleep 1; open "http://localhost:8765/" ) &
echo "CashFlow is running at http://localhost:8765  (close this window to stop it)"
python3 -m http.server 8765 --bind 127.0.0.1
