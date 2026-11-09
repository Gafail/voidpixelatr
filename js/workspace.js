/* ==========================================================================
   VoidPixelatr — workspace.js
   --------------------------------------------------------------------------
   The pipeline. It is not a mode and there is nothing to switch off: the
   SOURCE pane sits beside the canvas from the first load, and the canvas
   itself becomes the live result — there is no second art canvas and no
   second grid.

   The framing is pan and zoom under a fixed, screen-anchored grid overlay.
   There is no crop. The grid decides what will be converted; the framing
   decides what part of the photo it covers and at what detail.

   The source pane and the canvas have their own zoom, and neither one moves
   the other. Zooming the photo does not zoom the pixel art; zooming the
   pixel art does not zoom the photo.

   Everything is live. Moving a slider re-samples the grid and re-matches it
   to the palette while the control is moving, in a reduced quality tier, and
   the full-resolution result is drawn over it once the control settles.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = VP.quantise;
  const W = (VP.workspace = {});

  /* The overlay sits 8px in from the pane's top-left corner and does not
     move when the image moves. */
  const OVERLAY_INSET = 8;

  /* The preview is computed at up to 64 cells on the long edge while a
     control is moving. */
  const PREVIEW_MAX = 64;

  /* The source pane's zoom range: the photo can be pulled right back or
     pushed in until its own pixels are visible. */
  const SOURCE_ZOOM_MIN = 0.05;
  const SOURCE_ZOOM_MAX = 32;

  /* The grid's own zoom range: the on-screen size of one cell, in pixels.
     A cell smaller than one pixel cannot be seen, so that is the floor;
     there is no ceiling beyond what the pane can usefully show. */
  const GRID_CELL_MIN = 1;
  const GRID_CELL_MAX = 64;

  /* The grid and the photo are two separate views of the same thing. The
     photo has a zoom and a pan; the grid has a zoom and a pan. Neither one
     writes to the other, and the grid is what decides which part of the
     photo is converted. */
  const state = {
    panX: 0,
    panY: 0,
    zoom: 1,
    cellPx: 16,
    gridX: OVERLAY_INSET,
    gridY: OVERLAY_INSET,
    cellAuto: true,
    sampleMethod: "average",
    matchMethod: "flat",
    extractCount: 32,
    tune: Q.defaultTransform(),
    fullSample: null,
    sampleDirty: true,
    dragging: false,
  };

  /* The app sets this to receive the conversion: the grid, its size and the
     palette that produced it. */
  W.onConvert = null;

  W.state = state;

  /* The grid the workspace converts into: the canvas's own size. One size,
     one grid — the Draw mode and the Image mode agree on what the artwork
     is, and the workspace's target is never a second, separate thing. */
  function gridSize() {
    return { width: VP.canvas.state.width, height: VP.canvas.state.height };
  }

  /* --- DOM handles ------------------------------------------------------------ */

  const el = {};

  function grab() {
    el.workspace = document.getElementById("menu-pipeline");
    el.foot = document.getElementById("menu-foot");
    el.source = document.getElementById("source-pane");
    el.sourcePane = document.getElementById("ws-source-pane");
    el.zoomSlider = document.getElementById("ws-zoom");
    el.zoomReadout = document.getElementById("ws-zoom-readout");
    el.gridSlider = document.getElementById("grid-zoom");
    el.gridReadout = document.getElementById("grid-zoom-readout");
    el.status = document.getElementById("ws-status");
    el.paletteStatus = document.getElementById("ws-palette-status");
    el.loadNote = document.getElementById("ws-load-note");
    el.sourceEmpty = document.getElementById("ws-source-empty");
    el.tune = document.getElementById("ws-tune");
    el.targets = document.getElementById("ws-targets");
    el.targetSize = document.getElementById("ws-target-size");
    el.convertSummary = document.getElementById("convert-summary");
  }

  /* --- the panes ------------------------------------------------------------------ */

  W.resizeCanvases = function resizeCanvases() {
    const canvas = el.source;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = root.devicePixelRatio || 1;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    W.draw();
  };

  /* The on-screen size of one grid cell, and where the grid sits.

     `cellPx` is the grid's own zoom: the size of one cell on screen. It is
     derived from the pane size when the grid size changes, and then held
     steady — if it tracked the pane on every resize, enlarging the browser
     window would silently change what the conversion samples. The user can
     set it by hand, and then it is theirs until the grid size changes.

     `gridX` and `gridY` are the grid's own pan: where its top-left corner
     sits in the pane. The photo has its own pan, and the two are separate:
     the grid decides which part of the photo is converted, and the photo
     decides how that part is magnified.

     The old cell size had a floor of four pixels, so a 256-cell grid was
     always 1024 pixels across and ran off the bottom of the pane. The floor
     is now one pixel, which is as small as a cell can be and still be
     seen.

     `force` re-fits even when the user has taken the cell size by hand. It
     is used when the *canvas* changes size: the grid is the canvas's grid,
     so its shape has changed outright, and a cell size that fitted the old
     shape can leave the new one running off the pane. */
  W.updateCellSize = function updateCellSize(force) {
    if (!state.cellAuto && !force) return;
    const pane = el.source;
    if (!pane) return;
    const width = pane.clientWidth;
    const height = pane.clientHeight;
    if (!width || !height) return;
    const grid = gridSize();
    const fitted = Math.floor(Math.min(width / grid.width, height / grid.height));
    state.cellPx = Math.min(GRID_CELL_MAX, Math.max(GRID_CELL_MIN, fitted || GRID_CELL_MIN));
    state.cellAuto = true;
    W.centreGrid();
  };

  /* The grid's rectangle on screen: where it is and how big it is. */
  function gridRect() {
    const grid = gridSize();
    return {
      x: state.gridX,
      y: state.gridY,
      width: grid.width * state.cellPx,
      height: grid.height * state.cellPx,
    };
  }

  /* Centres the grid in the pane, at its current cell size. */
  W.centreGrid = function centreGrid() {
    const pane = el.source;
    if (!pane) return;
    const rect = gridRect();
    state.gridX = Math.round((pane.clientWidth - rect.width) / 2);
    state.gridY = Math.round((pane.clientHeight - rect.height) / 2);
  };

  /* Fits the whole grid into the pane and centres it. This is the button
     that answers "I cannot see all of it". */
  W.fitGrid = function fitGrid() {
    const pane = el.source;
    if (!pane) return;
    const width = pane.clientWidth;
    const height = pane.clientHeight;
    if (!width || !height) return;
    const grid = gridSize();
    const fitted = Math.floor(Math.min(width / grid.width, height / grid.height));
    state.cellPx = Math.min(GRID_CELL_MAX, Math.max(GRID_CELL_MIN, fitted || GRID_CELL_MIN));
    state.cellAuto = true;
    W.centreGrid();
    state.sampleDirty = true;
    W.draw();
    W.syncGridControls();
    W.requestPreview();
  };

  /* Sets the cell size by hand, keeping the middle of the grid where it
     was so the grid grows out of its centre rather than off its corner. */
  W.setGridCell = function setGridCell(pixels) {
    const next = Math.min(GRID_CELL_MAX, Math.max(GRID_CELL_MIN, Math.round(pixels)));
    if (next === state.cellPx) return;
    const grid = gridSize();
    const oldWidth = grid.width * state.cellPx;
    const oldHeight = grid.height * state.cellPx;
    const centreX = state.gridX + oldWidth / 2;
    const centreY = state.gridY + oldHeight / 2;

    state.cellPx = next;
    state.cellAuto = false;
    state.gridX = Math.round(centreX - (grid.width * next) / 2);
    state.gridY = Math.round(centreY - (grid.height * next) / 2);

    W.clampGrid();
    state.sampleDirty = true;
    W.draw();
    W.syncGridControls();
    W.requestPreview();
  };

  /* The grid's pan is clamped so that some of it always stays on screen —
     a grid that can be dragged entirely out of view is a grid you have
     lost. */
  W.clampGrid = function clampGrid() {
    const pane = el.source;
    if (!pane) return;
    const rect = gridRect();
    const visible = 24;
    state.gridX = Math.min(
      pane.clientWidth - visible,
      Math.max(visible - rect.width, state.gridX)
    );
    state.gridY = Math.min(
      pane.clientHeight - visible,
      Math.max(visible - rect.height, state.gridY)
    );
  };

  W.panGridBy = function panGridBy(dx, dy) {
    state.gridX += dx;
    state.gridY += dy;
    W.clampGrid();
    state.sampleDirty = true;
    W.draw();
    W.requestPreview();
  };

  /* Zooms the grid about a point on screen: the cell under the cursor
     stays under the cursor. */
  W.zoomGrid = function zoomGrid(factor, anchorX, anchorY) {
    const old = state.cellPx;
    const next = Math.min(
      GRID_CELL_MAX,
      Math.max(GRID_CELL_MIN, Math.round(old * factor))
    );
    if (next === old) return;

    const ax = anchorX === undefined ? 0 : anchorX;
    const ay = anchorY === undefined ? 0 : anchorY;
    const cellX = (ax - state.gridX) / old;
    const cellY = (ay - state.gridY) / old;

    state.cellPx = next;
    state.cellAuto = false;
    state.gridX = Math.round(ax - cellX * next);
    state.gridY = Math.round(ay - cellY * next);

    W.clampGrid();
    state.sampleDirty = true;
    W.draw();
    W.syncGridControls();
    W.requestPreview();
  };

  function geometry(cellPx, cellPxY) {
    return {
      originX: state.gridX,
      originY: state.gridY,
      cellPx,
      cellPxY: cellPxY === undefined ? cellPx : cellPxY,
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
    };
  }

  /* --- drawing the source pane ------------------------------------------------------ */

  W.draw = function draw() {
    const canvas = el.source;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const dpr = root.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#0d0d0f";
    context.fillRect(0, 0, width, height);

    const image = drawableSource();

    if (image) {
      context.imageSmoothingEnabled = false;
      context.drawImage(
        image,
        state.panX,
        state.panY,
        image.width * state.zoom,
        image.height * state.zoom
      );
    }

    const grid = gridSize();
    const rect = gridRect();
    const left = rect.x;
    const top = rect.y;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;

    /* The area outside the overlay is washed out, so the active region is
       unambiguous. The wash is drawn as four rectangles around the overlay
       rather than over the whole pane and then erased, because erasing would
       take the image with it. */
    context.fillStyle = "rgba(13,13,15,0.45)";
    context.fillRect(0, 0, width, Math.max(0, top));
    context.fillRect(0, bottom, width, Math.max(0, height - bottom));
    context.fillRect(0, top, Math.max(0, left), rect.height);
    context.fillRect(right, top, Math.max(0, width - right), rect.height);

    /* The grid overlay, in accent lines. */
    context.strokeStyle = "rgba(79,79,255,0.55)";
    context.lineWidth = 1;
    context.beginPath();
    for (let i = 1; i < grid.width; i += 1) {
      const x = Math.round(left + i * state.cellPx) + 0.5;
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    for (let i = 1; i < grid.height; i += 1) {
      const y = Math.round(top + i * state.cellPx) + 0.5;
      context.moveTo(left, y);
      context.lineTo(right, y);
    }
    context.stroke();

    context.strokeStyle = "rgba(79,79,255,0.9)";
    context.strokeRect(
      Math.round(left) + 0.5,
      Math.round(top) + 0.5,
      rect.width,
      rect.height
    );

    if (el.sourceEmpty) el.sourceEmpty.hidden = !!image;
    W.syncZoomControls();
    W.syncGridControls();
  };

  /* --- the zoom controls ---------------------------------------------------------- */

  /* The slider and the readout are two views of one number. Neither one
     writes to the state directly: the slider is the input, the state is the
     truth, and the readout is told what the truth is. */
  W.syncZoomControls = function syncZoomControls() {
    if (el.zoomReadout) {
      el.zoomReadout.textContent = Math.round(state.zoom * 100) / 100 + "×";
    }
    if (el.zoomSlider && document.activeElement !== el.zoomSlider) {
      el.zoomSlider.value = String(zoomToSlider(state.zoom));
    }
  };

  function zoomToSlider(zoom) {
    const value = Math.min(SOURCE_ZOOM_MAX, Math.max(SOURCE_ZOOM_MIN, zoom));
    const t =
      (Math.log(value) - Math.log(SOURCE_ZOOM_MIN)) /
      (Math.log(SOURCE_ZOOM_MAX) - Math.log(SOURCE_ZOOM_MIN));
    return Math.round(t * 100);
  }

  function sliderToZoom(value) {
    const t = Math.min(1, Math.max(0, value / 100));
    return Math.exp(
      Math.log(SOURCE_ZOOM_MIN) +
        t * (Math.log(SOURCE_ZOOM_MAX) - Math.log(SOURCE_ZOOM_MIN))
    );
  }

  /* The grid's zoom: the size of one cell on screen, from one pixel to
     sixty-four. The slider is logarithmic, because the interesting part of
     that range is at the small end — a cell of two pixels and a cell of
     thirty-two are not two steps apart. */
  W.syncGridControls = function syncGridControls() {
    if (el.gridReadout) {
      el.gridReadout.textContent = state.cellPx + "px";
    }
    if (el.gridSlider && document.activeElement !== el.gridSlider) {
      el.gridSlider.value = String(cellToSlider(state.cellPx));
    }
  };

  function cellToSlider(pixels) {
    const value = Math.min(GRID_CELL_MAX, Math.max(GRID_CELL_MIN, pixels));
    const t = Math.log(value) / Math.log(GRID_CELL_MAX);
    return Math.round(t * 100);
  }

  function sliderToCell(value) {
    const t = Math.min(1, Math.max(0, value / 100));
    const px = Math.exp(t * Math.log(GRID_CELL_MAX));
    return Math.min(GRID_CELL_MAX, Math.max(GRID_CELL_MIN, Math.round(px)));
  }

  /* --- sampling -------------------------------------------------------------------- */

  function imageFor(fast) {
    const source = VP.reference.state.source;
    if (!source) return null;
    return fast ? source.adjustedSmall : source.adjusted;
  }

  /* The drawable source: a canvas, because ImageData is not a drawImage
     source in every browser. */
  function drawableSource() {
    return VP.reference.sourceCanvas();
  }

  /* The sampled grid: the region under the overlay, sampled into cells. This
     is the single source of truth for the pipeline — the palette generator
     reads it and the matcher reads it, so the two can never drift apart. */
  W.sample = function sample(fast) {
    const image = imageFor(fast);
    if (!image) return null;

    const grid = gridSize();
    let width = grid.width;
    let height = grid.height;
    let cellPxX = state.cellPx;
    let cellPxY = state.cellPx;

    if (fast) {
      /* The reduced tier. Both axes are reduced together, and each sampled
         cell is told how many screen pixels it now stands for, so the
         reduced pass covers exactly the same region as the full one. */
      const longest = Math.max(width, height);
      if (longest > PREVIEW_MAX) {
        const factor = longest / PREVIEW_MAX;
        width = Math.max(1, Math.round(width / factor));
        height = Math.max(1, Math.round(height / factor));
        cellPxX = (grid.width * state.cellPx) / width;
        cellPxY = (grid.height * state.cellPx) / height;
      }
    }

    return Q.sampleGrid(
      image,
      width,
      height,
      geometry(cellPxX, cellPxY),
      state.sampleMethod
    );
  };

  function fullSample() {
    if (state.sampleDirty || !state.fullSample) {
      state.fullSample = W.sample(false);
      state.sampleDirty = false;
    }
    return state.fullSample;
  }

  W.invalidate = function invalidate() {
    state.sampleDirty = true;
  };

  /* --- the live preview ------------------------------------------------------------- */

  let fastHandle = null;
  let fullTimer = null;

  /* The live conversion goes onto the canvas, as a layer over the artwork.
     There is one art canvas in this app: the Image mode shows that same
     canvas beside the photo, with the conversion drawn over it. */
  function runPreview(fast) {
    const sample = fast ? W.sample(true) : fullSample();
    if (!sample) {
      VP.canvas.clearPreview();
      return;
    }
    const palette = VP.palette.colours();
    if (!palette.length) return;
    const result = Q.match(sample, Q.buildPaletteRgb(palette), state.matchMethod);
    VP.canvas.setPreview(result, sample.width, sample.height);
  }

  /* The settle: bake the current adjustment into the full-resolution copy,
     then render the full result.

     This has to bake the adjustment FIRST. The full-resolution pass reads
     the settled copy, and while a control is moving that copy is stale — so
     without this the preview would snap back to the previous value a
     fraction of a second after you stopped moving, and the page would look
     like it had not updated at all. */
  function settlePreview() {
    if (VP.reference.commitAdjust && VP.reference.commitAdjust()) {
      W.invalidate();
      /* The source pane is drawn from the full-resolution copy, so it has to
         be redrawn here. Without this the photo in the pane stays on the
         old value until something else redraws it — and the user has to
         nudge the image to make the page catch up. */
      W.draw();
    }
    runPreview(false);
  }

  /* While a control is moving: a reduced tier, drawn on the next frame.
     When it settles: the full-resolution result. */
  W.requestPreview = function requestPreview() {
    if (fastHandle === null) {
      fastHandle = root.requestAnimationFrame(() => {
        fastHandle = null;
        runPreview(true);
      });
    }
    if (fullTimer) clearTimeout(fullTimer);
    fullTimer = setTimeout(() => {
      fullTimer = null;
      settlePreview();
    }, 120);
  };

  /* The full result, as soon as the control settles. */
  W.commitPreview = function commitPreview() {
    if (fullTimer) clearTimeout(fullTimer);
    fullTimer = null;
    settlePreview();
  };

  /* --- the reset buttons --------------------------------------------------------- */

  /* Puts a reset button next to a slider.

     The reset target is the value the slider ships with — its `value`
     attribute — which is the same number as the algorithm's default, so the
     button and the algorithm can never disagree about what "normal" is. The
     button re-dispatches the slider's own events, so a reset travels the
     same path as the user moving the slider: the preview, the underlay and
     the readouts all update exactly as they do for a hand-made change. */
  W.attachReset = function attachReset(slider, name) {
    if (!slider) return null;
    if (slider.dataset.hasReset === "1") return null;
    slider.dataset.hasReset = "1";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-reset";
    button.textContent = "reset";
    button.title = "Reset " + name;
    button.setAttribute("aria-label", "Reset " + name);
    button.addEventListener("click", () => {
      slider.value = slider.defaultValue;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const block = slider.closest(".ws-slider");
    if (block) {
      /* The workspace sliders: the range and its reset sit on one line. */
      const row = document.createElement("div");
      row.className = "ws-slider-row";
      block.appendChild(row);
      row.appendChild(slider);
      row.appendChild(button);
    } else {
      /* The reference strip: the button goes beside the label, not inside
         it. A button inside a label forwards its click to the labelled
         control, which would make the slider jump. */
      const label = slider.closest("label");
      if (label) label.insertAdjacentElement("afterend", button);
      else slider.insertAdjacentElement("afterend", button);
    }
    return button;
  };

  /* Moves the tune sliders to match the state. The presets replace the whole
     transform, so without this the sliders would go on showing the old
     values — and the next move of any one of them would jump.

     A focused slider is updated too. The guard that used to skip it made
     the sliders disagree with the state whenever the slider that had moved
     was also the one the preset changed. */
  W.syncTuneSliders = function syncTuneSliders() {
    const tune = state.tune;
    const set = (id, value) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.value = String(Math.round(value));
    };
    set("ws-tune-saturation", tune.saturation);
    set("ws-tune-brightness", tune.brightness);
    set("ws-tune-contrast", tune.contrast);
    set("ws-tune-hue", tune.hue);
    set("ws-tune-posterise", tune.posterise);
  };

  /* --- the palette block -------------------------------------------------------------- */

  W.extract = function extract() {
    const sample = fullSample();
    if (!sample) {
      W.setStatus("load an image first");
      return null;
    }
    const pixels = Q.sampleToPixels(sample);
    if (!pixels.length) {
      W.setStatus("nothing to extract from");
      return null;
    }

    const colours = Q.generatePalette(pixels, state.extractCount);
    VP.palette.stage(colours);

    if (el.paletteStatus) {
      el.paletteStatus.textContent =
        colours.length < state.extractCount
          ? colours.length + " colours — the image has little variety"
          : colours.length + " colours";
    }
    if (el.tune) el.tune.hidden = false;
    if (el.targets) el.targets.hidden = false;
    W.updateTuneStatus();
    W.requestPreview();
    return colours;
  };

  function tunePalette(transform) {
    state.tune = Object.assign({}, state.tune, transform);
    if (VP.palette.hasStaged()) {
      VP.palette.transformStaged(state.tune);
    }
    W.updateTuneStatus();
    W.requestPreview();
  }

  W.updateTuneStatus = function updateTuneStatus() {
    const status = document.getElementById("ws-tune-status");
    if (!status) return;
    if (!VP.palette.hasStaged()) {
      status.textContent = "";
      return;
    }
    const merged = VP.palette.stagedMerged;
    const before = VP.palette.stagedBefore;
    status.textContent = merged
      ? before + " colours → " + VP.palette.colours().length + " (" + merged + " merged)"
      : VP.palette.colours().length + " colours";
  };

  W.tune = tunePalette;

  W.applyPreset = function applyPreset(name) {
    if (name === "normalise") {
      if (!VP.palette.hasStaged()) return;
      const normalised = Q.normaliseLuminance(VP.palette.colours());
      VP.palette.stage(normalised);
      W.updateTuneStatus();
      W.requestPreview();
      return;
    }
    const preset = Q.TRANSFORM_PRESETS[name];
    if (!preset) return;
    state.tune = Object.assign(Q.defaultTransform(), preset);
    /* The sliders have to follow, or they would go on showing the old
       values while the state had already moved on. */
    W.syncTuneSliders();
    tunePalette(state.tune);
  };

  /* --- the conversion ------------------------------------------------------------------ */

  W.convert = function convert() {
    const sample = fullSample();
    if (!sample) {
      W.setStatus("load an image first");
      return false;
    }
    const palette = VP.palette.colours();
    if (!palette.length) return false;

    const result = Q.match(sample, Q.buildPaletteRgb(palette), state.matchMethod);

    if (W.onConvert) W.onConvert(result, sample.width, sample.height);
    W.setStatus("converted " + sample.width + "×" + sample.height);
    return true;
  };

  /* --- framing --------------------------------------------------------------------------- */

  W.fitSource = function fitSource() {
    const image = drawableSource();
    if (!image) return;
    const rect = gridRect();
    const zoom = Math.min(rect.width / image.width, rect.height / image.height);
    state.zoom = Math.max(SOURCE_ZOOM_MIN, Math.min(SOURCE_ZOOM_MAX, zoom));
    state.panX = rect.x + rect.width / 2 - (image.width * state.zoom) / 2;
    state.panY = rect.y + rect.height / 2 - (image.height * state.zoom) / 2;
    state.sampleDirty = true;
    W.draw();
  };

  /* Re-centres the photo on the grid without changing its zoom. The grid
     has just changed shape — the canvas was resized — and the photo should
     stay over the middle of it. */
  W.recentreSource = function recentreSource() {
    const image = drawableSource();
    if (!image) return;
    const rect = gridRect();
    state.panX = rect.x + rect.width / 2 - (image.width * state.zoom) / 2;
    state.panY = rect.y + rect.height / 2 - (image.height * state.zoom) / 2;
    state.sampleDirty = true;
    W.draw();
  };

  W.pixelSource = function pixelSource() {
    const image = drawableSource();
    if (!image) return;
    state.zoom = state.cellPx;
    /* Snap the pan so the source's pixels land on the cells' boundaries. */
    state.panX =
      state.gridX - Math.round((state.gridX - state.panX) / state.zoom) * state.zoom;
    state.panY =
      state.gridY - Math.round((state.gridY - state.panY) / state.zoom) * state.zoom;
    state.sampleDirty = true;
    W.draw();
  };

  W.zoomBy = function zoomBy(factor, anchorX, anchorY) {
    const image = drawableSource();
    if (!image) return;
    const oldZoom = state.zoom;
    const next = Math.max(SOURCE_ZOOM_MIN, Math.min(SOURCE_ZOOM_MAX, oldZoom * factor));
    if (next === oldZoom) return;

    /* Anchor the zoom at the pointer: the source pixel under the cursor stays
       under the cursor. */
    const ax = anchorX === undefined ? OVERLAY_INSET : anchorX;
    const ay = anchorY === undefined ? OVERLAY_INSET : anchorY;
    const sourceX = (ax - state.panX) / oldZoom;
    const sourceY = (ay - state.panY) / oldZoom;

    state.zoom = next;
    state.panX = ax - sourceX * next;
    state.panY = ay - sourceY * next;

    W.clampPan();
    state.sampleDirty = true;
    W.draw();
    W.requestPreview();
  };

  /* Panning is clamped so the image cannot be dragged entirely off-screen. */
  W.clampPan = function clampPan() {
    const image = drawableSource();
    if (!image || !el.source) return;
    const width = el.source.clientWidth;
    const height = el.source.clientHeight;
    const drawnWidth = image.width * state.zoom;
    const drawnHeight = image.height * state.zoom;
    const marginX = width * 0.1;
    const marginY = height * 0.1;

    const minX = marginX - drawnWidth;
    const maxX = width - marginX;
    const minY = marginY - drawnHeight;
    const maxY = height - marginY;

    state.panX = Math.min(maxX, Math.max(minX, state.panX));
    state.panY = Math.min(maxY, Math.max(minY, state.panY));
  };

  W.panBy = function panBy(dx, dy) {
    state.panX += dx;
    state.panY += dy;
    W.clampPan();
    state.sampleDirty = true;
    W.draw();
    W.requestPreview();
  };

  /* --- status ----------------------------------------------------------------------------- */

  W.setStatus = function setStatus(text) {
    if (el.status) el.status.textContent = text || "";
  };

  /* --- refresh ----------------------------------------------------------------------------- */

  /* Redraws everything the workspace owns. */
  W.refresh = function refresh() {
    W.draw();
    W.updateLoadNote();
    W.updateTargetSize();
    if (!VP.reference.hasImage()) {
      VP.canvas.clearPreview();
      if (el.paletteStatus) el.paletteStatus.textContent = "";
      return;
    }
    W.requestPreview();
  };

  W.updateTargetSize = function updateTargetSize() {
    const grid = gridSize();
    const text = grid.width + " × " + grid.height;
    if (el.targetSize) el.targetSize.textContent = text;
    if (el.convertSummary) el.convertSummary.textContent = text;
  };

  W.updateLoadNote = function updateLoadNote() {
    if (!el.loadNote) return;
    const source = VP.reference.state.source;
    if (!source) {
      el.loadNote.textContent = VP.reference.LIMIT_TEXT;
      el.loadNote.hidden = false;
      return;
    }
    el.loadNote.textContent =
      source.name + " · " + source.width + "×" + source.height + " · " + VP.reference.LIMIT_TEXT;
    el.loadNote.hidden = false;
  };

  /* --- wiring -------------------------------------------------------------------------------- */

  W.init = function init() {
    grab();
    /* The pane has to be sized to its container before the grid is fitted
       to it — the cell size is derived from the pane's dimensions, and the
       pane's dimensions come from the canvas being sized to it. */
    W.resizeCanvases();
    W.updateCellSize();
    bindSourcePane();
    bindControls();
    W.fitSource();
    W.refresh();
  };

  /* The workspace is not a mode: it is the app. This stays here so the rest
     of the code can ask the question without caring about the answer. */
  W.isOpen = function isOpen() {
    return true;
  };

  function bindSourcePane() {
    const canvas = el.source;
    if (!canvas) return;

    let dragging = false;
    let draggingGrid = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      dragging = true;
      /* Shift moves the grid instead of the photo. Which one a drag moves
         is decided when the drag starts, so it cannot change halfway
         through. */
      draggingGrid = event.shiftKey;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.classList.add(draggingGrid ? "is-grid-panning" : "is-panning");
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (draggingGrid) W.panGridBy(dx, dy);
      else W.panBy(dx, dy);
    });

    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      canvas.classList.remove("is-panning");
      canvas.classList.remove("is-grid-panning");
    };

    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        /* Shift zooms the grid; without it the wheel zooms the photo. */
        if (event.shiftKey) {
          W.zoomGrid(factor, event.clientX - rect.left, event.clientY - rect.top);
          return;
        }
        W.zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false }
    );

    /* The source's own zoom slider. It moves the photo and nothing else —
       the canvas keeps the zoom it had. */
    if (el.zoomSlider) {
      el.zoomSlider.addEventListener("input", () => {
        const image = drawableSource();
        if (!image) return;
        const oldZoom = state.zoom;
        const next = sliderToZoom(parseFloat(el.zoomSlider.value));
        if (next === oldZoom) return;

        /* Keep the middle of the grid where it was, so the slider zooms
           the photo rather than sliding it away. */
        const rect = gridRect();
        const centreX = rect.x + rect.width / 2;
        const centreY = rect.y + rect.height / 2;
        const sourceX = (centreX - state.panX) / oldZoom;
        const sourceY = (centreY - state.panY) / oldZoom;

        state.zoom = next;
        state.panX = centreX - sourceX * next;
        state.panY = centreY - sourceY * next;

        W.clampPan();
        state.sampleDirty = true;
        W.draw();
        W.requestPreview();
      });
    }

    /* The grid's own zoom slider. It moves the grid and nothing else —
       the photo keeps the zoom and the pan it had. */
    if (el.gridSlider) {
      el.gridSlider.addEventListener("input", () => {
        W.setGridCell(sliderToCell(parseFloat(el.gridSlider.value)));
      });
    }

    const gridFit = document.getElementById("grid-fit");
    if (gridFit) {
      gridFit.addEventListener("click", () => W.fitGrid());
    }
  }

  function bindControls() {
    const on = (id, event, handler) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener(event, handler);
    };

    on("ws-fit", "click", () => {
      W.fitSource();
      W.requestPreview();
    });
    on("ws-pixel", "click", () => {
      W.pixelSource();
      W.requestPreview();
    });

    /* Source adjustments. */
    const adjustment = (id, key, parse) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.addEventListener("input", () => {
        const value = parse(node.value);
        VP.reference.setAdjust({ [key]: value }, true);
        W.updateAdjustReadouts();
        W.invalidate();
        W.requestPreview();
      });
      node.addEventListener("change", () => {
        const value = parse(node.value);
        VP.reference.setAdjust({ [key]: value }, false);
        W.updateAdjustReadouts();
        W.invalidate();
        W.commitPreview();
      });
    };

    adjustment("ws-black", "black", (v) => parseFloat(v) / 100);
    adjustment("ws-white", "white", (v) => parseFloat(v) / 100);
    adjustment("ws-brightness", "brightness", (v) => parseFloat(v) / 100);
    adjustment("ws-contrast", "contrast", (v) => parseFloat(v) / 100);
    adjustment("ws-saturation", "saturation", (v) => parseFloat(v) / 100);
    adjustment("ws-hue", "hue", (v) => parseFloat(v));

    W.attachReset(document.getElementById("ws-black"), "the black point");
    W.attachReset(document.getElementById("ws-white"), "the white point");
    W.attachReset(document.getElementById("ws-brightness"), "brightness");
    W.attachReset(document.getElementById("ws-contrast"), "contrast");
    W.attachReset(document.getElementById("ws-saturation"), "saturation");
    W.attachReset(document.getElementById("ws-hue"), "the hue shift");

    on("ws-grey", "change", (event) => {
      VP.reference.setAdjust({ grey: event.target.checked }, false);
      W.invalidate();
      W.commitPreview();
    });

    on("ws-auto-levels", "click", () => {
      const levels = VP.reference.autoLevels();
      if (!levels) return;
      W.updateAdjustReadouts();
      W.invalidate();
      W.commitPreview();
    });

    on("ws-reset-adjust", "click", () => {
      VP.reference.resetAdjust();
      W.updateAdjustReadouts();
      W.invalidate();
      W.commitPreview();
    });

    /* The palette block. */
    on("ws-extract", "click", () => W.extract());

    for (const count of [16, 32, 64]) {
      on("ws-count-" + count, "click", () => {
        state.extractCount = count;
        for (const other of [16, 32, 64]) {
          const node = document.getElementById("ws-count-" + other);
          if (node) node.classList.toggle("is-active", other === count);
        }
      });
    }

    const tune = (id, key, parse) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.addEventListener("input", () => {
        tunePalette({ [key]: parse(node.value) });
      });
      node.addEventListener("change", () => {
        tunePalette({ [key]: parse(node.value) });
        W.commitPreview();
      });
    };

    tune("ws-tune-saturation", "saturation", (v) => parseFloat(v));
    tune("ws-tune-brightness", "brightness", (v) => parseFloat(v));
    tune("ws-tune-contrast", "contrast", (v) => parseFloat(v));
    tune("ws-tune-hue", "hue", (v) => parseFloat(v));
    tune("ws-tune-posterise", "posterise", (v) => parseFloat(v));

    W.attachReset(document.getElementById("ws-tune-saturation"), "palette saturation");
    W.attachReset(document.getElementById("ws-tune-brightness"), "palette brightness");
    W.attachReset(document.getElementById("ws-tune-contrast"), "palette contrast");
    W.attachReset(document.getElementById("ws-tune-hue"), "the palette hue shift");
    W.attachReset(document.getElementById("ws-tune-posterise"), "posterise");

    on("ws-preset-pop", "click", () => {
      W.applyPreset("sprite pop");
      W.commitPreview();
    });
    on("ws-preset-muted", "click", () => {
      W.applyPreset("muted");
      W.commitPreview();
    });
    on("ws-preset-deep", "click", () => {
      W.applyPreset("deep");
      W.commitPreview();
    });
    on("ws-preset-pastel", "click", () => {
      W.applyPreset("pastel");
      W.commitPreview();
    });
    on("ws-preset-normalise", "click", () => {
      W.applyPreset("normalise");
      W.commitPreview();
    });

    on("ws-target-replace", "click", () => {
      VP.palette.commitStaged("replace");
      W.finishStaging();
    });
    on("ws-target-append", "click", () => {
      VP.palette.commitStaged("append");
      W.finishStaging();
    });
    on("ws-target-new", "click", () => {
      const nameInput = document.getElementById("ws-target-name");
      const name = nameInput ? nameInput.value.trim() : "";
      VP.palette.commitStaged("new", name || "From image");
      W.finishStaging();
    });
    on("ws-stage-cancel", "click", () => {
      VP.palette.unstage();
      W.finishStaging();
    });

    /* The convert block. */
    on("ws-sample-average", "click", () => {
      state.sampleMethod = "average";
      W.markGroup("ws-sample", "average");
      W.invalidate();
      W.commitPreview();
    });
    on("ws-sample-nearest", "click", () => {
      state.sampleMethod = "nearest";
      W.markGroup("ws-sample", "nearest");
      W.invalidate();
      W.commitPreview();
    });

    for (const method of ["flat", "bayer", "floyd", "clustered"]) {
      on("ws-match-" + method, "click", () => {
        state.matchMethod = method;
        W.markGroup("ws-match", method);
        W.commitPreview();
      });
    }

    on("ws-convert", "click", () => W.convert());
  }

  /* Marks the active button in a group of size buttons. */
  W.markGroup = function markGroup(prefix, value) {
    for (const node of document.querySelectorAll("[data-group='" + prefix + "']")) {
      node.classList.toggle("is-active", node.dataset.value === value);
    }
  };

  W.finishStaging = function finishStaging() {
    if (el.tune) el.tune.hidden = true;
    if (el.targets) el.targets.hidden = true;
    if (el.paletteStatus) el.paletteStatus.textContent = "";
    W.updateTuneStatus();
    W.requestPreview();
  };

  W.updateAdjustReadouts = function updateAdjustReadouts() {
    const adjust = VP.reference.state.adjust;
    const set = (id, value) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.value = String(value);
    };
    set("ws-black", Math.round(adjust.black * 100));
    set("ws-white", Math.round(adjust.white * 100));
    set("ws-brightness", Math.round(adjust.brightness * 100));
    set("ws-contrast", Math.round(adjust.contrast * 100));
    set("ws-saturation", Math.round(adjust.saturation * 100));
    set("ws-hue", Math.round(adjust.hue));
    const grey = document.getElementById("ws-grey");
    if (grey) grey.checked = !!adjust.grey;
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
