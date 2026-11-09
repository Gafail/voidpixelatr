# VoidPixelatr

A photo-to-pixel-art pipeline that runs entirely in your browser. Load a
photo, frame it under a grid, adjust it, pull a palette out of it, convert
it, export it.

**A photo in, a sprite out. Nothing is uploaded. Nothing is ever sent
anywhere.**

> **This project is local.** There is no container, no deployment, no
> registry row and no GitHub remote. It was cut out of VoidPixlr — the
> hand-made pixel-art canvas — and it stands on its own. The deploy
> scaffolding is in the folder so it *can* be given a box when it wants one,
> but nothing has been installed and nothing has been deployed.

> **Working on this project?** [`AGENTS.md`](AGENTS.md) is the handoff
> document: what the project is, what it is not, how to test it, and the
> gotchas that have bitten before. Read that first.

- **The pipeline.** Frame a photo under a grid by panning and zooming, adjust
  its levels and saturation, pull a 16/32/64 palette out of it, tune that
  palette for sprites, and convert it to pixel art with cell averaging and
  four matching methods. Every control re-renders the result while you drag
  it — on the canvas itself, in the same canvas the result lives in.
- **The grid is a view of its own.** It has a zoom — down to a single pixel,
  so a 512×512 grid fits on the screen — and a pan, and neither one touches
  the photo's zoom or pan. `Fit` fits the whole grid in the pane.
- **Palettes.** The Void Palette (16), Void Expanded (32) and Void Full (64)
  ship built in and are nested, so switching between them never disturbs
  your result. Twelve hue families, each with the same depth in every palette —
  every hue has a ramp to shade with. Build your own at 16, 32 or 64.
- **One menu, on the left.** Palette, colours, adjustments, extraction and
  conversion are five sections that drop open, and the colours are a
  pop-over. Nothing is open until you want it.
- **Rectangular output.** An X and a Y, each 16, 32, 64, 128, 256 or 512 — a
  rectangle is as ordinary as a square, and a lock button ties the two
  together when you want one. A photo's aspect ratio is often not a square's.
- **Import and export.** JSON round-trips, v1 files still load, PNG at five
  scales with a transparent or solid background.

## What this project is not

There is no brush. No eraser. No symmetry. No stroke undo. No `New`. The
canvas is written by the converter and read by the exporter, and by nothing
else.

Making pixel art by hand is **VoidPixlr**'s job — a separate project, on the
same desktop, with its own canvas, its own palette and its own PNG export.
The two share the project-file format, so a conversion made here opens there
and an artwork made there opens here. They share nothing else: not a folder,
not a repository, and not a single byte of stored state.

## The promise

Your photo is decoded in your browser, drawn to a canvas, and read back into
memory. There is no `fetch`, no `XMLHttpRequest`, no `sendBeacon`, no
`blob:` URL, no form, and no endpoint to send anything to. The nginx access
log for a full pipeline run contains the app's own static files and nothing
else.

Your work *is* stored — on your own machine, in `localStorage` and
IndexedDB. That is a deliberate, documented exception to the house rule,
and **Forget everything** wipes the lot in one click.

## Running it

```bash
./serve.sh          # http://127.0.0.1:8792
```

No build step. No dependencies. Open `index.html` and it works.

## Testing

```bash
node tests/voidpixelatr.test.mjs   # 141 logic checks

python3 tools/make-test-images.py /tmp/vp-images
python3 tests/browser/e2e.py        # 101 end-to-end checks in a real Firefox
python3 tests/browser/hostile.py    # 33 hostile-input checks
```

The browser tests drive a real Firefox over Marionette — a minimal client in
`tests/browser/marionette.py`, no geckodriver, no npm.

### Testing under the real CSP

`python3 -m http.server` sends no `Content-Security-Policy`, so a suite run
against it cannot show that the app works under the shared CSP. The
`csp_server.py` test server fixes that: it parses the umbrella's real
`ops/nginx-snippets/security-headers.conf` and sends exactly those headers.

```bash
python3 tests/browser/csp_server.py --port 8793 &
python3 tests/browser/e2e.py --base http://127.0.0.1:8793
python3 tests/browser/hostile.py --base http://127.0.0.1:8793
```

Both suites pass either way. That is the point — the app has no inline
script and no inline event handler, so `script-src 'self'` allows it.

## The specification

`project.md` is the single source of truth: the architecture, every
decision, the walkthroughs and the acceptance criteria.
`project-v1.0.md` is the archived VoidPixlr v1.0 spec, carried across with
the code.

## Licence and identity

A standalone Void* project. It holds its own copy of the source, and the
umbrella — if it ever holds a row for it — will only *point* at this folder.
Local-first, no accounts, no tracking, no telemetry.
