#!/usr/bin/env python3
"""Generate test images for VoidPixelatr.

Two images, both written as PNG with nothing but the standard library:

  test-photo.png    a synthetic "photo": a sky gradient, a sun, a hill and a
                    face-like blob. The point is that the ground truth is
                    known, so the conversion can be checked.
  test-grid.png     a crisp 4x4 colour grid with alpha — the reference for
                    nearest-neighbour sampling and PNG import.

Usage:  python3 tools/make-test-images.py [output-dir]
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path


def write_png(path: Path, width: int, height: int, rows: list[bytearray]) -> None:
    """Writes 8-bit RGBA rows out as a PNG."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_photo(width: int = 320, height: int = 240) -> list[bytearray]:
    rows = []
    sun_x, sun_y, sun_r = width * 0.72, height * 0.26, height * 0.13

    for y in range(height):
        row = bytearray()
        v = y / (height - 1)

        for x in range(width):
            u = x / (width - 1)

            # Sky: deep blue at the top, warm at the horizon.
            if v < 0.62:
                t = v / 0.62
                colour = mix((28, 46, 120), (236, 150, 92), t)
            else:
                # Hills.
                t = (v - 0.62) / 0.38
                hill = 0.62 + 0.10 * math.sin(u * 6.0) + 0.05 * math.cos(u * 11.0)
                if v < hill:
                    colour = mix((36, 74, 52), (22, 44, 34), t)
                else:
                    colour = mix((96, 140, 72), (58, 92, 50), t)

            # The sun.
            d = math.hypot(x - sun_x, y - sun_y)
            if d < sun_r:
                colour = (255, 236, 170)
            elif d < sun_r * 1.5:
                k = 1 - (d - sun_r) / (sun_r * 0.5)
                colour = mix(colour, (255, 220, 140), k * 0.6)

            # A face: an ellipse with two eyes.
            fx, fy = width * 0.32, height * 0.55
            if ((x - fx) / (width * 0.16)) ** 2 + ((y - fy) / (height * 0.24)) ** 2 < 1:
                colour = (232, 196, 168)
                for eye_dx in (-width * 0.055, width * 0.055):
                    d = math.hypot(x - (fx + eye_dx), y - (fy - height * 0.05))
                    if d < width * 0.022:
                        colour = (26, 22, 30)

            row += bytes(colour) + b"\xff"
        rows.append(row)
    return rows


def make_grid(width: int = 4, height: int = 4) -> list[bytearray]:
    colours = [
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (255, 255, 0),
        (255, 0, 255),
        (0, 255, 255),
        (255, 255, 255),
        (0, 0, 0),
        (128, 128, 128),
        (255, 128, 0),
        (128, 0, 255),
        (0, 128, 128),
        (192, 192, 192),
        (64, 64, 64),
        (240, 240, 160),
        (32, 32, 48),
    ]
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            r, g, b = colours[(y * width + x) % len(colours)]
            alpha = 255 if x != width - 1 else 0
            row += bytes((r, g, b, alpha))
        rows.append(row)
    return rows


def make_large(width: int = 2400, height: int = 1800) -> list[bytearray]:
    """A photo larger than the 2048 working cap.

    This is the case the resampler only takes when the source is bigger
    than the cap — and it is where the ImageData was handed straight to
    drawImage, which Firefox refuses. Nothing above 320x240 ever reached
    that path, so nothing caught it.
    """
    rows = []
    for y in range(height):
        row = bytearray()
        v = y / (height - 1)
        for x in range(width):
            u = x / (width - 1)
            colour = mix((20, 30, 90), (230, 140, 80), v)
            if math.hypot(x - width * 0.5, y - height * 0.45) < height * 0.22:
                colour = (240, 220, 190)
            row += bytes(colour) + b"\xff"
        rows.append(row)
    return rows


def main(argv: list[str]) -> int:
    out = Path(argv[1] if len(argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)

    photo = out / "test-photo.png"
    write_png(photo, 320, 240, make_photo())
    print(f"wrote {photo} (320x240)")

    grid = out / "test-grid.png"
    write_png(grid, 4, 4, make_grid())
    print(f"wrote {grid} (4x4, with alpha)")

    large = out / "test-large.png"
    write_png(large, 2400, 1800, make_large())
    print(f"wrote {large} (2400x1800 — over the 2048 working cap)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
