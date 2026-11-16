#!/bin/bash
# Double-click on a Mac: starts Cash Flow at http://localhost:8765 and opens it in your browser.
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:8765/" ) &
echo "Cash Flow is running at http://localhost:8765  (close this window to stop it)"
python3 -m http.server 8765 --bind 127.0.0.1
