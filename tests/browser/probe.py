"""VoidPixelatr — the shared error probe for the browser suites.

The probe has to be in place **before** the app's own scripts run, so a
boot-time exception cannot slip past unnoticed.

It used to be injected as an inline `<script>`, which works only when the
server sends no Content-Security-Policy. Under the shared CSP
(`script-src 'self'`) an inline script is blocked, the probe never
installs, `window.__vpErrors` stays `undefined`, and every "no JavaScript
errors" check reads an empty array and passes. The check looked green and
was blind — the worst kind of test failure, because it reports success
while measuring nothing.

So the probe is written as its own file and loaded with `src`, which
`script-src 'self'` allows. `is_installed()` lets a suite assert the probe
really ran, so this can never go quietly blind again.
"""

from __future__ import annotations

from pathlib import Path

PROBE_NAME = ".vp-probe.js"
DIAG_NAME = ".vp-diag.html"

# The first script tag in index.html. The probe is inserted in front of it.
ANCHOR = '<script src="js/quantise.js"></script>'

PROBE_JS = """\
// Injected by tests/browser/probe.py — the error probe.
// Loaded as a separate file so it survives a strict
// Content-Security-Policy (`script-src 'self'` blocks inline scripts).
window.__vpErrors = [];
window.addEventListener('error', function (event) {
  window.__vpErrors.push((event.error && event.error.stack) || event.message);
});
window.addEventListener('unhandledrejection', function (event) {
  window.__vpErrors.push('unhandled rejection: ' + event.reason);
});
var __vpConsoleError = console.error;
console.error = function () {
  window.__vpErrors.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
  __vpConsoleError.apply(console, arguments);
};
window.__vpProbeInstalled = true;
"""


def install(root: Path, base: str = "index.html", diag_name: str = DIAG_NAME) -> Path:
    """Write the probe and a copy of the page that loads it first.

    Returns the path of the diagnostic page.
    """
    root = Path(root)
    (root / PROBE_NAME).write_text(PROBE_JS, encoding="utf-8")

    html = (root / base).read_text(encoding="utf-8")
    if ANCHOR not in html:
        raise SystemExit(f"error: {base} does not contain the expected script anchor.")
    html = html.replace(
        ANCHOR,
        f'<script src="{PROBE_NAME}"></script>{ANCHOR}',
    )
    diag = root / diag_name
    diag.write_text(html, encoding="utf-8")
    return diag


def cleanup(root: Path, diag_name: str = DIAG_NAME) -> None:
    """Remove the probe and the diagnostic page."""
    root = Path(root)
    (root / diag_name).unlink(missing_ok=True)
    (root / PROBE_NAME).unlink(missing_ok=True)


def is_installed(fx) -> bool:
    """True when the probe really ran. False means the error checks are blind."""
    return fx.execute_script("return window.__vpProbeInstalled === true") is True


def errors(fx) -> list[str]:
    """The errors the probe has collected so far."""
    return fx.execute_script("return window.__vpErrors || []")
