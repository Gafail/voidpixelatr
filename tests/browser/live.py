#!/usr/bin/env python3
"""VoidPixelatr — check a served site under the real CSP.

The browser suites need to inject an error probe into the page before the
app's scripts run, which means they need write access to the served tree.
A served site has none — and must not have any, because a deploy ships the
site and nothing else.

So this is the check for a *served* site. It does not need the probe: the
thing it proves is that the app boots at all under the real
Content-Security-Policy. A blocked inline script would leave `VP` undefined
and the palette unrendered, which is exactly what this looks for.

    python3 tests/browser/live.py --base http://127.0.0.1:8793

Point it at the CSP server to check the real headers:

    python3 tests/browser/csp_server.py --port 8793 &
    python3 tests/browser/live.py --base http://127.0.0.1:8793

There is no container for this project yet and nothing is deployed. The
check exists so that the day there is one, the site is verified the same way.

What it checks:

    · the page loads and the app boots (VP is there)
    · the palette rendered — so every script loaded, under the real CSP
    · the pipeline is on screen: the source pane, the menu and the action
    · a photo loads locally and the pipeline converts it
    · zero network requests outside the origin
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from marionette import Marionette  # noqa: E402

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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8793")
    args = parser.parse_args(sys.argv[1:])

    if not IMAGES.exists():
        print("error: run `python3 tools/make-test-images.py /tmp/vp-images` first.")
        return 2

    firefox = Marionette()
    try:
        firefox.start()
        firefox.set_window_rect(1500, 950)

        section("the site loads")
        firefox.navigate(args.base)
        time.sleep(1.2)

        title = firefox.execute_script("return document.title;")
        check(
            "the page is the app",
            "VoidPixelatr" in (title or ""),
            f"title was {title!r}",
        )

        booted = firefox.execute_script(
            "return typeof VP === 'object' && !!VP.canvas && !!VP.palette && !!VP.workspace;"
        )
        check(
            "the app booted — every script loaded under the real CSP",
            booted is True,
            "VP is not defined, so a script was blocked or threw",
        )

        swatches = firefox.execute_script(
            "return document.getElementById('swatch-grid').children.length;"
        )
        check("the palette rendered", swatches == 17, f"got {swatches}")

        section("the pipeline is on screen")
        layout = firefox.execute_script(
            """
            const pane = document.getElementById('ws-source-pane');
            const menu = document.getElementById('menu-pipeline');
            const foot = document.getElementById('menu-foot');
            const canvas = document.getElementById('art-canvas');
            const region = document.getElementById('canvas-region');
            return {
              pane: pane.getBoundingClientRect().width,
              menu: menu.getBoundingClientRect().height,
              foot: foot.getBoundingClientRect().height,
              css: Math.round(canvas.getBoundingClientRect().width),
              room: region.clientWidth,
            };
            """
        )
        check("the source pane is there", layout["pane"] > 100, str(layout))
        check("the pipeline's controls are there", layout["menu"] > 50, str(layout))
        check("the action is pinned at the foot", layout["foot"] > 10, str(layout))
        check(
            "the canvas fits its pane",
            layout["css"] <= layout["room"],
            f"{layout['css']}px in a {layout['room']}px pane",
        )

        section("the pipeline runs")
        firefox.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
        firefox.execute_script(
            "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
        )
        time.sleep(1.8)

        loaded = firefox.execute_script("return VP.reference.hasImage();")
        check("the photo loaded", loaded is True, "no image")

        firefox.execute_script("VP.workspace.extract();")
        time.sleep(1.2)
        extracted = firefox.execute_script("return VP.palette.colours().length;")
        check("a palette was extracted", extracted > 0, f"{extracted} colours")

        firefox.execute_script("VP.workspace.convert();")
        time.sleep(1.8)
        converted = firefox.execute_script(
            "return {cells: VP.canvas.state.grid.filter(v => v >= 0).length,"
            " size: VP.canvas.state.width + '×' + VP.canvas.state.height};"
        )
        check(
            "the conversion painted the canvas",
            converted["cells"] > 0,
            f"{converted['cells']} cells painted",
        )

        section("no network requests")
        offsite = firefox.execute_script(
            "return performance.getEntriesByType('resource')"
            ".map(e => e.name)"
            ".filter(n => !n.startsWith(location.origin));"
        )
        check(
            "nothing was requested from off-site",
            not offsite,
            f"off-site requests: {offsite}",
        )

    finally:
        firefox.stop()

    print("")
    if FAILURES:
        print(f"{PASSED} passed, {len(FAILURES)} failed")
        for failure in FAILURES:
            print(f"  · {failure}")
        return 1
    print(f"{PASSED} passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
