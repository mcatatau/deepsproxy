#!/usr/bin/env bash
set -euo pipefail

echo "[deepsproxy] Starting VNC, noVNC, and proxy services..."

# Start Xvfb virtual display
export DISPLAY_NUM="${DISPLAY_NUM:-99}"
export SCREEN_WIDTH="${SCREEN_WIDTH:-1280}"
export SCREEN_HEIGHT="${SCREEN_HEIGHT:-900}"
export SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
export DISPLAY=":${DISPLAY_NUM}"

Xvfb ${DISPLAY} -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" &
XVFB_PID=$!
echo "[deepsproxy] Xvfb started on display ${DISPLAY} (PID: ${XVFB_PID})"

# Wait for X server to be ready
sleep 2

# Start x11vnc server
export VNC_PASSWORD="${VNC_PASSWORD:-}"
if [ -n "${VNC_PASSWORD}" ]; then
  # Create password file
  x11vnc -storepasswd "${VNC_PASSWORD}" /tmp/vnc.pass
  x11vnc -display ${DISPLAY} -rfbauth /tmp/vnc.pass -forever -shared &
else
  x11vnc -display ${DISPLAY} -nopw -forever -shared &
fi
VNC_PID=$!
echo "[deepsproxy] x11vnc started (PID: ${VNC_PID})"

# Start noVNC web client
export NOVNC_PORT="${NOVNC_PORT:-6080}"
websockify --web=/usr/share/novnc ${NOVNC_PORT} localhost:5900 &
NOVNC_PID=$!
echo "[deepsproxy] noVNC started on port ${NOVNC_PORT} (PID: ${NOVNC_PID})"

# Wait for VNC stack to initialize
sleep 3

# Start the main deepsproxy Node.js application
export PORT="${PORT:-4000}"
export PLAYWRIGHT_HEADLESS="${PLAYWRIGHT_HEADLESS:-true}"
echo "[deepsproxy] Starting Node.js application on port ${PORT}..."

exec node dist/index.js
