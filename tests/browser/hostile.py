#!/usr/bin/env python3
"""VoidPixelatr — the hostile pass.

Everything here is something that should not work: a file that is not an
image, a PNG that is not a PNG, a project file that lies about its size, a
palette that references a colour that does not exist, storage that throws.
The app must survive all of it, say something sensible, and never lose the
artwork that is already on the canvas.

    python3 tests/browser/hostile.py [--base http://127.0.0.1:8792]
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
IMAGES = Path("/tmp/vp-images")

PASSED = 0
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ✓ {name}")
    else:
        FAILURES.append(f"{name} — {detail}")
        print(f"  ✗ {name}\n      {detail}")


def section(title: str) -> None:
    print(f"\n{title}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8792")
    args = parser.parse_args(argv[1:])

    # The error listener is a separate file, not an inline <script>: the
    # shared CSP is `script-src 'self'`, which blocks inline scripts, and a
    # blocked probe never installs — the error checks would read an empty
    # array and pass while measuring nothing.
    probe.install(ROOT)

    firefox = Marionette()
    try:
        firefox.start()
        run(firefox, args.base)
    finally:
        firefox.stop()
        probe.cleanup(ROOT)

    print("")
    if FAILURES:
        print(f"{PASSED} passed, {len(FAILURES)} failed")
        for failure in FAILURES:
            print(f"  · {failure}")
        return 1
    print(f"{PASSED} passed")
    return 0


def run(fx: Marionette, base: str) -> None:
    fx.set_window_rect(1400, 900)
    fx.navigate(f"{base}/.vp-diag.html")
    time.sleep(0.8)

    loaded = fx.execute_script("return typeof VP === 'object' && !!VP.canvas;")
    check("the app actually loaded", loaded is True, "the page is not the app")

    # If the probe did not install, every error check below reads an empty
    # array and passes without measuring anything. Say so loudly.
    check(
        "the error probe installed itself",
        probe.is_installed(fx) is True,
        "the probe did not run — the error checks below would be blind",
    )

    section("a file that is not an image")
    junk = Path("/tmp/vp-not-an-image.txt")
    junk.write_text("this is not a picture", encoding="utf-8")
    fx.set_file_input("#file-image", str(junk))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(0.8)
    has_image = fx.execute_script("return VP.reference.hasImage();")
    check("a text file is not loaded as an image", has_image is False, "an image appeared")

    errors = probe.errors(fx)
    check("a text file raises nothing", not errors, "; ".join(errors))

    section("a PNG that is not a PNG")
    broken = Path("/tmp/vp-broken.png")
    broken.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    fx.set_file_input("#file-image", str(broken))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.0)

    # The message has to be VISIBLE, not merely present. It used to be
    # written into the import panel, which is hidden unless you opened it —
    # so a failed load produced no message the user could see at all.
    message = fx.execute_script(
        "const bar = document.getElementById('alert');"
        "const text = document.getElementById('alert-text');"
        "return {text: text.textContent,"
        " shown: !bar.hidden,"
        " visible: getComputedStyle(bar).display !== 'none'};"
    )
    check(
        "a broken PNG is refused with a visible message",
        message["text"] != "" and message["shown"] and message["visible"],
        f"no visible message ({message})",
    )

    # And the alert can be dismissed.
    fx.execute_script("document.getElementById('alert-dismiss').click();")
    time.sleep(0.3)
    dismissed = fx.execute_script("return document.getElementById('alert').hidden;")
    check("the alert can be dismissed", dismissed is True, "the alert stayed up")
    has_image = fx.execute_script("return VP.reference.hasImage();")
    check("a broken PNG leaves no session image", has_image is False, "an image appeared")

    errors = probe.errors(fx)
    check("a broken PNG raises nothing", not errors, "; ".join(errors))

    section("project files that lie")
    canvas_before = fx.execute_script("return Array.from(VP.canvas.grid).join(',');")

    lies = {
        "size": [
            {"size": 999, "palette": ["#ffffff"], "pixels": []},
            {"size": 0, "palette": ["#ffffff"], "pixels": []},
            {"size": "16", "palette": ["#ffffff"], "pixels": []},
            {"size": 16, "palette": ["#ffffff"] * 65, "pixels": []},
            {"size": 16, "palette": ["not-a-colour"], "pixels": []},
            {"size": 16, "palette": ["#ffffff"], "pixels": [[0], [0]]},
            {"size": 16, "palette": ["#ffffff"], "pixels": "nope"},
            {"format": "voidpixlr", "version": 99, "size": 16, "palette": ["#ffffff"], "pixels": []},
        ],
        "not json": "{ this is not json at all",
    }

    for name, payload in lies.items():
        path = Path(f"/tmp/vp-lie-{abs(hash(name))}.json")
        path.write_text(
            payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8"
        )
        fx.set_file_input("#file-json", str(path))
        fx.execute_script(
            "document.getElementById('file-json').dispatchEvent(new Event('change', {bubbles: true}));"
        )
        time.sleep(0.5)
        message = fx.execute_script("return document.getElementById('import-error').textContent;")
        check(f"a bad project file is refused: {name}", message != "", "no message")

    canvas_after = fx.execute_script("return Array.from(VP.canvas.grid).join(',');")
    check(
        "no bad file touched the canvas",
        canvas_before == canvas_after,
        "the grid changed",
    )

    errors = probe.errors(fx)
    check("bad project files raise nothing", not errors, "; ".join(errors))

    section("the pipeline with no image")
    extracted = fx.execute_script("return VP.workspace.extract();")
    check("Extract with no image returns nothing", extracted is None, str(extracted))
    converted = fx.execute_script("return VP.workspace.convert();")
    check("Convert with no image returns false", converted is False, str(converted))
    status = fx.execute_script("return document.getElementById('ws-status').textContent;")
    check("the pipeline says so", "image" in status.lower(), status)

    errors = probe.errors(fx)
    check("the empty pipeline raises nothing", not errors, "; ".join(errors))

    section("storage that throws")
    result = fx.execute_script(
        """
        /* Firefox's Storage methods live on the prototype, so that is where
           the failure has to be injected. */
        var proto = Object.getPrototypeOf(window.localStorage);
        var real = proto.setItem;
        proto.setItem = function () { throw new Error('quota exceeded'); };
        var outcome;
        try {
          outcome = VP.storage.saveCanvas(16, 16, VP.palette.colours(),
            VP.canvas.grid);
        } catch (e) {
          outcome = 'threw: ' + e.message;
        }
        proto.setItem = real;
        return String(outcome);
        """
    )
    check("a full quota is swallowed", result == "false", result)

    errors = probe.errors(fx)
    check("a full quota raises nothing", not errors, "; ".join(errors))

    section("switching palettes with art on the canvas")
    # There is no brush here, so the art is put on the canvas the way the
    # converter would: by writing the grid.
    fx.execute_script(
        """
        var g = new Int8Array(256).fill(-1);
        g[0] = 4;    /* red */
        g[1] = 12;   /* blue */
        VP.canvas.setGrid(g);
        """
    )
    before = fx.execute_script(
        "return [VP.palette.colours()[VP.canvas.grid[0]],"
        " VP.palette.colours()[VP.canvas.grid[1]]];"
    )
    check("the art shows the expected colours", before == ["#d1333a", "#3559d9"], str(before))

    fx.execute_script("VP.palette.switchTo('Void Full');")
    time.sleep(0.3)
    after = fx.execute_script(
        "return [VP.palette.colours()[VP.canvas.grid[0]],"
        " VP.palette.colours()[VP.canvas.grid[1]]];"
    )
    check(
        "the colours survive the switch exactly",
        after == ["#d1333a", "#3559d9"],
        str(after),
    )

    fx.execute_script("VP.palette.switchTo('Void Expanded');")
    time.sleep(0.3)
    after = fx.execute_script(
        "return [VP.palette.colours()[VP.canvas.grid[0]],"
        " VP.palette.colours()[VP.canvas.grid[1]]];"
    )
    check(
        "the colours survive the second switch exactly",
        after == ["#d1333a", "#3559d9"],
        str(after),
    )

    section("a second image replaces the first")
    fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.2)
    first = fx.execute_script("return VP.reference.state.source.name;")
    check("the first image loads", first == "test-photo.png", first)

    fx.set_file_input("#file-image", str(IMAGES / "test-grid.png"))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.2)
    second = fx.execute_script("return VP.reference.state.source.name;")
    dims = fx.execute_script(
        "return [VP.reference.state.source.width, VP.reference.state.source.height];"
    )
    check("the second image replaces the first", second == "test-grid.png", second)
    check("the replacement is the new image", dims == [4, 4], str(dims))

    section("clearing the photo")
    # The empty pane is the background plus the grid overlay, and the grid is
    # always there — it is where the conversion will land. Both are greys in
    # the red and green channels, so a pixel whose red and green differ is
    # a pixel of the photograph.
    def photo_pixels() -> int:
        return fx.execute_script(
            """
            const c = document.getElementById('source-pane');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let coloured = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] !== d[i+1]) coloured += 1;
            }
            return coloured;
            """
        )

    while_loaded = photo_pixels()
    check("the photograph is in the pane", while_loaded > 0, f"{while_loaded} pixels")

    fx.execute_script("VP.reference.clear();")
    time.sleep(0.4)
    has_image = fx.execute_script("return VP.reference.hasImage();")
    check("clearing releases the image", has_image is False, "the image is still there")

    cleared = photo_pixels()
    check("the photograph goes out of the pane", cleared == 0, f"{cleared} pixels left")

    painted = fx.execute_script(
        "return Array.from(VP.canvas.grid).filter(function (v) { return v >= 0; }).length;"
    )
    check("clearing the photo leaves the art alone", painted == 2, f"{painted} cells")

    section("converting twice")
    fx.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    fx.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.2)
    fx.execute_script("VP.workspace.updateCellSize();")
    fx.execute_script("VP.workspace.extract();")
    time.sleep(0.3)
    fx.execute_script("VP.workspace.convert();")
    time.sleep(0.4)
    first_size = fx.execute_script(
        "return VP.canvas.state.width + '×' + VP.canvas.state.height;"
    )
    fx.execute_script("VP.workspace.convert();")
    time.sleep(0.4)
    second_size = fx.execute_script(
        "return VP.canvas.state.width + '×' + VP.canvas.state.height;"
    )
    check(
        "converting twice is stable",
        first_size == second_size,
        f"{first_size}, {second_size}",
    )

    section("there is no undo stack")
    # A pipeline has nothing to undo: the way to change the result is to
    # change a setting and convert again.
    stack = fx.execute_script(
        "return {history: typeof VP.app.state.history,"
        " module: typeof VP.history};"
    )
    check("the app has no undo stack", stack["history"] == "undefined", str(stack))
    check("there is no history module", stack["module"] == "undefined", str(stack))

    before = fx.execute_script(
        "return Array.from(VP.canvas.grid).join(',');"
    )
    for _ in range(12):
        fx.execute_script(
            "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true}));"
        )
    time.sleep(0.5)
    after = fx.execute_script(
        "return Array.from(VP.canvas.grid).join(',');"
    )
    check("Ctrl+Z leaves the artwork alone", before == after, "the grid changed")

    errors = probe.errors(fx)
    check("no JavaScript errors in the whole hostile pass", not errors, "; ".join(errors))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
