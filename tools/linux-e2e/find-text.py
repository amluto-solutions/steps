#!/usr/bin/env python3
"""Finds words on a window by OCR (the tesseract command), for the Linux end-to-end tests: prints
the screen point to click (JSON), or nothing when they aren't there.

    python3 find-text.py <window title part> <words>
    python3 find-text.py "Google Chrome" "Approve invoice"

For pages an app doesn't put on the AT-SPI bus: Chrome shows its web pages there only while its
own accessibility is on (a screen reader, or --force-renderer-accessibility), which most people's
isn't. Like find.py, it's independent of Steps' own code.
"""

import csv
import json
import os
import re
import subprocess
import sys
import tempfile

title, words = sys.argv[1], sys.argv[2].lower().split()


def geometry(window):
    """The window's screen position and size, from xwininfo."""
    info = subprocess.run(["xwininfo", "-id", window], capture_output=True, text=True).stdout
    numbers = [
        re.search(pattern + r":\s+(-?\d+)", info)
        for pattern in ("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")
    ]
    return tuple(int(number.group(1)) for number in numbers) if all(numbers) else (0, 0, 0, 0)


ids = subprocess.run(
    ["xdotool", "search", "--onlyvisible", "--name", title], capture_output=True, text=True
).stdout.split()
if not ids:
    sys.exit(0)
# Browsers keep small helper windows with the same title; the page is in the biggest.
window = max(ids, key=lambda each: geometry(each)[2] * geometry(each)[3])
origin_x, origin_y, width, height = geometry(window)

with tempfile.TemporaryDirectory() as folder:
    picture = os.path.join(folder, "window.png")
    # The screen, cut to the window: Firefox's own window reads back black.
    subprocess.run(
        [
            "import",
            "-window",
            "root",
            "-crop",
            f"{width}x{height}+{origin_x}+{origin_y}",
            picture,
        ],
        check=True,
        capture_output=True,
    )
    table = subprocess.run(
        ["tesseract", picture, "stdout", "tsv"], capture_output=True, text=True
    ).stdout

found = [
    row
    for row in csv.DictReader(table.splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE)
    if (row.get("text") or "").strip()
]
for start in range(len(found) - len(words) + 1):
    run = found[start : start + len(words)]
    # A button's edge can read as "|" stuck to its first word.
    if [re.sub(r"\W", "", row["text"].lower()) for row in run] != words:
        continue
    left = min(int(row["left"]) for row in run)
    top = min(int(row["top"]) for row in run)
    right = max(int(row["left"]) + int(row["width"]) for row in run)
    bottom = max(int(row["top"]) + int(row["height"]) for row in run)
    point = {
        "x": origin_x + (left + right) // 2,
        "y": origin_y + (top + bottom) // 2,
        "name": " ".join(row["text"] for row in run),
    }
    print(json.dumps(point))
    break
