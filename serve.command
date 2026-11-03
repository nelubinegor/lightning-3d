#!/bin/bash
# Double-click this to run the piece. It serves this folder and opens a browser.
cd "$(dirname "$0")" || exit 1
PORT=8123
open "http://localhost:$PORT" 2>/dev/null &
echo "Serving on http://localhost:$PORT  —  press Ctrl-C to stop"
exec python3 -m http.server "$PORT"
