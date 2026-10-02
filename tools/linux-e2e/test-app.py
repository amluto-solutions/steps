#!/usr/bin/env python3
"""A small GTK 3 window for the Linux end-to-end test (tools/linux-e2e/run.mjs): an invoice form
with a button, a labelled field, a password field and a Save button, like a business app. Once it
shows, it writes where each control is on screen (JSON, screen pixels) to the file named on its
command line, so the test can click them with xdotool.

    python3 test-app.py /tmp/places.json
"""

import json
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

places_file = sys.argv[1]

window = Gtk.Window(title="Invoices - Finance")
window.set_default_size(560, 320)
window.move(80, 80)
grid = Gtk.Grid(column_spacing=12, row_spacing=12, margin=24)
window.add(grid)

heading = Gtk.Label(label="Queries to sam.tester@example.com")
grid.attach(heading, 0, 0, 2, 1)

approve = Gtk.Button(label="Approve invoice")
grid.attach(approve, 0, 1, 2, 1)

supplier_label = Gtk.Label(label="Supplier", xalign=0)
supplier = Gtk.Entry()
supplier_label.set_mnemonic_widget(supplier)
grid.attach(supplier_label, 0, 2, 1, 1)
grid.attach(supplier, 1, 2, 1, 1)

pin_label = Gtk.Label(label="Card PIN", xalign=0)
pin = Gtk.Entry(visibility=False)
pin_label.set_mnemonic_widget(pin)
grid.attach(pin_label, 0, 3, 1, 1)
grid.attach(pin, 1, 3, 1, 1)

save = Gtk.Button(label="Save")
grid.attach(save, 0, 4, 2, 1)

window.connect("destroy", Gtk.main_quit)
window.show_all()


def report():
    # GDK gives (result, x, y); only the last two matter.
    origin_x, origin_y = window.get_window().get_origin()[-2:]
    places = {}
    for name, widget in [
        ("approve", approve),
        ("supplier", supplier),
        ("pin", pin),
        ("save", save),
    ]:
        allocation = widget.get_allocation()
        x, y = widget.translate_coordinates(window, 0, 0)
        places[name] = {
            "x": origin_x + x + allocation.width // 2,
            "y": origin_y + y + allocation.height // 2,
        }
    with open(places_file, "w", encoding="utf-8") as out:
        json.dump(places, out)
    return False


GLib.timeout_add(800, report)
Gtk.main()
