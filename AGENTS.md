# VoidPixelatr — AI Handoff

> A photo-to-pixel-art pipeline that runs entirely in the browser. Load a
> photo, frame it under a grid, adjust it, extract a palette, convert, export.
> Nothing is ever uploaded.

**Status:** built and tested — **not deployed**, no container, no registry row
**Domain:** none (LAN-only when it ships)
**Brand identity:** "A photo becomes pixel art." Flat rectangles, no
gradients, no rounded corners, no animations, no shadows except the canvas
glow. Accent `#4f4fff` on `#0d0d0f`.

## What this project is

A **pipeline**. There is no brush, no eraser, no symmetry, no stroke undo and
no `New`. The canvas is written by the converter and read by the exporter,
and by nothing else.

Its sibling, **VoidPixlr** (`~/Desktop/voidpixlr/`), is the hand-made
pixel-art canvas. The two were one project and are now two. They share the
project-file format and the colour maths; they share **nothing else** — not
a folder, not a repository, not a byte of stored state.

**Do not add drawing tools here.** If the work needs a brush, it belongs in
VoidPixlr. That is the whole point of the split.

## Architecture

- **Frontend:** vanilla HTML, CSS and JavaScript. No framework, no bundler,
  no build step, no TypeScript, no npm, no dependencies.
- **Backend:** none. nginx serves a directory. There is no runtime, no
  systemd unit, no database.
- **Persistence:** `localStorage` for the result, the palettes and the
  preferences; **IndexedDB** for the photo. Both local-only, both clearable
  with one button. Nothing is ever transmitted — there is no `fetch`, no
  `XMLHttpRequest`, no `sendBeacon`, no `blob:` URL anywhere in the source.
- **Rendering:** a layered buffer model, not DOM nodes. `artBuffer` and
  `previewBuffer` are offscreen canvases at art resolution; the visible
  canvas composites them. 256×256 is 65 536 cells and stays responsive.
- **Deploy pipeline:** `./deploy.sh` → rsync → install the vhost and the
  shared nginx snippet → `nginx -t` → reload → smoke test. **Never run.**

## File map

- `index.html` — the markup. No inline script, no inline event handlers
  (the shared CSP is `script-src 'self'`).
- `css/style.css` — every style and every token.
- `js/quantise.js` — the pure algorithm layer: colour maths, nearest-colour
  matching, median cut, Lloyd refinement, the area-average sampler, the
  source adjustments, the four match methods, the grid serialiser. No DOM.
- `js/palette.js` — the palette model, the three nested built-ins, editing,
  reordering, the staging palette, the re-indexing on a palette change, and
  the hue-family classifier the balance test uses.
- `js/storage.js` — `localStorage` (three keys) and the IndexedDB photo
  store. Every write is wrapped; a quota error is swallowed.
- `js/canvas.js` — the buffers (art, preview), the compositing, the zoom.
  **No pointer handling, no symmetry, no eraser.**
- `js/reference.js` — the source layer: loading, the working copy, the
  adjustments, auto levels. **No underlay, no fit modes, no modes at all.**
- `js/io.js` — PNG and JSON export, JSON import, the clipboard with its
  download fallback.
- `js/workspace.js` — the pipeline: the source pane's pan and zoom, the
  **grid's own pan and zoom**, the adjustments, palette extraction and
  tuning, the conversion, and the two-tier live preview — which is drawn on
  the canvas, not on a second one.
- `js/menu.js` — the menu: the sections that drop open, and the colour
  pop-over, which floats over the canvas beside the button that opened it.
- `js/app.js` — the bootstrap: wiring, the keyboard, drag and drop, paste,
  the inline panels, the autosave.
- `ops/nginx/voidpixelatr.conf` — the vhost. **Never installed.**
- `tests/voidpixelatr.test.mjs` — the dependency-free node tests.
- `tests/browser/marionette.py` — a minimal Marionette client: a real
  Firefox, driven with no dependencies and no geckodriver.
- `tests/browser/e2e.py` — the end-to-end browser tests.
- `tests/browser/hostile.py` — the hostile pass: bad files, lying project
  files, storage that throws.
- `tools/make-test-images.py` — writes the test images (stdlib only).
- `project.md` — the specification. The single source of truth.
- `project-v1.0.md` — the archived VoidPixlr v1.0 specification, carried
  across with the code.

There is **no `js/history.js`**. The undo stack went with the brush.

## How to test

```bash
node tests/voidpixelatr.test.mjs       # 141 logic checks, no dependencies

./serve.sh                              # then, in another shell:
python3 tools/make-test-images.py /tmp/vp-images
python3 tests/browser/e2e.py            # 101 end-to-end checks
python3 tests/browser/hostile.py        # 33 hostile-input checks
```

The browser tests drive a real Firefox over Marionette. Firefox must be on
the path; nothing else is needed.

**One Firefox at a time.** Two suites running at once collide on the
profile and die with `MarionetteError: the connection closed`.

**"The connection closed" is not always a profile collision.** Two other
things produce it, and the client now tells them apart. Firefox opens the
listening socket *before* its Marionette server is ready to talk, so a
connection made in that window is accepted and closed with no handshake —
the client retries the handshake until its deadline instead of dying on
the first try. And if the browser is killed mid-run the error now says
so, with its pid: the usual cause is the **OOM killer**, which on a busy
machine takes the headless test Firefox rather than the big browser
someone has had open all day. Check `dmesg | grep -i oom` before
suspecting the app.

To run them under the **real shared CSP** — which is the only way to show
the app works under `script-src 'self'` — use the CSP server instead of
`./serve.sh`:

```bash
python3 tests/browser/csp_server.py --port 8793 &
python3 tests/browser/e2e.py --base http://127.0.0.1:8793
python3 tests/browser/hostile.py --base http://127.0.0.1:8793
```

It parses the umbrella's real `security-headers.conf`, so it cannot drift
from what nginx will send.

## How to deploy

**Not now.** There is no container, nothing is deployed, and there is no
registry row in TheVoidCo. The scaffolding is here so the project is
standalone and *can* be given a box when it wants one.

`ops/PROVISION.md` is the full checklist for the day that happens. The short
version:

1. Provision the container (a full clone of the base template — never a
   copy of `.199`, which would carry TheVoidCo's own site). Reserve the new
   MAC in the router at `192.168.100.1`. Set the hostname. **Regenerate the
   SSH host keys** — `rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && systemctl
   restart ssh` — and never skip that step.
2. Register the host in the umbrella's `ops/vm.sh`. It uses the **shared**
   deploy key, `ops/keys/thevoidco-lxc-id_ed25519`, which the clone
   inherits in `/root/.ssh/authorized_keys` — there is no per-project key and
   no password, so `CREDENTIALS.md` needs no `export` line for it.
3. `./deploy.sh <ip>` — the address is mandatory. The script refuses to run
   without one.
4. Add the registry row to the umbrella's root `README.md`, pointing at
   **this folder** — `~/Desktop/voidpixelatr/`. The source stays here. The
   umbrella holds no copy of it: it is a standalone project and TheVoidCo
   only points at it. Do not rsync, copy or symlink this folder anywhere.
5. `python3 website/scripts/sync-registry.py` then
   `node website/tests/site.test.mjs`.

## How to debug

- **Nothing renders, or the page is blank** → check the console first. The
  app binds nothing at load time; it waits for `DOMContentLoaded`.
- **The palette is empty** → `VP.palette.render()` throws. Check that the
  swatch grid element exists.
- **A photo will not load** → check the file size and dimensions against
  `VP.reference.LIMITS`; the limits are stated on the load page.
- **The picture is dim or muddy** → the source adjustments run *before*
  sampling. Raise the contrast before the saturation.
- **The palette has no colours** → `VP.palette.colours()` is the staging
  palette when one exists. That is intentional.
- **The source pane is blank but the photo loaded** → the pane's canvas was
  never sized to its container. `VP.workspace.init()` calls
  `W.resizeCanvases()` *before* `W.updateCellSize()`, because the cell size
  is derived from the pane's dimensions and the pane's dimensions come from
  the canvas being sized to it. Reverse the order and the grid is fitted to
  a 300×150 default canvas and the photo is drawn off the bottom of it.
- **The clipboard does nothing** → a plain `http://` LAN address is not a
  secure context. `Copy PNG` falls back to a download. That is intentional.

## Known gotchas

- **`ImageData` is not a `drawImage` source in Firefox.** Paint it into a
  canvas with `putImageData` and draw the canvas. This bit three functions
  at once.
- **The `hidden` attribute loses to `display: flex`.** The stylesheet has a
  global `[hidden] { display: none !important }` for exactly this reason.
- **`VP.reference.adjust` and `VP.reference.state.adjust` are the same thing.**
  The module exposes its state as properties, so the two spellings cannot
  drift. Do the same for any new module state.
- **The reduced copy and the full copy are not the same thing.** While a
  control is moving only the reduced copy of the photo is updated; the
  full-resolution copy keeps the last *settled* value, so the pane does not
  flicker. Anything that renders from the full copy must first call
  `VP.reference.commitAdjust()`, or it will show a stale value — this is
  what made the preview snap back and the source pane look frozen.
- **Transform the palette from the original, never from the last result.**
  `VP.palette.transformStaged()` always starts from `stagedSource`. Doing
  it otherwise compounds: every slider move applies on top of the previous
  one and the colours never come back.
- **A palette change has to reach the pipeline.** `renderAll()` redraws the
  menu and the bars, but the live preview is made *of* the palette. Without
  `VP.workspace.refresh()` in `renderAll()`, switching the palette leaves
  the preview showing the old palette's result.
- **The whole page takes a dropped photo.** The drop handler is on the
  document, not on two boxes: the old per-target handlers had to go
  because the drop event bubbles, and leaving them would load the image
  twice.
- **The layout diagnostic measures rectangles, not pixels.** It clips every
  box to its scroll containers before comparing them — an element hanging
  past a scrolling container's edge is clipped by it, so it cannot overlap
  what is outside. A `position: fixed` element escapes its DOM ancestors'
  overflow, so it is *not* clipped by them.
- **Never expire an armed confirmation on a timer.** `armConfirm` waits for
  a second click, a click elsewhere, or Escape. A timeout turned the
  confirmation into a trap — click, pause, click again, and the second click
  armed it a second time instead of confirming it.
- **Never call `URL.createObjectURL`.** The shared CSP's `img-src` has no
  `blob:`, and the no-upload guarantee rules it out by name. Downloads go
  out as `data:` URLs.
- **The display canvas is capped at 4096 device pixels a side.** A 256×256
  canvas at 16× on a HiDPI screen would otherwise ask for 268 MB.
- **`cellPx` is fixed when the grid size changes, not on every pane
  resize.** Otherwise enlarging the browser window would silently change
  what the conversion samples. But a **canvas resize re-fits it** — the
  grid is the canvas's size, so a grid that kept its old cell size grew
  off the bottom of the pane and half of what was converted was out of
  sight.
- **The grid is a view of its own.** `state.gridX` / `state.gridY` are
  where it sits in the pane and `state.cellPx` is the size of one cell on
  screen; the photo's `zoom` / `panX` / `panY` are the photo's. The
  sampler takes all four as separate numbers, so the grid decides *which*
  part of the photo is converted and the photo decides *how* it is
  magnified. `Shift`+drag moves the grid; `Shift`+wheel zooms it.
- **A cell can be one pixel across.** The old floor of four pixels meant a
  256-cell grid was always 1024 pixels across and a 512-cell grid was
  2048 — the grid could never be seen whole, and there was no control
  that could make it smaller. `Fit` fits the whole grid in the pane.
- **`VP.canvas.grid` is a getter onto `VP.canvas.state.grid`.** It was a
  real bug when it did not exist: every palette switch threw.
- **The canvas is not square, and `size` is gone.** `VP.canvas.state.width`
  and `.height` are the two edges; the grid's row stride is the **width**.
  Every buffer, export and autosave carries both.
- **The X and Y dropdowns are dropdowns, not free text.** They are filled
  from `Q.ALLOWED_SIZES` — 16, 32, 64, 128, 256, 512 — so the canvas is
  always one of the allowed sizes. The lock button ties them together;
  locked, changing either sets both.
- **A second size change must build on the *pending* size.** Set X to 64,
  then Y to 32: the panel has to say "64 × 32". Reading the canvas's
  current size instead threw the first change away — the panel said
  "16 × 32" and the 64 was lost.
- **There is one art canvas.** The pipeline's live conversion is a
  **layer over the result** (`VP.canvas.setPreview`), drawn in the same
  canvas the result lives in. There is no `#preview-pane` any more.
- **Each pane zooms on its own.** The source's zoom is
  `VP.workspace.state.zoom`; the canvas's is `VP.canvas.state.scale`.
  Neither writes to the other, and the canvas's scale is an integer from
  1 to 64 — the slider maps to it logarithmically. The grid has a third
  zoom of its own: `state.cellPx`, from 1 to 64.
- **There is one menu, on the left.** The palette and the pipeline's
  controls were two columns, both permanently open. Now they are five
  sections of one menu — Palette, Colours, Adjust, Extract, Convert —
  each a header that opens a body. The centre holds the photo and the
  canvas and nothing else.
- **The colours are a pop-over, not a section.** A sixty-four swatch grid
  is sixteen rows and taller than the whole menu. It floats over the
  canvas, positioned in script from the button that opened it, and closes
  on a click elsewhere or on `Escape`. It is `position: fixed` on purpose:
  the menu scrolls, and a fixed child escapes that overflow instead of
  being clipped by it.
- **The built-in palettes are balanced on purpose.** Twelve hue families,
  each with one step in the 16, two in the 32 and four in the 64. The node
  suite checks that with `P.hueCoverage()`; the check is the point, so do
  not "tidy" a ramp without checking the test still passes.
- **The palettes are nested, so a palette is a prefix of the bigger one.**
  The steps of a hue are therefore spread across the tiers rather than
  sitting next to each other, and the swatch grid reads as a value table.
- **The spec's palette tables are checked against the code.** A node test
  reads `project.md` and `js/palette.js` and compares them. Change one and
  you must change the other.
- **The storage namespace is `voidpixelatr:*`.** VoidPixlr keeps
  `voidpixlr:*`. The two apps are served from the same origin during local
  development, so they must not share a key — one would read the other's
  work. The *project-file format* is shared; the *stored* state is not.
- **The browser suites' error probe must be a file, not an inline
  `<script>`.** The shared CSP is `script-src 'self'`, which blocks inline
  scripts. An inline probe never installs, `window.__vpErrors` stays
  `undefined`, and every "no JavaScript errors" check reads an empty array
  and passes — green, and blind. It lives in `tests/browser/probe.py` and is
  loaded with `src`; both suites assert `probe.is_installed()` first, so it
  cannot go quietly blind again.
- **The vhost's address is the placeholder `192.0.2.0`.** That is the RFC
  5737 documentation range, so a checked-in config can never name a live
  machine. `deploy.sh` substitutes the real address at install time and
  refuses to run without one. Do not "fix" it by hard-coding a LAN address:
  `192.168.100.200` is already occupied by an unrelated device, and
  `192.168.100.100` is VoidPixlr's.
- **The cloned template's own site must be disabled before ours is
  enabled.** Both are `listen 80 default_server`, and nginx refuses to
  start with two of them: `a duplicate default server for 0.0.0.0:80`.
  `deploy.sh` removes the other links in `sites-enabled`; the files stay in
  `sites-available`.
- **There is one deploy key for all of TheVoidCo.**
  `ops/keys/thevoidco-lxc-id_ed25519`, inherited by every clone. A
  per-project key would never be installed on the container and would break
  the house rule.

## Brand identity

- Name: **VoidPixelatr** (lowercase `voidpixelatr` for the folder).
- Tagline: "A photo becomes pixel art."
- Voice: plain, short, unhurried. No exclamation marks, no emoji, no
  marketing.
- Colour: `#0d0d0f` background, `#e8e8ea` text, `#4f4fff` accent.

## Live operations state

- **Canonical home: `~/Desktop/voidpixelatr/`.** This folder is the project.
  It is its own git repository. **It has no remote** — it is a local
  repository with the full history, cut from VoidPixlr r14. TheVoidCo holds
  **no copy** of this source and **no registry row** for it. Never copy or
  symlink this folder into another repository; a duplicate copy is a second
  thing to forget to update, and this project has already drifted once
  because of it.
- **Nothing is deployed.** There is no container, no vhost installed and no
  address reserved. The container at `.100` belongs to **VoidPixlr** and
  serves that project alone.
- The vhost carries the placeholder `192.0.2.0` in the repository;
  `deploy.sh` substitutes the real address when it installs it — the day
  there is something to install it on.
- The house rule this project breaks, on purpose: **no storage on the
  site**. The user's photos, palettes and results live on their own
  machine, and one button forgets all of it. See §9.4 of `project.md`.
