#!/usr/bin/env python3
"""Finds a control in a running app through AT-SPI, for the Linux end-to-end tests: prints the
screen point to click (JSON), or nothing when it isn't there.

    python3 find.py <app name part> <role> <name part>
    python3 find.py nautilus "push button" "Search"

The element's extents are read in window coordinates and put on the screen with the X window's
own position (xwininfo), since GTK 4 doesn't give screen coordinates. When several match, the
top-most on screen wins: LibreOffice keeps a hidden menu bar of its own below GTK's visible one.
It's independent of the app's own AT-SPI code, so a test can't pass by agreeing with itself.
"""

import json
import re
import subprocess
import sys
from collections import deque

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

app_part, role_wanted, name_part = (value.lower() for value in sys.argv[1:4])
# Newer AT-SPI (2.60) names push buttons "button"; either name finds both.
ALIASES = {"push button": "button"}
role_wanted = ALIASES.get(role_wanted, role_wanted)


def window_origin(pid, title):
    """The client area's top-left corner of the app's shown window with this title."""
    ids = subprocess.run(
        ["xdotool", "search", "--onlyvisible", "--pid", str(pid)],
        capture_output=True,
        text=True,
    ).stdout.split()
    for window in ids:
        info = subprocess.run(["xwininfo", "-id", window], capture_output=True, text=True).stdout
        name = re.search(r'xwininfo: Window id: \S+ "(.*)"', info)
        if title and name and name.group(1) != title:
            continue
        x = re.search(r"Absolute upper-left X:\s+(-?\d+)", info)
        y = re.search(r"Absolute upper-left Y:\s+(-?\d+)", info)
        if x and y:
            return int(x.group(1)), int(y.group(1))
    return None


matches = []
desktop = Atspi.get_desktop(0)
for index in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(index)
    if not app or app_part not in (app.get_name() or "").lower():
        continue
    for top_index in range(app.get_child_count()):
        top = app.get_child_at_index(top_index)
        if not top:
            continue
        queue = deque([(top, 0)])
        seen = 0
        while queue:
            element, depth = queue.popleft()
            seen += 1
            if seen > 5000:
                break
            try:
                role = element.get_role_name()
                name = element.get_name() or ""
            except Exception:  # noqa: BLE001 - a defunct element is skipped
                continue
            if ALIASES.get(role, role) == role_wanted and name_part in name.lower():
                states = element.get_state_set()
                if not states.contains(Atspi.StateType.SHOWING):
                    continue
                extents = element.get_extents(Atspi.CoordType.WINDOW)
                origin = window_origin(app.get_process_id(), top.get_name())
                # Firefox counts window coordinates from outside its title bar, where its
                # top-level then sits; other toolkits put the top-level at 0, 0.
                shift = top.get_extents(Atspi.CoordType.WINDOW)
                shift_x = shift.x if 0 <= shift.x <= 200 else 0
                shift_y = shift.y if 0 <= shift.y <= 200 else 0
                if origin and extents.width > 0 and extents.height > 0:
                    matches.append(
                        {
                            "x": origin[0] - shift_x + extents.x + extents.width // 2,
                            "y": origin[1] - shift_y + extents.y + extents.height // 2,
                            "name": name,
                        }
                    )
            if depth < 40:
                for child_index in range(element.get_child_count()):
                    child = element.get_child_at_index(child_index)
                    if child:
                        queue.append((child, depth + 1))
if matches:
    print(json.dumps(min(matches, key=lambda match: (match["y"], match["x"]))))
