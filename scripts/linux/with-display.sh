#!/usr/bin/env bash
# Runs a command on a virtual X11 session made for tests (docs/engineering.md#linux): Xvfb as the
# X server, openbox as the window manager (for the EWMH properties Steps reads), and a D-Bus
# session of its own, where the AT-SPI bus starts when asked for. WSLg's Wayland settings are
# cleared, since Steps records on X11 only.
#
#   scripts/linux/with-display.sh <command…>
#   STEPS_DISPLAY=98 STEPS_SCREEN=1920x1080 scripts/linux/with-display.sh <command…>
set -euo pipefail

number="${STEPS_DISPLAY:-99}"
screen="${STEPS_SCREEN:-1600x1000}"
logs="${STEPS_LOGS:-/tmp/steps-display-$number}"
mkdir -p "$logs"

Xvfb ":$number" -screen 0 "${screen}x24" -nolisten tcp +extension RANDR >"$logs/xvfb.log" 2>&1 &
xvfb=$!
# Waits for Xvfb to be gone, not only told to go: the next run takes the same display, and one
# started while this one was still closing stopped a release ("Server is already active for
# display 99", 07/10/2026).
trap 'kill "$xvfb" 2>/dev/null || true; wait "$xvfb" 2>/dev/null || true' EXIT

export DISPLAY=":$number"
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
# GTK looks for a Wayland socket even without WAYLAND_DISPLAY (WSLg has one), so X11 is named.
export GDK_BACKEND=x11
# A runtime folder of its own, where apps put their accessibility sockets: with WSLg's, Chrome
# never appeared on the accessibility bus.
XDG_RUNTIME_DIR="$(mktemp -d)"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_RUNTIME_DIR
for _ in $(seq 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done
xdpyinfo >/dev/null 2>&1 || { echo "Xvfb didn't start; see $logs/xvfb.log" >&2; exit 1; }

# The window manager runs inside the same D-Bus session as the command.
dbus-run-session -- bash -c '
  openbox >"$0/openbox.log" 2>&1 &
  for _ in $(seq 50); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break
    sleep 0.1
  done
  shift
  "$@"
' "$logs" -- "$@"
