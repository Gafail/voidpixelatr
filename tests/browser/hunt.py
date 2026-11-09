#!/usr/bin/env python3
"""VoidPixelatr — hunt for a runtime error by driving every flow.

    python3 tests/browser/hunt.py [--base http://127.0.0.1:8792]

Runs every user-facing flow in order and reports the first error with its
stack trace, so a failure names the function that caused it rather than
just the symptom.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The project root, derived from this file — never a hard-coded path, so the
# suite works wherever the project is checked out.
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from marionette import Marionette  # noqa: E402

IMAGES = Path("/tmp/vp-images")

PROBE = """\
window.__vpErrors = [];
window.addEventListener('error', function (event) {
  window.__vpErrors.push((event.error && event.error.stack) || event.message);
});
window.addEventListener('unhandledrejection', function (event) {
  window.__vpErrors.push('unhandled rejection: ' + event.reason);
});
var __ce = console.error;
console.error = function () {
  window.__vpErrors.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
  __ce.apply(console, arguments);
};
"""


def errors(fx):
    return fx.execute_script("return window.__vpErrors || [];") or []


def step(fx, name: str, script: str, wait: float = 0.6) -> list[str]:
    fx.execute_script(script)
    time.sleep(wait)
    found = errors(fx)
    if found:
        print(f"  ✗ {name}")
        for item in found:
            print(f"      {item}")
        return found
    print(f"  ✓ {name}")
    return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8792")
    args = parser.parse_args()

    if not IMAGES.exists():
        print("error: run `python3 tools/make-test-images.py /tmp/vp-images` first.")
        return 2

    photo = str(IMAGES / "test-photo.png")

    fx = Marionette()
    failures = 0
    try:
        fx.start()
        fx.set_window_rect(1500, 950)

        # Install the probe on a copy of the page.
        root = ROOT
        diag = root / ".vp-hunt.html"
        html = (root / "index.html").read_text(encoding="utf-8")
        probe_path = root / ".vp-hunt.js"
        probe_path.write_text(PROBE, encoding="utf-8")
        html = html.replace(
            '<script src="js/quantise.js"></script>',
            '<script src=".vp-hunt.js"></script><script src="js/quantise.js"></script>',
        )
        diag.write_text(html, encoding="utf-8")

        print(f"navigating to {args.base}/.vp-hunt.html")
        try:
            fx.navigate(f"{args.base}/.vp-hunt.html")
        except Exception:
            print("note: the served tree has no probe slot; using the local tree")
            fx.navigate("http://127.0.0.1:8792/.vp-hunt.html")
        time.sleep(1.0)

        print("\nthe flows")
        failures += len(step(fx, "the app boots", "return;", 0.2))

        print("\nthe photo")
        fx.set_file_input("#file-image", photo)
        failures += len(step(fx, "a photo is chosen", """
          document.getElementById('file-image').dispatchEvent(new Event('change', {bubbles: true}));
        """, 1.6))

        failures += len(step(fx, "fit framing", "document.getElementById('ws-fit').click();", 0.6))
        failures += len(step(fx, "pixel framing", "document.getElementById('ws-pixel').click();", 0.6))
        failures += len(step(fx, "the grid is fitted", "document.getElementById('grid-fit').click();", 0.6))
        failures += len(step(fx, "zoom in", """
              const s = document.getElementById('ws-zoom');
              s.value = String(Math.min(100, Number(s.value) + 12));
              s.dispatchEvent(new Event('input', {bubbles: true}));
            """, 0.5))
        failures += len(step(fx, "zoom out", """
              const s = document.getElementById('ws-zoom');
              s.value = String(Math.max(0, Number(s.value) - 12));
              s.dispatchEvent(new Event('input', {bubbles: true}));
            """, 0.5))
        failures += len(step(fx, "the grid zooms", """
              const s = document.getElementById('grid-zoom');
              s.value = String(Math.min(100, Number(s.value) + 12));
              s.dispatchEvent(new Event('input', {bubbles: true}));
            """, 0.5))
        failures += len(step(fx, "auto levels", "document.getElementById('ws-auto-levels').click();", 0.9))

        for slider in ("ws-black", "ws-white", "ws-brightness", "ws-contrast", "ws-saturation", "ws-hue"):
            failures += len(step(fx, f"the {slider} slider", f"""
              const s = document.getElementById('{slider}');
              s.value = String(Math.round((Number(s.min) + Number(s.max)) / 2));
              s.dispatchEvent(new Event('input', {{bubbles: true}}));
            """, 0.6))

        failures += len(step(fx, "greyscale", """
          const g = document.getElementById('ws-grey');
          g.checked = true; g.dispatchEvent(new Event('change', {bubbles: true}));
        """, 0.7))

        failures += len(step(fx, "reset every adjustment", "document.getElementById('ws-reset-adjust').click();", 0.9))

        print("\nthe palette")
        failures += len(step(fx, "extract a palette", "document.getElementById('ws-extract').click();", 1.8))
        failures += len(step(fx, "16 colours", "document.getElementById('ws-count-16').click();", 1.4))
        failures += len(step(fx, "64 colours", "document.getElementById('ws-count-64').click();", 1.6))

        for preset in ("pop", "muted", "deep", "pastel", "normalise"):
            failures += len(step(fx, f"the {preset} preset", f"""
              document.getElementById('ws-preset-{preset}').click();
            """, 0.9))

        for slider in ("ws-tune-saturation", "ws-tune-brightness", "ws-tune-contrast",
                       "ws-tune-hue", "ws-tune-posterise"):
            failures += len(step(fx, f"the {slider} slider", f"""
              const s = document.getElementById('{slider}');
              s.value = String(Math.round((Number(s.min) + Number(s.max)) / 2));
              s.dispatchEvent(new Event('input', {{bubbles: true}}));
            """, 0.7))

        print("\nthe conversion")
        for size in (16, 64, 128, 256):
            failures += len(step(fx, f"convert at {size}", f"""
              const x = document.getElementById('size-x');
              x.value = '{size}';
              x.dispatchEvent(new Event('change', {{bubbles: true}}));
              document.getElementById('ws-convert').click();
            """, 1.6))

        print("\nexport and import")
        failures += len(step(fx, "export PNG", "document.getElementById('export-png').click();", 1.3))
        failures += len(step(fx, "export JSON", "document.getElementById('export-json').click();", 1.1))
        failures += len(step(fx, "copy PNG", "document.getElementById('copy-png').click();", 1.5))
        failures += len(step(fx, "the import panel opens", "document.getElementById('import').click();", 0.6))

        print("\nthe canvas")
        failures += len(step(fx, "the canvas zooms", """
              const z = document.getElementById('canvas-zoom');
              z.value = String(Math.min(100, Number(z.value) + 12));
              z.dispatchEvent(new Event('input', {bubbles: true}));
            """, 0.5))
        failures += len(step(fx, "fit the canvas", "document.getElementById('canvas-fit').click();", 0.5))
        failures += len(step(fx, "the grid toggles", "document.getElementById('grid-toggle').click();", 0.5))

        print("\nthe menu")
        for section in ("palette", "adjust", "extract", "convert"):
            failures += len(step(fx, f"the {section} section opens", f"""
              document.querySelector('.menu-section[data-section="{section}"] .menu-head').click();
            """, 0.4))
        failures += len(step(fx, "the colour pop-over opens", "document.getElementById('colours-toggle').click();", 0.5))

    finally:
        fx.stop()
        for path in (
            ROOT / ".vp-hunt.html",
            ROOT / ".vp-hunt.js",
        ):
            path.unlink(missing_ok=True)

    print("")
    if failures:
        print(f"{failures} error(s) found")
        return 1
    print("no errors in any flow")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
