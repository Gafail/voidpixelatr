/* ==========================================================================
   VoidPixelatr — canvas.js
   --------------------------------------------------------------------------
   The rendering architecture: a layered buffer model rather than thousands of
   DOM nodes.

       artBuffer     offscreen canvas, width x height, 1 art pixel = 1 buffer pixel
       previewBuffer offscreen canvas, width x height, the live conversion
       display       the <canvas> the user sees, size * scale, DPR-aware

   A frame is composited in three steps: the art, the live conversion (over
   the art), the grid lines — a few drawImage calls and a few hundred line
   strokes, which is sub-millisecond at any size including 256x256.

   The canvas is not square. It has a width and a height, and every buffer,
   every grid index and every export follows both of them.

   There is no pointer handling here. This is a pipeline: the artwork is
   converted, not drawn. The only thing that writes into the grid is the
   converter, and the only thing that reads it is the exporter.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const C = (VP.canvas = {});

  const state = {
    width: 16,
    height: 16,
    grid: new Int8Array(16 * 16).fill(-1),
    scale: 16,
    gridVisible: true,
    artBuffer: null,
    artContext: null,
    previewBuffer: null,
    previewContext: null,
    display: null,
    context: null,
  };

  C.state = state;

  /* The grid is the canvas's state, but the rest of the app reaches for it
     as `VP.canvas.grid`. This keeps that spelling honest and live. */
  Object.defineProperty(C, "grid", {
    get: function () {
      return state.grid;
    },
    set: function (value) {
      state.grid = value;
    },
    enumerable: true,
  });

  function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /* --- setup --------------------------------------------------------------- */

  C.init = function init(displayElement) {
    state.display = displayElement;
    state.context = displayElement.getContext("2d");
    state.artBuffer = makeCanvas(state.width, state.height);
    state.artContext = state.artBuffer.getContext("2d");
    state.previewBuffer = makeCanvas(state.width, state.height);
    state.previewContext = state.previewBuffer.getContext("2d");
    C.rebuildArt();
    C.resizeDisplay();
  };

  /* --- the grid ------------------------------------------------------------ */

  C.setGrid = function setGrid(grid) {
    state.grid = grid;
    C.rebuildArt();
    C.composite();
  };

  C.clearGrid = function clearGrid() {
    state.grid = new Int8Array(state.width * state.height).fill(-1);
    C.rebuildArt();
    C.composite();
  };

  /* Resizes the canvas, keeping the art centre-anchored: the old grid is
     centred in the new one, cells outside are cropped, new cells are empty. */
  C.resize = function resize(newWidth, newHeight) {
    const oldWidth = state.width;
    const oldHeight = state.height;
    const oldGrid = state.grid;
    const grid = new Int8Array(newWidth * newHeight).fill(-1);
    const offsetX = Math.floor((newWidth - oldWidth) / 2);
    const offsetY = Math.floor((newHeight - oldHeight) / 2);

    for (let row = 0; row < oldHeight; row += 1) {
      const targetRow = row + offsetY;
      if (targetRow < 0 || targetRow >= newHeight) continue;
      for (let col = 0; col < oldWidth; col += 1) {
        const targetCol = col + offsetX;
        if (targetCol < 0 || targetCol >= newWidth) continue;
        grid[targetRow * newWidth + targetCol] = oldGrid[row * oldWidth + col];
      }
    }

    state.width = newWidth;
    state.height = newHeight;
    state.grid = grid;

    state.artBuffer = makeCanvas(newWidth, newHeight);
    state.artContext = state.artBuffer.getContext("2d");
    state.previewBuffer = makeCanvas(newWidth, newHeight);
    state.previewContext = state.previewBuffer.getContext("2d");

    C.rebuildArt();
    C.resizeDisplay();
    C.composite();
  };

  /* --- the art buffer -------------------------------------------------------- */

  /* Paints a grid into a buffer: one cell per grid index, the row stride is
     the grid's width. */
  function paintGridInto(context, grid, width, height, palette) {
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;

    for (let i = 0; i < grid.length; i += 1) {
      const index = grid[i];
      if (index < 0) continue;
      const hex = palette[index];
      if (!hex) continue;
      context.fillStyle = hex;
      context.fillRect(i % width, Math.floor(i / width), 1, 1);
    }
  }

  /* Repaints the whole art buffer from the grid. One pass, O(n); it happens
     on discrete events only, never per pointer move. */
  C.rebuildArt = function rebuildArt() {
    const context = state.artContext;
    if (!context) return;
    paintGridInto(
      context,
      state.grid,
      state.width,
      state.height,
      VP.palette.colours()
    );
  };

  /* --- the live conversion preview ----------------------------------------- */

  /* The workspace's live conversion, drawn over the art in the same canvas.
     It is a layer, not a second canvas: the app has one art canvas, and the
     source pane sits beside it.

     The layer may be smaller than the canvas — the reduced-quality tier
     samples fewer cells — and the composite stretches it back up, so the
     draft reads as blocks until the full pass lands. */
  C.setPreview = function setPreview(grid, gridWidth, gridHeight) {
    if (!state.previewContext) return;
    if (!grid) {
      C.clearPreview();
      return;
    }
    const width = gridWidth || state.width;
    const height = gridHeight || state.height;
    if (
      state.previewBuffer.width !== width ||
      state.previewBuffer.height !== height
    ) {
      state.previewBuffer = makeCanvas(width, height);
      state.previewContext = state.previewBuffer.getContext("2d");
    }
    paintGridInto(
      state.previewContext,
      grid,
      width,
      height,
      VP.palette.colours()
    );
    C.composite();
  };

  C.clearPreview = function clearPreview() {
    if (!state.previewContext) return;
    state.previewContext.clearRect(0, 0, state.width, state.height);
    C.composite();
  };

  C.hasPreview = function hasPreview() {
    return !!state.previewContext;
  };

  /* --- the display ---------------------------------------------------------- */

  /* The display canvas is capped at 4096 device pixels a side, for the same
     reason the export is: a 256x256 canvas at 16x on a HiDPI screen would
     ask for an 8192x8192 backing store, which is 268 MB and will fail on
     modest hardware. Past the cap the canvas is shown scaled down by the
     browser rather than being allowed to take the machine down. */
  const MAX_DISPLAY = 4096;

  C.resizeDisplay = function resizeDisplay() {
    const display = state.display;
    if (!display) return;
    const cssWidth = state.width * state.scale;
    const cssHeight = state.height * state.scale;
    const dpr = root.devicePixelRatio || 1;
    /* One ratio for both axes, so the art never comes out stretched. The
       cap is on the larger axis, which is the one that would blow the
       backing store up. */
    const ratio = Math.min(
      dpr,
      MAX_DISPLAY / cssWidth,
      MAX_DISPLAY / cssHeight
    );
    const backing = Math.max(1, Math.round(cssWidth * ratio));

    display.style.width = cssWidth + "px";
    display.style.height = cssHeight + "px";
    display.width = backing;
    display.height = Math.max(1, Math.round(cssHeight * ratio));

    /* Device pixels per CSS pixel. Normally the device pixel ratio; lower
       when the cap has been hit. */
    state.ratio = backing / cssWidth;

    C.composite();
  };

  C.setScale = function setScale(scale) {
    state.scale = clampScale(scale);
    C.resizeDisplay();
    /* The readout and the slider are two views of this number, and they
       must not be able to drift from it: the scale is also set by a resize
       and by a layout change, neither of which goes through the app's own
       zoom control. */
    if (C.hooks.scale) C.hooks.scale();
  };

  /* The app fills this in: it tells the canvas's own controls what the
     scale is now. */
  C.hooks = { scale: null };

  /* The zoom steps. The scale is always one of these, so the readout, the
     zoom buttons and what is actually on screen always agree. */
  const SCALES = [1, 2, 4, 8, 16, 32, 64];
  C.SCALES = SCALES;

  /* The smallest and largest zoom the canvas takes. */
  const MIN_SCALE = 1;
  const MAX_SCALE = 64;

  function clampScale(scale) {
    const value = Math.round(Number(scale));
    if (!Number.isFinite(value)) return 16;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  /* The zoom slider is logarithmic: the top of the range is where the
     detail is, and a linear slider would spend most of its travel on the
     two or three zoom levels nobody uses. Each step of the ladder is the
     same distance on the slider. */
  C.scaleFromSlider = function scaleFromSlider(value) {
    const t = Math.min(1, Math.max(0, value / 100));
    return clampScale(
      Math.exp(Math.log(MIN_SCALE) + t * (Math.log(MAX_SCALE) - Math.log(MIN_SCALE)))
    );
  };

  C.sliderFromScale = function sliderFromScale(scale) {
    const value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const t =
      (Math.log(value) - Math.log(MIN_SCALE)) /
      (Math.log(MAX_SCALE) - Math.log(MIN_SCALE));
    return Math.round(t * 100);
  };

  /* The room the canvas has to sit in. The region is the pane it lives in. */
  function availableSpace() {
    const region = document.getElementById("canvas-region");
    if (!region) return { width: 640, height: 640 };
    return {
      width: Math.max(32, region.clientWidth - 32),
      height: Math.max(32, region.clientHeight - 32),
    };
  }

  /* The largest step at which the whole canvas still fits the pane. */
  C.fitScale = function fitScale() {
    const room = availableSpace();
    for (let i = SCALES.length - 1; i >= 0; i -= 1) {
      if (
        SCALES[i] * state.width <= room.width &&
        SCALES[i] * state.height <= room.height
      ) {
        return SCALES[i];
      }
    }
    return SCALES[0];
  };

  /* The scale to use after the canvas size changes: the current one if the
     canvas still fits, otherwise the largest that does.
     Without this, a 256x256 canvas kept the 16x it inherited from a 32x32
     one — a canvas 4096 CSS pixels across, three times the width of the
     pane it was supposed to sit in. */
  C.scaleForSize = function scaleForSize() {
    const room = availableSpace();
    if (
      state.scale * state.width <= room.width &&
      state.scale * state.height <= room.height
    ) {
      return state.scale;
    }
    return C.fitScale();
  };

  C.setGridVisible = function setGridVisible(visible) {
    state.gridVisible = visible;
    C.composite();
  };

  /* Composites the frame: the art, the live conversion (over the art), and
     the grid lines last, so they stay legible over everything. */
  C.composite = function composite() {
    const context = state.context;
    if (!context) return;

    const width = state.width;
    const height = state.height;
    const cssWidth = width * state.scale;
    const cssHeight = height * state.scale;
    const ratio = state.ratio || root.devicePixelRatio || 1;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, cssWidth, cssHeight);

    /* The empty-cell colour, so the grid is always legible. */
    context.fillStyle = "#1a1a1f";
    context.fillRect(0, 0, cssWidth, cssHeight);

    context.drawImage(state.artBuffer, 0, 0, cssWidth, cssHeight);

    /* The live conversion, over the art. It is a layer of this canvas, not
       a second canvas: the source pane sits beside this one. */
    if (state.previewBuffer) {
      context.drawImage(state.previewBuffer, 0, 0, cssWidth, cssHeight);
    }

    if (state.gridVisible && state.scale >= 8) {
      context.strokeStyle = "rgba(255,255,255,0.08)";
      context.lineWidth = 1;
      context.beginPath();
      for (let i = 1; i < width; i += 1) {
        const x = Math.round(i * state.scale) + 0.5;
        context.moveTo(x, 0);
        context.lineTo(x, cssHeight);
      }
      for (let i = 1; i < height; i += 1) {
        const y = Math.round(i * state.scale) + 0.5;
        context.moveTo(0, y);
        context.lineTo(cssWidth, y);
      }
      context.stroke();
    }

    context.globalAlpha = 1;
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
