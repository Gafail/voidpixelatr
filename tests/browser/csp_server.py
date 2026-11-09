#!/usr/bin/env python3
"""VoidPixelatr — serve the site with the real shared security headers.

The browser suites normally run against `python3 -m http.server`, which
sends no Content-Security-Policy at all. That is a weaker test than it
looks: criterion 58 says the app "runs clean under the shared CSP", and a
server with no CSP cannot show that.

This server sends exactly the headers in the shared security snippet
(deploy/nginx/security-headers.conf), parsed out of the real file
rather than transcribed, so it cannot drift from what nginx will send. If
the snippet changes, this changes with it.

    python3 tests/browser/csp_server.py [--port 8793] [--root <dir>]

Then point a suite at it:

    python3 tests/browser/e2e.py --base http://127.0.0.1:8793

The app has no inline <script> and no inline event handlers, so
`script-src 'self'` is enough. If the server ever reports a CSP violation
the suites will see it as a JavaScript error, which is the point.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import re
import socketserver
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent.parent

# The shared snippet, vendored into this repository so it stands on its own.
LOCAL_SNIPPET = PROJECT_ROOT / "ops" / "nginx-snippets" / "security-headers.conf"


def find_snippet() -> Path:
    """The vendored copy first, then the umbrella's if it is sitting alongside.

    The vendored copy is what a clone of this repository has, so it has to
    come first or the server cannot start at all for anyone but the author.
    The umbrella's copy is preferred when it is there, because that is the
    file nginx actually installs — and a node test checks the two agree, so
    the vendored copy cannot quietly drift away from it.
    """
    if LOCAL_SNIPPET.is_file():
        return LOCAL_SNIPPET

    for directory in (PROJECT_ROOT, *PROJECT_ROOT.parents):
        candidate = directory / "ops" / "nginx-snippets" / "security-headers.conf"
        if candidate.is_file():
            return candidate

    for sibling in PROJECT_ROOT.parent.glob("*/"):
        candidate = sibling / "ops" / "nginx-snippets" / "security-headers.conf"
        if candidate.is_file():
            return candidate

    raise SystemExit(
        "error: could not find deploy/nginx/security-headers.conf.\n"
        "       It ships with this repository — check the checkout is complete."
    )


def parse_headers(snippet: Path) -> dict[str, str]:
    """Pull the `add_header Name "value" always;` lines out of the snippet."""
    headers: dict[str, str] = {}
    pattern = re.compile(
        r"""add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"\s*(always)?\s*;"""
    )
    for line in snippet.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        match = pattern.match(stripped)
        if match:
            headers[match.group(1)] = match.group(2)
    if "Content-Security-Policy" not in headers:
        raise SystemExit(f"error: no Content-Security-Policy in {snippet}")
    return headers


class CSPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler plus the shared security headers."""

    server_version = "voidpixelatr-csp-test"

    def end_headers(self) -> None:
        for name, value in self.server.security_headers.items():  # type: ignore[attr-defined]
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        if "--quiet" in sys.argv:
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8793)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--root", default=str(PROJECT_ROOT))
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    snippet = find_snippet()
    headers = parse_headers(snippet)

    handler = functools.partial(CSPRequestHandler, directory=args.root)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server((args.bind, args.port), handler) as httpd:
        httpd.security_headers = headers  # type: ignore[attr-defined]
        print(f"serving {args.root} with the shared headers from {snippet}")
        for name, value in headers.items():
            print(f"  {name}: {value}")
        print(f"on http://{args.bind}:{args.port}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
