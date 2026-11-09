#!/usr/bin/env python3
"""VoidPixelatr — the demo.

Drives the real app in a real Firefox and captures the screenshots that
document it, in `docs/`. Nothing is mocked: the conversion is the app's own
pipeline, from a real photograph.

    python3 tests/browser/demo.py [--base http://127.0.0.1:8792]
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from marionette import Marionette  # noqa: E402

ROOT = HERE.parent.parent
IMAGES = Path("/tmp/vp-images")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8792")
    args = parser.parse_args(argv[1:])

    if not IMAGES.exists():
        print("error: run `python3 tools/make-test-images.py /tmp/vp-images` first.")
        return 2

    shots = ROOT / "docs" / "shots"
    if shots.exists():
        shutil.rmtree(shots)
    shots.mkdir(parents=True, exist_ok=True)

    firefox = Marionette()
    try:
        firefox.start()
        run(firefox, args.base, shots)
    finally:
        firefox.stop()

    print(f"\nwrote {len(list(shots.glob('*.png')))} screenshots to {shots}")
    return 0


def run(firefox: Marionette, base: str, shots: Path) -> None:
    firefox.set_window_rect(1500, 950)
    firefox.navigate(f"{base}/index.html")
    time.sleep(0.8)

    print("• the empty pipeline")
    firefox.screenshot(str(shots / "01-empty.png"))

    print("• the photo, framed under the grid")
    firefox.set_file_input("#file-image", str(IMAGES / "test-photo.png"))
    firefox.execute_script(
        "document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));"
    )
    time.sleep(1.4)
    firefox.execute_script("VP.workspace.fitSource();")
    time.sleep(0.4)
    firefox.screenshot(str(shots / "02-photo-framed.png"))

    print("• the extracted palette, tuned")
    firefox.execute_script("VP.canvas.resize(32, 32); VP.workspace.updateCellSize();")
    firefox.execute_script("VP.workspace.extract();")
    time.sleep(0.4)
    firefox.execute_script("VP.workspace.applyPreset('sprite pop');")
    time.sleep(0.4)
    firefox.screenshot(str(shots / "03-palette-tuned.png"))

    print("• the conversion, live on the canvas")
    firefox.execute_script("VP.workspace.convert();")
    time.sleep(0.6)
    firefox.execute_script("VP.canvas.setScale(16);")
    time.sleep(0.3)
    firefox.screenshot(str(shots / "04-converted.png"))

    print("• the menu, dropped open")
    firefox.execute_script(
        "document.querySelector('.menu-section[data-section=\"convert\"] .menu-head').click();"
    )
    time.sleep(0.4)
    firefox.screenshot(str(shots / "05-menu.png"))

    print("• the 404 page")
    firefox.navigate(f"{base}/nope")
    time.sleep(0.6)
    firefox.screenshot(str(shots / "06-not-found.png"))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
