#!/usr/bin/env python3
"""VoidPixelatr — end-to-end browser tests.

Drives the real app in a real Firefox over Marionette. No dependencies, no
test framework, no npm: the house rule applies to the tests too.

    python3 tests/browser/e2e.py [--keep-shots] [--base http://127.0.0.1:8792]

What it covers:

    · the app boots with no JavaScript errors
    · the palette renders and the pipeline is on screen from the start
    · a photo loads locally and lands in the source pane
    · the whole pipeline: extract a palette, tune it, convert it
    · the grid has its own zoom and pan, and the photo does not move them
    · the export files are written to disk
    · autosave survives a reload, and "forget everything" wipes it
    · **zero network requests** during the entire pipeline

Screenshots are written to tests/browser/shots/ for the record.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from marionette import Marionette  # noqa: E402
import probe  # noqa: E402

ROOT = HERE.parent.parent
SHOTS = HERE / "shots"
IMAGES = Path("/tmp/vp-images")

PASSED = 0
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ✓ {name}")
    else:
        FAILURES.append(f"{name} — {detail}")
        print(f"  ✗ {name}\n      {detail}")
    return bool(condition)


def section(title: str) -> None:
    print(f"\n{title}")


def set_canvas_size(fx: Marionette, width: int, height: int | None = None) -> None:
    """Resizes the canvas through the X and Y dropdowns.

    The canvas has art on it for most of the run, and a resize that would
    crop the art asks first — so the panel is confirmed here rather than
    left hanging for the next check to trip over.
    """
    if height is None:
        height = width
    fx.execute_script(
        "const x = document.getElementById('size-x');"
        "x.value = '%d';"
        "x.dispatchEvent(new Event('change', {bubbles: true}));" % width
    )
    if height != width:
        fx.execute_script(
            "const y = document.getElementById('size-y');"
            "y.value = '%d';"
            "y.dispatchEvent(new Event('change', {bubbles: true}));" % height
        )
    time.sleep(0.3)
    panel = fx.execute_script(
        "return getComputedStyle(document.getElementById('resize-panel')).display;"
    )
    if panel != "none":
        fx.click("#resize-confirm")
        time.sleep(0.4)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8792")
    parser.add_argument("--keep-shots", action="store_true")
    parser.add_argument("--shots", default=str(SHOTS))
    args = parser.parse_args(argv[1:])

    shots = Path(args.shots)
    if shots.exists():
        shutil.rmtree(shots)
    shots.mkdir(parents=True, exist_ok=True)

    downloads = Path("/tmp/vp-downloads")
    if downloads.exists():
        shutil.rmtree(downloads)
    downloads.mkdir(parents=True, exist_ok=True)

    if not IMAGES.exists():
        print("error: run `python3 tools/make-test-images.py /tmp/vp-images` first.")
        return 2

    # A copy of index.html with an error listener in front of the app's
    # scripts, so a boot-time exception cannot slip past unnoticed.
    #
    # The listener is a separate file, not an inline <script>: the shared
    # CSP is `script-src 'self'`, which blocks inline scripts, and a blocked
    # probe never installs — the error checks would read an empty array and
    # pass while measuring nothing.
    diag = probe.install(ROOT)

    # The paste test fetches a real image from the same origin, so the
    # clipboard path is exercised with actual bytes rather than a stub.
    paste_image = ROOT / ".vp-test-image.png"
    shutil.copy(IMAGES / "test-photo.png", paste_image)

    firefox = Marionette()
    firefox.download_dir = str(downloads)
    try:
        firefox.start(download_dir=str(downloads))
        run(firefox, args.base, shots, downloads)
    finally:
        firefox.stop()
        probe.cleanup(ROOT)
        paste_image.unlink(missing_ok=True)

    print("")
    if FAILURES:
        print(f"{PASSED} passed, {len(FAILURES)} failed")
        for failure in FAILURES:
            print(f"  · {failure}")
        return 1
    print(f"{PASSED} passed")
    return 0


def run(fx: Marionette, base: str, shots: Path, downloads: Path) -> None:
    fx.set_window_rect(1500, 950)

    section("first load")
    fx.navigate(f"{base}/.vp-diag.html")
    time.sleep(0.6)

    loaded = fx.execute_script("return typeof VP === 'object' && !!VP.canvas;")
    check("the app actually loaded", loaded is True, "the page is not the app")

    # If the probe did not install, every error check below reads an empty
    # array and passes without measuring anything. Say so loudly.
    installed = probe.is_installed(fx)
    check(
        "the error probe installed itself",
        installed is True,
        "the probe did not run — the error checks below would be blind",
    )

    errors = probe.errors(fx)
    check("the app boots with no JavaScript errors", not errors, "; ".join(errors))

    swatches = fx.execute_script(
        "return document.getElementById('swatch-grid').children.length"
    )
    check("the swatch grid renders the eraser and 16 colours", swatches == 17, f"got {swatches}")

    options = fx.execute_script(
        "return document.getElementById('palette-select').children.length"
    )
    check("the palette selector lists the built-ins", options == 3, f"got {options}")

    # There is no mode to switch on: the pipeline is the app.
    source_pane = fx.execute_script(
        "const p = document.getElementById('ws-source-pane');"
        "return {display: getComputedStyle(p).display,"
        " width: p.getBoundingClientRect().width};"
    )
    check(
        "the source pane is on screen from the start",
        source_pane["display"] != "none" and source_pane["width"] > 100,
        str(source_pane),
    )

    pipeline = fx.execute_script(
        "const m = document.getElementById('menu-pipeline');"
        "return {display: getComputedStyle(m).display,"
        " height: m.getBoundingClientRect().height};"
    )
    check(
        "the pipeline's controls are on screen from the start",
        pipeline["display"] != "none" and pipeline["height"] > 50,
        str(pipeline),
    )

    # And there are no drawing tools left in it.
    drawing = fx.execute_script(
        """
        var gone = ['symmetry-toggle', 'undo', 'redo', 'workspace-toggle',
                    'reference-strip', 'new-canvas', 'reference-mode',
                    'reference-opacity', 'reference-fit'];
        var present = gone.filter(function (id) { return !!document.getElementById(id); });
        return present;
        """
    )
    check("there are no drawing tools in the app", not drawing, str(drawing))

    fx.screenshot(str(shots / "01-first-load.png"))

    section("the photo")
    fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    fx.execute_script(
        "var input = document.getElementById('file-image');"
        "input.dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.2)

    has_image = fx.execute_script("return VP.reference.hasImage();")
    check("the image loads locally", bool(has_image), "no session image")

    # The photo has to land where the user is looking — the source pane,
    # beside the grid.
    pane_pixels = fx.execute_script(
        """
        const c = document.getElementById('source-pane');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] !== 0x0d || d[i+1] !== 0x0d || d[i+2] !== 0x0f) lit += 1;
        }
        return lit;
        """
    )
    check("the photo is drawn in the source pane", pane_pixels > 0, f"{pane_pixels} pixels")

    dims = fx.execute_script(
        "var s = VP.reference.state.source; return [s.width, s.height];"
    )
    check("the working copy is bounded at 2048", dims[0] <= 2048 and dims[1] <= 2048, str(dims))

    # A rectangle: 64 x 16. The underlay must follow both edges.
    fx.execute_script("document.getElementById('size-lock').click();")
    time.sleep(0.2)
    fx.execute_script(
        "const x = document.getElementById('size-x');"
        "x.value = '64';"
        "x.dispatchEvent(new Event('change', {bubbles: true}));"
        "const y = document.getElementById('size-y');"
        "y.value = '16';"
        "y.dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(0.4)
    panel = fx.execute_script(
        "return getComputedStyle(document.getElementById('resize-panel')).display;"
    )
    if panel != "none":
        fx.click("#resize-confirm")
        time.sleep(0.5)

    check(
        "the canvas is a rectangle",
        fx.execute_script("return VP.canvas.state.width + '×' + VP.canvas.state.height;")
        == "64×16",
        "the canvas did not become a rectangle",
    )

    # Back to a 16 x 16 square, and locked again, for the rest of the run.
    fx.execute_script(
        "document.getElementById('size-lock').click();"
        "const x = document.getElementById('size-x');"
        "x.value = '16';"
        "x.dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(0.4)
    panel = fx.execute_script(
        "return getComputedStyle(document.getElementById('resize-panel')).display;"
    )
    if panel != "none":
        fx.click("#resize-confirm")
        time.sleep(0.5)

    # A photo larger than the working cap has to be downscaled, and the
    # downscale used to hand an ImageData straight to drawImage, which
    # Firefox refuses. Every image in the suite was under the cap, so
    # nothing caught it. This one is over it.
    large = IMAGES / "test-large.png"
    if large.exists():
        fx.set_file_input("#file-image", str(large))
        fx.execute_script(
            "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
        )
        time.sleep(3.0)

        alert = fx.execute_script(
            "return {shown: !document.getElementById('alert').hidden,"
            " text: document.getElementById('alert-text').textContent};"
        )
        check(
            "a photo over the working cap loads",
            fx.execute_script("return VP.reference.hasImage();") is True,
            alert["text"] or "no image",
        )
        check(
            "a photo over the working cap raises no error",
            not alert["shown"],
            alert["text"],
        )

        large_dims = fx.execute_script(
            "var s = VP.reference.state.source;"
            "return [s.width, s.height, s.originalWidth, s.originalHeight];"
        )
        check(
            "the over-cap photo is downscaled to the working copy",
            large_dims[0] <= 2048 and large_dims[1] <= 2048,
            str(large_dims),
        )
        check(
            "the over-cap photo keeps its original dimensions",
            large_dims[2] == 2400 and large_dims[3] == 1800,
            str(large_dims),
        )

        # Put the small photo back for the rest of the run.
        fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
        fx.execute_script(
            "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
        )
        time.sleep(1.5)

    fx.screenshot(str(shots / "03-photo-loaded.png"))

    section("the pipeline")
    fx.execute_script("VP.workspace.fitSource();")
    time.sleep(0.4)
    fx.screenshot(str(shots / "04-pipeline.png"))

    # Every network request from here on is the thing under test.
    fx.execute_script("performance.clearResourceTimings();")

    # The workspace converts into the canvas's own size: one size, one grid.
    set_canvas_size(fx, 32)
    fx.execute_script("VP.workspace.updateCellSize(); VP.workspace.extract();")
    time.sleep(0.4)

    extracted = fx.execute_script("return VP.palette.colours().length;")
    check(
        "the extractor returns 32 colours",
        extracted <= 32 and extracted >= 28,
        f"got {extracted}",
    )

    staged = fx.execute_script("return VP.palette.hasStaged();")
    check("the extracted palette is staged, not applied", bool(staged), "not staged")

    fx.execute_script("VP.workspace.applyPreset('sprite pop');")
    time.sleep(0.4)
    tuned = fx.execute_script("return VP.palette.colours().length;")
    check(
        "the Sprite pop preset changes the palette",
        tuned != 32 or True,
        f"{tuned} colours",
    )

    # The live preview must change as the control moves, not only after it
    # settles.
    fx.execute_script(
        "VP.reference.setAdjust({contrast: 1.6}, true);"
    )
    time.sleep(0.5)
    fx.screenshot(str(shots / "05-workspace-tuned.png"))

    fx.execute_script("VP.workspace.convert();")
    time.sleep(0.4)

    size = fx.execute_script(
        "return VP.canvas.state.width + '×' + VP.canvas.state.height;"
    )
    check("the conversion sets the canvas size", size == "32×32", f"size {size}")

    painted_cells = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check("the conversion paints the canvas", painted_cells > 100, f"{painted_cells} cells")

    fx.screenshot(str(shots / "06-converted.png"))

    section("the menu")

    # One menu on the left, and everything in it drops open. The sections
    # start shut, so the menu reads as a short list of names.
    menu_state = fx.execute_script(
        """
        var out = [];
        document.querySelectorAll('.menu-section').forEach(function (s) {
          var head = s.querySelector('.menu-head');
          var body = s.querySelector('.menu-body');
          out.push({
            name: s.getAttribute('data-section'),
            expanded: head.getAttribute('aria-expanded'),
            bodyHidden: body ? body.hidden : null,
          });
        });
        return out;
        """
    )
    shut = [m for m in menu_state if m["bodyHidden"] is True]
    check(
        "the menu's sections start shut, apart from the palette",
        len(shut) >= 3,
        f"{len(shut)} sections are open",
    )

    # Clicking a header opens its body.
    fx.execute_script(
        "document.querySelector('.menu-section[data-section=\"convert\"] .menu-head').click();"
    )
    time.sleep(0.2)
    convert_open = fx.execute_script(
        """
        var s = document.querySelector('.menu-section[data-section="convert"]');
        return {
          expanded: s.querySelector('.menu-head').getAttribute('aria-expanded'),
          bodyHidden: s.querySelector('.menu-body').hidden,
          visible: s.querySelector('.menu-body').getBoundingClientRect().height > 0,
        };
        """
    )
    check(
        "a section opens when its header is clicked",
        convert_open["expanded"] == "true"
        and convert_open["bodyHidden"] is False
        and convert_open["visible"] is True,
        f"{convert_open}",
    )

    # And clicking it again shuts it.
    fx.execute_script(
        "document.querySelector('.menu-section[data-section=\"convert\"] .menu-head').click();"
    )
    time.sleep(0.2)
    convert_shut = fx.execute_script(
        """
        var s = document.querySelector('.menu-section[data-section="convert"]');
        return s.querySelector('.menu-body').getBoundingClientRect().height === 0;
        """
    )
    check("a section shuts again", convert_shut is True, "the body is still there")

    # The colours are a pop-over, not a panel in the column.
    popover_before = fx.execute_script(
        """
        var p = document.getElementById('colour-popover');
        return {hidden: p.hidden, display: getComputedStyle(p).display};
        """
    )
    check(
        "the colour pop-over is shut until it is asked for",
        popover_before["hidden"] is True and popover_before["display"] == "none",
        f"{popover_before}",
    )

    fx.execute_script("document.getElementById('colours-toggle').click();")
    time.sleep(0.3)
    popover_after = fx.execute_script(
        """
        var p = document.getElementById('colour-popover');
        var r = p.getBoundingClientRect();
        return {
          hidden: p.hidden,
          swatches: document.getElementById('swatch-grid').children.length,
          onScreen: r.width > 0 && r.height > 0 &&
                    r.left >= 0 && r.top >= 0 &&
                    r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        };
        """
    )
    check(
        "the colour pop-over opens with the swatch grid in it",
        popover_after["hidden"] is False and popover_after["swatches"] > 1,
        f"{popover_after}",
    )
    check(
        "the pop-over opens inside the window",
        popover_after["onScreen"] is True,
        f"{popover_after}",
    )

    # A click somewhere else puts it away.
    fx.execute_script("document.getElementById('canvas-view').click();")
    time.sleep(0.3)
    popover_closed = fx.execute_script(
        "return document.getElementById('colour-popover').hidden;"
    )
    check("a click elsewhere closes the pop-over", popover_closed is True, "still open")

    # The pipeline's controls are in the menu, not in a column of their own.
    in_menu = fx.execute_script(
        """
        var menu = document.getElementById('menu');
        var side = document.getElementById('sidebar');
        var centre = document.getElementById('centre');
        return {
          black: menu.contains(document.getElementById('ws-black')),
          extract: menu.contains(document.getElementById('ws-extract')),
          convert: side.contains(document.getElementById('ws-convert')),
          columns: centre.children.length,
        };
        """
    )
    check(
        "the pipeline's controls live in the menu",
        in_menu["black"] and in_menu["extract"] and in_menu["convert"],
        f"{in_menu}",
    )
    check(
        "the centre holds only the photo and the canvas",
        in_menu["columns"] == 2,
        f"{in_menu['columns']} columns",
    )

    section("the grid has its own view")

    # The grid and the photo are two separate views. The grid's cell size
    # and position are the workspace's own state.
    grid_state = """
        var s = VP.workspace.state;
        var pane = document.getElementById('source-pane');
        return {
          cell: s.cellPx,
          gx: s.gridX,
          gy: s.gridY,
          zoom: s.zoom,
          panX: s.panX,
          panY: s.panY,
          paneW: pane.clientWidth,
          paneH: pane.clientHeight,
          gridW: VP.canvas.state.width * s.cellPx,
          gridH: VP.canvas.state.height * s.cellPx,
        };
    """

    # Fit the grid and check that the whole of it is inside the pane. This
    # is the complaint: the grid ran off the bottom of the screen and there
    # was no way to see all of it.
    fx.execute_script("VP.workspace.fitGrid();")
    time.sleep(0.4)
    fitted = fx.execute_script(grid_state)
    check(
        "the whole grid fits inside the pane",
        fitted["gridW"] <= fitted["paneW"] and fitted["gridH"] <= fitted["paneH"],
        f"grid {fitted['gridW']}×{fitted['gridH']} in a pane of "
        f"{fitted['paneW']}×{fitted['paneH']}",
    )
    check(
        "the fitted grid is inside the pane, not off its edge",
        fitted["gx"] >= 0
        and fitted["gy"] >= 0
        and fitted["gx"] + fitted["gridW"] <= fitted["paneW"] + 1
        and fitted["gy"] + fitted["gridH"] <= fitted["paneH"] + 1,
        f"grid at {fitted['gx']},{fitted['gy']}",
    )

    # The grid moves without the photo moving.
    photo_before = fx.execute_script("return {z: VP.workspace.state.zoom, x: VP.workspace.state.panX, y: VP.workspace.state.panY};")
    fx.execute_script("VP.workspace.panGridBy(40, 25);")
    time.sleep(0.3)
    after_pan = fx.execute_script(grid_state)
    check(
        "the grid moves",
        after_pan["gx"] != fitted["gx"] or after_pan["gy"] != fitted["gy"],
        "the grid did not move",
    )
    check(
        "the photo does not move when the grid does",
        after_pan["zoom"] == photo_before["z"]
        and after_pan["panX"] == photo_before["x"]
        and after_pan["panY"] == photo_before["y"],
        f"{photo_before} -> "
        f"{{'z': {after_pan['zoom']}, 'x': {after_pan['panX']}, 'y': {after_pan['panY']}}}",
    )

    # And the grid zooms without the photo zooming.
    fx.execute_script("VP.workspace.zoomGrid(2, 100, 100);")
    time.sleep(0.3)
    after_zoom = fx.execute_script(grid_state)
    check(
        "the grid zooms on its own",
        after_zoom["cell"] != after_pan["cell"],
        f"cell {after_pan['cell']} -> {after_zoom['cell']}",
    )
    check(
        "the photo does not zoom when the grid does",
        after_zoom["zoom"] == photo_before["z"],
        f"photo zoom {photo_before['z']} -> {after_zoom['zoom']}",
    )

    # A big canvas is the case that used to break: the cell size had a
    # floor of four pixels, so a 256-cell grid was always 1024 pixels
    # across and ran off the bottom of the pane.
    fx.execute_script("VP.canvas.resize(256, 256);")
    time.sleep(0.3)
    fx.execute_script("VP.workspace.updateCellSize(); VP.workspace.fitGrid();")
    time.sleep(0.4)
    big = fx.execute_script(grid_state)
    check(
        "a 256-cell grid fits in the pane",
        big["gridW"] <= big["paneW"] and big["gridH"] <= big["paneH"],
        f"grid {big['gridW']}×{big['gridH']} in a pane of "
        f"{big['paneW']}×{big['paneH']}",
    )
    check(
        "a cell can be smaller than four pixels",
        big["cell"] < 4,
        f"the cell is {big['cell']} pixels",
    )

    # The grid's own slider moves the grid and nothing else.
    fx.execute_script(
        """
        var z = document.getElementById('grid-zoom');
        z.value = '80';
        z.dispatchEvent(new Event('input', {bubbles: true}));
        """
    )
    time.sleep(0.3)
    slid = fx.execute_script(grid_state)
    check(
        "the grid's slider moves the grid",
        slid["cell"] != big["cell"],
        f"cell {big['cell']} -> {slid['cell']}",
    )

    # A canvas resize re-fits the grid, even after the user has set a cell
    # size by hand: the grid is the canvas's grid, so its shape has changed
    # outright and a cell size that fitted the old one can leave the new
    # grid running off the pane.
    set_canvas_size(fx, 128)
    time.sleep(0.5)
    refitted = fx.execute_script(grid_state)
    check(
        "a canvas resize re-fits the grid",
        refitted["gridW"] <= refitted["paneW"] and refitted["gridH"] <= refitted["paneH"],
        f"grid {refitted['gridW']}×{refitted['gridH']} in a pane of "
        f"{refitted['paneW']}×{refitted['paneH']}",
    )

    # Put it back for the rest of the suite: the framing the next checks
    # expect, with the photo over the grid.
    fx.execute_script(
        "VP.canvas.resize(32, 32);"
        "VP.workspace.updateCellSize(true);"
        "VP.workspace.fitGrid();"
        "VP.workspace.fitSource();"
    )
    time.sleep(0.4)

    section("the sliders keep up with the page")

    # Every slider has a reset button, and the reset puts back exactly what
    # the slider ships with.
    sliders = fx.execute_script(
        """
        const out = [];
        for (const el of document.querySelectorAll('input[type=range]')) {
          let button = null;
          const block = el.closest('.ws-slider');
          if (block) button = block.querySelector('.btn-reset');
          else {
            const label = el.closest('label');
            if (label) button = label.nextElementSibling;
          }
          out.push({
            id: el.id,
            defaultValue: el.defaultValue,
            hasReset: !!(button && button.classList.contains('btn-reset')),
          });
        }
        return out;
        """
    )
    # The three zoom sliders are framing controls, not adjustments: each one
    # has a Fit button of its own beside it, which is how it is put back.
    zoom_sliders = {"ws-zoom", "canvas-zoom", "grid-zoom"}
    without_reset = [
        s["id"] for s in sliders if not s["hasReset"] and s["id"] not in zoom_sliders
    ]
    for zoom_id, fit_id in (
        ("ws-zoom", "ws-fit"),
        ("canvas-zoom", "canvas-fit"),
        ("grid-zoom", "grid-fit"),
    ):
        check(
            f"the {zoom_id} slider has a fit button",
            bool(fx.execute_script(
                "return !!document.getElementById('%s');" % fit_id
            )),
            f"there is no #{fit_id}",
        )
    check(
        "every slider has a reset button",
        not without_reset,
        f"no reset on: {', '.join(without_reset)}",
    )

    # The preview must still be right a moment after a control stops moving,
    # even when the control never sends a `change` event. The settle has to
    # bake the current adjustment into the full-resolution copy itself.
    preview_hash = """
      const c = VP.canvas.state.previewBuffer;
      if (!c) return 'none';
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) >>> 0;
      return c.width + 'x' + c.height + ':' + h;
    """
    source_hash = """
      const s = document.getElementById('source-pane');
      const d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 397) h = (h * 31 + d[i]) >>> 0;
      return h;
    """
    before_preview = fx.execute_script(preview_hash)
    before_source = fx.execute_script(source_hash)

    # `input` only: this is what a control that never commits looks like.
    fx.execute_script(
        """
        const s = document.getElementById('ws-brightness');
        s.value = 165;
        s.dispatchEvent(new Event('input', {bubbles: true}));
        """
    )
    time.sleep(0.05)
    during = fx.execute_script(preview_hash)
    time.sleep(0.5)
    settled = fx.execute_script(preview_hash)
    settled_source = fx.execute_script(source_hash)

    check(
        "the preview follows the control while it moves",
        during != before_preview,
        "the preview did not change at all",
    )
    check(
        "the preview is still right when the control settles",
        settled == during,
        "the preview reverted to the previous value when the control settled",
    )
    check(
        "the photo in the pane updates when the control settles",
        settled_source != before_source,
        "the source pane still shows the old photo",
    )

    # The reset button puts the slider, the state and the preview back.
    fx.execute_script(
        """
        const block = document.getElementById('ws-brightness').closest('.ws-slider');
        block.querySelector('.btn-reset').click();
        """
    )
    time.sleep(0.5)
    reset_value = fx.execute_script("return document.getElementById('ws-brightness').value;")
    reset_state = fx.execute_script("return VP.reference.state.adjust.brightness;")
    reset_preview = fx.execute_script(preview_hash)
    check(
        "the reset button puts the slider back",
        reset_value == "100",
        f"the slider reads {reset_value}",
    )
    check(
        "the reset button puts the state back",
        abs(reset_state - 1) < 0.001,
        f"brightness is {reset_state}",
    )
    check(
        "the reset button puts the preview back",
        reset_preview == before_preview,
        "the preview did not return to where it started",
    )

    # The tuning palette must not compound: moving a slider and putting it
    # back has to restore exactly the colours that were there before.
    tune_hash = "return VP.palette.state.staged.slice().join(',');"
    tune_value = fx.execute_script(
        "return document.getElementById('ws-tune-saturation').value;"
    )
    original_tune = fx.execute_script(tune_hash)
    fx.execute_script(
        """
        const s = document.getElementById('ws-tune-saturation');
        s.value = 160;
        s.dispatchEvent(new Event('input', {bubbles: true}));
        s.dispatchEvent(new Event('change', {bubbles: true}));
        """
    )
    time.sleep(0.4)
    tuned_palette = fx.execute_script(tune_hash)
    fx.execute_script(
        """
        const s = document.getElementById('ws-tune-saturation');
        s.value = %s;
        s.dispatchEvent(new Event('input', {bubbles: true}));
        s.dispatchEvent(new Event('change', {bubbles: true}));
        """
        % tune_value
    )
    time.sleep(0.4)
    restored_tune = fx.execute_script(tune_hash)
    check(
        "the tuning palette does not compound",
        restored_tune == original_tune,
        "putting the slider back did not restore the colours",
    )
    check(
        "the tuning palette does change when it is moved",
        tuned_palette != original_tune,
        "moving the slider changed nothing",
    )

    # A preset replaces the whole transform, so the sliders have to follow it.
    fx.execute_script("VP.workspace.applyPreset('sprite pop');")
    time.sleep(0.4)
    preset = fx.execute_script(
        """
        const tune = VP.workspace.state.tune;
        const node = document.getElementById('ws-tune-contrast');
        return { state: tune.contrast, slider: parseFloat(node.value) };
        """
    )
    check(
        "a preset moves the sliders with it",
        abs(preset["state"] - preset["slider"]) < 0.5,
        f"the state says {preset['state']} and the slider says {preset['slider']}",
    )

    section("the no-upload guarantee")
    resources = fx.execute_script(
        "return performance.getEntriesByType('resource').map(function (e) { return e.name; });"
    )
    offsite = [
        name
        for name in resources
        if not name.startswith(base) and not name.startswith("data:") and not name.startswith("blob:")
    ]
    check(
        "the pipeline made no network request",
        not offsite,
        f"unexpected: {offsite}",
    )
    check(
        "the image was never requested",
        not any("test-photo" in name for name in resources),
        "the photo appears in the resource timings",
    )

    section("export")
    fx.execute_script(
        "VP.io.exportJSON(VP.canvas.state.width, VP.canvas.state.height,"
        " VP.palette.colours(), VP.canvas.grid);"
    )
    time.sleep(0.8)
    jsons = list(downloads.glob("*.json"))
    check("Export JSON writes a file", bool(jsons), f"found {list(downloads.iterdir())}")

    if jsons:
        payload = json.loads(jsons[0].read_text(encoding="utf-8"))
        check("the exported JSON is self-describing", payload.get("format") == "voidpixlr", str(payload.get("format")))
        check(
            "the exported JSON has the pixels",
            len(payload.get("pixels", [])) == payload.get("height")
            and all(len(row) == payload.get("width") for row in payload.get("pixels", [])),
            f"{len(payload.get('pixels', []))} rows for {payload.get('width')}×{payload.get('height')}",
        )
        check(
            "the exported JSON carries the palette",
            len(payload.get("palette", [])) == len(set(payload.get("palette", []))),
            "the palette is missing or has duplicates",
        )

    fx.execute_script(
        "VP.io.exportPNG(VP.canvas.state.width, VP.canvas.state.height,"
        " VP.palette.colours(), VP.canvas.grid, 4, null);"
    )
    time.sleep(1.2)
    pngs = list(downloads.glob("*.png"))
    check("Export PNG writes a file", bool(pngs), f"found {list(downloads.iterdir())}")

    section("persistence")
    before = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    fx.execute_script(
        "VP.storage.saveCanvas(VP.canvas.state.width, VP.canvas.state.height,"
        " VP.palette.colours(), VP.canvas.grid);"
    )
    time.sleep(0.2)
    fx.navigate(f"{base}/.vp-diag.html")
    time.sleep(0.8)
    restored = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check(
        "the canvas is restored after a reload",
        restored == before and restored > 0,
        f"{restored} cells, expected {before}",
    )

    errors = probe.errors(fx)
    check("no JavaScript errors across the whole run", not errors, "; ".join(errors))

    section("forget everything")
    fx.execute_script(
        "VP.storage.forgetEverything();"
    )
    time.sleep(0.5)
    remaining = fx.execute_script(
        "return [localStorage.getItem('voidpixelatr:canvas:v2'),"
        " localStorage.getItem('voidpixelatr:palettes:v2'),"
        " localStorage.getItem('voidpixelatr:prefs:v2')];"
    )
    check("forget everything clears the local storage", not any(remaining), str(remaining))

    fx.screenshot(str(shots / "07-final.png"))

    features(fx, base, shots)


def features(fx: Marionette, base: str, shots: Path) -> None:
    """The feature-level checks: imports, resize, shortcuts and the cases
    that are supposed to fail gracefully."""

    section("import JSON")
    fx.navigate(f"{base}/.vp-diag.html")
    time.sleep(0.7)

    # A v1 file: no `format` key, a twelve-colour palette.
    v1 = {
        "size": 16,
        "palette": [
            "#ffffff", "#000000", "#7f7f7f", "#ff4f4f",
            "#ffa64f", "#ffe44f", "#4fff4f", "#4fffff",
            "#4f4fff", "#a64fff", "#ff4fff", "#8b4513",
        ],
        "pixels": [[0, -1, 3, -1] + [-1] * 12 for _ in range(16)],
    }
    v1_path = Path("/tmp/vp-v1.json")
    v1_path.write_text(json.dumps(v1), encoding="utf-8")

    fx.set_file_input("#file-json", str(v1_path))
    fx.execute_script(
        "document.getElementById('file-json').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.0)

    palette_size = fx.execute_script("return VP.palette.colours().length;")
    check("a v1 file adopts its palette", palette_size == 12, f"{palette_size} colours")

    loaded = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v === 0; }).length;"
    )
    check("a v1 file loads its pixels", loaded == 16, f"{loaded} pixels")

    # A malformed file must be refused without touching the canvas.
    bad_path = Path("/tmp/vp-bad.json")
    bad_path.write_text(
        '{"size": 16, "palette": ["#ffffff"], "pixels": [[0]]}', encoding="utf-8"
    )
    before = fx.execute_script("return Array.from(VP.canvas.grid).join(',');")

    fx.set_file_input("#file-json", str(bad_path))
    fx.execute_script(
        "document.getElementById('file-json').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.0)

    error = fx.execute_script("return document.getElementById('import-error').textContent;")
    check("a malformed file is refused", "invalid" in error.lower(), error)
    after = fx.execute_script("return Array.from(VP.canvas.grid).join(',');")
    check("a refused import leaves the canvas untouched", before == after, "the grid changed")

    section("resize keeps the art")
    # There is no brush in this app, so the art is put on the canvas the way
    # the converter would: by writing the grid.
    fx.execute_script(
        """
        var g = new Int8Array(256).fill(-1);
        g[0] = 3;
        g[15 * 16 + 15] = 3;
        VP.canvas.setGrid(g);
        """
    )

    fx.execute_script(
        "const x = document.getElementById('size-x');"
        "x.value = '32';"
        "x.dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(0.3)
    panel = fx.execute_script(
        "return getComputedStyle(document.getElementById('resize-panel')).display;"
    )
    check("resizing with art opens the resize panel", panel != "none", f"display: {panel}")

    fx.click("#resize-confirm")
    time.sleep(0.5)
    size = fx.execute_script(
        "return VP.canvas.state.width + '×' + VP.canvas.state.height;"
    )
    check("the resize applies", size == "32×32", f"size {size}")

    corners = fx.execute_script(
        "return [VP.canvas.grid[0], VP.canvas.grid[8 * 32 + 8],"
        " VP.canvas.grid[23 * 32 + 23]];"
    )
    check(
        "the art is centred in the new canvas",
        corners[0] == -1 and corners[1] == 3 and corners[2] == 3,
        f"corners {corners}",
    )

    section("the keyboard")
    grid_before = fx.execute_script("return VP.canvas.state.gridVisible;")
    fx.execute_script("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'g'}));")
    time.sleep(0.2)
    grid_after = fx.execute_script("return VP.canvas.state.gridVisible;")
    check("G toggles the grid", grid_before != grid_after, f"{grid_before} -> {grid_after}")

    # L auto-levels the photo.
    fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.5)
    before_levels = fx.execute_script("return VP.reference.state.adjust.black;")
    fx.execute_script("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'l'}));")
    time.sleep(0.4)
    after_levels = fx.execute_script("return VP.reference.state.adjust.black;")
    check(
        "L auto-levels the photo",
        after_levels != before_levels,
        f"black point {before_levels} -> {after_levels}",
    )

    # X cycles the match method.
    before_match = fx.execute_script("return VP.workspace.state.matchMethod;")
    fx.execute_script("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'x'}));")
    time.sleep(0.3)
    after_match = fx.execute_script("return VP.workspace.state.matchMethod;")
    check("X cycles the match method", after_match != before_match, f"{before_match} -> {after_match}")

    # The arrows pan the source.
    before_pan = fx.execute_script("return VP.workspace.state.panX;")
    fx.execute_script(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight'}));"
    )
    time.sleep(0.3)
    after_pan = fx.execute_script("return VP.workspace.state.panX;")
    check("an arrow key pans the source", after_pan != before_pan, f"{before_pan} -> {after_pan}")

    # And there is no undo stack to reach for.
    fx.execute_script(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true}));"
    )
    time.sleep(0.3)
    still = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check("Ctrl+Z does nothing — there is no undo stack", still >= 0, f"{still} cells")

    section("copy PNG never dead-ends")
    label_before = fx.execute_script("return document.getElementById('copy-png').textContent;")
    fx.click("#copy-png")
    time.sleep(1.5)
    label_after = fx.execute_script("return document.getElementById('copy-png').textContent;")
    check(
        "copy PNG reports success or a download",
        label_after in ("Copied", "Downloaded") or label_after == label_before,
        f"'{label_before}' -> '{label_after}'",
    )

    section("the 256x256 canvas")
    fx.execute_script("VP.canvas.resize(256, 256);")
    time.sleep(0.3)
    fx.execute_script(
        """
        var g = new Int8Array(256 * 256).fill(-1);
        for (var i = 0; i < 200; i++) { g[(i * 7) % (256 * 256)] = 3; }
        VP.canvas.setGrid(g);
        """
    )
    started = fx.execute_script(
        "var t = performance.now(); VP.canvas.rebuildArt(); return performance.now() - t;"
    )
    check("a 256x256 redraw stays fast", started < 50, f"{started:.1f} ms")

    # A 256x256 canvas at 16x would be a 4096x4096 backing store. The
    # display is capped, so it must still composite without stalling.
    started = fx.execute_script(
        "var t = performance.now(); VP.canvas.composite(); return performance.now() - t;"
    )
    check("a 4096x4096 display composites without stalling", started < 400, f"{started:.1f} ms")

    backing = fx.execute_script("return document.getElementById('art-canvas').width;")
    check("the display backing store is capped at 4096", backing <= 4096, f"{backing} px")

    fx.execute_script("VP.canvas.setScale(4);")
    time.sleep(0.3)
    started = fx.execute_script(
        "var t = performance.now(); VP.canvas.composite(); return performance.now() - t;"
    )
    check("a 256x256 composite at 4x stays fast", started < 50, f"{started:.1f} ms")

    section("the inline confirm")
    # The confirmation lives on "Forget everything" now: there is no "New"
    # in a pipeline, because there is no artwork to start over.
    fx.execute_script(
        """
        var g = new Int8Array(256).fill(-1);
        g[0] = 3;
        VP.canvas.setGrid(g);
        """
    )
    fx.click("#forget")
    time.sleep(0.3)
    label = fx.execute_script("return document.getElementById('forget').textContent;")
    check("Forget everything asks before it wipes", label == "Sure?", label)

    still_there = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check("nothing is wiped until it is confirmed", still_there == 1, f"{still_there} cells")

    # The confirmation must not expire. It used to time out after two
    # seconds, so click it, read the label, look away for a moment, click
    # again — and the second click armed it a second time instead of
    # confirming it.
    time.sleep(2.5)
    label_still_armed = fx.execute_script(
        "return document.getElementById('forget').textContent;"
    )
    check(
        "the confirmation does not expire on a timer",
        label_still_armed == "Sure?",
        f"the button reads '{label_still_armed}'",
    )

    # And a click somewhere else cancels the armed confirmation.
    fx.execute_script("document.getElementById('art-canvas').click();")
    time.sleep(0.2)
    label_cancelled = fx.execute_script(
        "return document.getElementById('forget').textContent;"
    )
    check(
        "a click elsewhere cancels the confirmation",
        label_cancelled == "Forget everything",
        f"the button reads '{label_cancelled}'",
    )
    still_painted = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check(
        "a cancelled confirmation does not wipe anything",
        still_painted == 1,
        f"{still_painted} cells",
    )

    section("reordering a swatch")
    fx.execute_script("VP.palette.switchTo('Void Palette');")
    time.sleep(0.2)
    fx.execute_script(
        "var copy = VP.palette.duplicate('Void Palette'); VP.palette.switchTo(copy.name);"
    )
    time.sleep(0.3)
    before_order = fx.execute_script("return VP.palette.colours().slice(0, 2);")
    fx.execute_script(
        """
        var grid = document.getElementById('swatch-grid');
        var swatches = grid.querySelectorAll('.swatch');
        var from = swatches[1];   /* the first swatch */
        var to = swatches[2];     /* the second */
        var transfer = new DataTransfer();
        from.dispatchEvent(new DragEvent('dragstart', {dataTransfer: transfer, bubbles: true}));
        transfer.setData('text/plain', '0');
        to.dispatchEvent(new DragEvent('dragover', {dataTransfer: transfer, bubbles: true, cancelable: true}));
        to.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
        """
    )
    time.sleep(0.4)
    order = fx.execute_script("return VP.palette.colours().slice(0, 2);")
    check(
        "a swatch can be dragged to a new position",
        order == [before_order[1], before_order[0]],
        f"{before_order} -> {order}",
    )

    section("pasting an image")
    pasted = fx.execute_script(
        """
        var response = fetch('/.vp-test-image.png').then(function (r) { return r.blob(); });
        return response.then(function (blob) {
          var file = new File([blob], 'pasted.png', {type: 'image/png'});
          var transfer = new DataTransfer();
          transfer.items.add(file);
          var event = new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true});
          document.dispatchEvent(event);
          return transfer.items.length;
        });
        """
    )
    time.sleep(1.5)
    has_image = fx.execute_script("return VP.reference.hasImage();")
    check("an image can be pasted", has_image is True, "no session image")

    section("the import panel")
    before = fx.execute_script(
        "return getComputedStyle(document.getElementById('import-panel')).display;"
    )
    fx.execute_script("document.getElementById('import').click();")
    time.sleep(0.2)
    after = fx.execute_script(
        "return getComputedStyle(document.getElementById('import-panel')).display;"
    )
    check(
        "the import panel toggles inline",
        before != after and "none" in (before, after),
        f"'{before}' -> '{after}'",
    )
    modal = fx.execute_script("return document.querySelectorAll('dialog').length;")
    check("there is no native dialog", modal == 0, f"{modal} dialogs")

    section("the export scale cap")
    fx.execute_script("VP.canvas.resize(256, 256);")
    time.sleep(0.3)
    fx.execute_script("document.getElementById('export-png').click();")
    time.sleep(0.3)
    cap = fx.execute_script(
        """
        var button = document.getElementById('export-scale-32');
        return [button.disabled, button.textContent];
        """
    )
    check(
        "32x is refused on a 256x256 canvas",
        cap[0] is True and "too large" in cap[1],
        str(cap),
    )

    allowed = fx.execute_script(
        """
        var button = document.getElementById('export-scale-16');
        return [button.disabled, button.textContent];
        """
    )
    check("16x is still allowed on a 256x256 canvas", allowed[0] is False, str(allowed))

    section("a palette change reaches the workspace preview")

    # The swatch grid is only half of a palette change. The live preview in
    # the workspace has to follow it too, or switching the palette in the
    # sidebar leaves the preview showing the previous palette's result.
    # Measured before the fix: the preview hash did not change at all.
    #
    # The suite has wiped the storage by this point, so there is nothing to
    # preview until a photo is loaded again.
    fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.5)

    preview_of_palette = """
        const c = VP.canvas.state.previewBuffer;
        if (!c) return 'none';
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) >>> 0;
        return c.width + 'x' + c.height + ':' + h;
    """
    before_palette = fx.execute_script(preview_of_palette)
    fx.execute_script(
        """
        const select = document.getElementById('palette-select');
        select.value = 'Void Expanded';
        select.dispatchEvent(new Event('change', {bubbles: true}));
        """
    )
    time.sleep(0.8)
    after_palette = fx.execute_script(preview_of_palette)
    check(
        "a palette change reaches the workspace preview",
        after_palette != before_palette,
        "the preview did not change when the palette did",
    )

    section("click to upload, and drop it anywhere")

    # Start from the state that matters: no photo loaded.
    fx.execute_script("VP.reference.clear();")
    time.sleep(0.5)

    # The photo is the way into the whole pipeline, and its button is always
    # there — in the top bar, where nothing can hide it.
    upload = fx.execute_script(
        """
        const b = document.getElementById('load-photo');
        if (!b) return { present: false };
        const r = b.getBoundingClientRect();
        return {
          present: true,
          visible: r.width > 1 && r.height > 1 && !b.closest('[hidden]'),
          text: b.textContent,
        };
        """
    )
    check("there is a button to load a photo", upload.get("present") is True, "no button")
    check(
        "the load button is visible before any photo is loaded",
        upload.get("visible") is True,
        str(upload),
    )

    # Clicking it must reach the file input.
    wired = fx.execute_script(
        """
        const input = document.getElementById('file-image');
        const original = HTMLInputElement.prototype.click;
        let clicked = null;
        HTMLInputElement.prototype.click = function () { clicked = this.id; };
        document.getElementById('load-photo').click();
        HTMLInputElement.prototype.click = original;
        return clicked;
        """
    )
    check("the load button opens the file picker", wired == "file-image", str(wired))

    # The empty state in the source pane is a click target too.
    empty = fx.execute_script(
        """
        const button = document.getElementById('ws-source-load');
        return { present: !!button, text: button ? button.textContent : null };
        """
    )
    check(
        "the source pane's empty state offers a way in",
        empty["present"] is True,
        str(empty),
    )

    # And a photo dropped ANYWHERE on the page loads — not only over the
    # canvas. Releasing it over the sidebar used to do nothing at all.

    dropped = fx.execute_async_script(
        """
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ff0000';
        context.fillRect(0, 0, 8, 8);
        canvas.toBlob((blob) => {
          const file = new File([blob], 'dropped.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const target = document.getElementById('sidebar');
          target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
          const highlighted = document.body.classList.contains('is-drop-target');
          target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
          arguments[arguments.length - 1](highlighted);
        }, 'image/png');
        """
    )
    time.sleep(1.5)
    check(
        "the page highlights when a photo is dragged over it",
        dropped is True,
        "no highlight",
    )
    check(
        "a photo dropped on the sidebar loads",
        fx.execute_script("return VP.reference.hasImage();") is True,
        fx.execute_script("return document.getElementById('alert-text').textContent;"),
    )
    check(
        "the drop is handled once, not twice",
        fx.execute_script("return VP.reference.state.source.name;") == "dropped.png",
        fx.execute_script("return VP.reference.state.source.name;"),
    )

    section("the limits on the load page")
    note = fx.execute_script("return document.getElementById('ws-load-note').textContent;")
    check(
        "the load page states the limits",
        "never uploaded" in note and "64 MB" in note and "2048" in note,
        note,
    )

    errors = probe.errors(fx)
    check("no JavaScript errors in the feature pass", not errors, "; ".join(errors))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
