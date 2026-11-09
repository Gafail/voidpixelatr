/* ==========================================================================
   VoidPixelatr — app.js
   --------------------------------------------------------------------------
   The bootstrap: wiring, keyboard, drag and drop, paste, the inline panels,
   and the autosave.

   This is a pipeline, not a canvas. There is no brush, no eraser, no
   symmetry and no undo stack — the artwork is converted from a photograph,
   and the way to change it is to change a setting and convert again.

   Nothing here talks to a server. There is no fetch, no XHR, no beacon and
   no form submission anywhere in this application — the only network traffic
   is the browser fetching the app's own static files.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP;
  const Q = VP.quantise;
  const APP = (VP.app = {});

  const state = {
    autosaveTimer: null,
    exportScale: 16,
    exportBackground: null,
    importMode: "adopt",
    pendingResize: null,
    /* Whether X and Y are tied together. Locked, they always match and the
       canvas is square; unlocked, they are two independent edges and the
       canvas can be a rectangle. */
    sizeLocked: true,
    prefs: {
      scale: 16,
      fitZoom: false,
      gridVisible: true,
      activePalette: "Void Palette",
      activeIndex: 0,
      srcPanX: 0,
      srcPanY: 0,
      srcZoom: 0,
      sizeLocked: true,
    },
  };

  APP.state = state;

  const $ = (id) => document.getElementById(id);

  /* --- small helpers --------------------------------------------------------- */

  function hasArt() {
    const grid = VP.canvas.grid;
    for (let i = 0; i < grid.length; i += 1) {
      if (grid[i] !== -1) return true;
    }
    return false;
  }

  function currentPrefs() {
    const prefs = state.prefs;
    prefs.scale = VP.canvas.state.scale;
    prefs.gridVisible = VP.canvas.state.gridVisible;
    prefs.activePalette = VP.palette.state.activeName;
    prefs.activeIndex = VP.palette.state.activeIndex;
    prefs.srcPanX = VP.workspace.state.panX;
    prefs.srcPanY = VP.workspace.state.panY;
    prefs.srcZoom = VP.workspace.state.zoom;
    prefs.sizeLocked = state.sizeLocked;
    return prefs;
  }

  function saveNow() {
    try {
      VP.storage.saveCanvas(
        VP.canvas.state.width,
        VP.canvas.state.height,
        VP.palette.colours(),
        VP.canvas.grid
      );
      VP.storage.savePalettes(VP.palette.userPalettes());
      VP.storage.savePrefs(currentPrefs());
    } catch (error) {
      /* Persistence is a convenience, never a dependency. */
    }
  }

  function autosave() {
    if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      state.autosaveTimer = null;
      saveNow();
    }, 800);
  }

  APP.autosave = autosave;

  /* The canvas changed size around it: the window can do that, and so can
     the source pane. The zoom follows the room, unless the user has pinned
     it themselves. */
  APP.onLayoutChange = function onLayoutChange() {
    if (state.prefs.fitZoom) {
      VP.canvas.setScale(VP.canvas.fitScale());
    } else {
      VP.canvas.setScale(VP.canvas.scaleForSize());
    }
  };

  function flash(node, text, ms) {
    if (!node) return;
    const original = node.dataset.label || node.textContent;
    node.dataset.label = original;
    node.textContent = text;
    if (node._flashTimer) clearTimeout(node._flashTimer);
    node._flashTimer = setTimeout(() => {
      node.textContent = node.dataset.label;
      node._flashTimer = null;
    }, ms || 1500);
  }

  /* Two-step inline confirmation: the label changes, and a second click
     does the thing. No native confirm().

     It stays armed until the user clicks again, clicks somewhere else, or
     presses Escape. It does NOT expire on a timer. The expiry made "New" a
     trap: click it, read the label, look away for a moment, click again —
     and the second click armed it a second time instead of confirming it,
     so the canvas never cleared and the button looked simply broken. */
  const ARMED = [];

  function disarmConfirm(node) {
    if (!node) return;
    node.dataset.armed = "0";
    node.textContent = node.dataset.label || node.textContent;
    const index = ARMED.indexOf(node);
    if (index >= 0) ARMED.splice(index, 1);
  }

  function armConfirm(node, onConfirm) {
    if (!node) return;
    if (node.dataset.armed === "1") {
      disarmConfirm(node);
      onConfirm();
      return;
    }
    node.dataset.armed = "1";
    node.dataset.label = node.textContent;
    node.textContent = "Sure?";
    if (ARMED.indexOf(node) < 0) ARMED.push(node);
  }

  /* A click anywhere else cancels an armed confirmation. Registered once. */
  function watchConfirmations() {
    document.addEventListener("click", (event) => {
      if (!ARMED.length) return;
      for (const node of ARMED.slice()) {
        if (node.contains(event.target)) continue;
        disarmConfirm(node);
      }
    });
  }

  /* --- rendering ---------------------------------------------------------------- */

  function renderAll() {
    VP.palette.render();
    renderTopBar();
    renderBottomBar();
    /* A palette change has to reach the live preview as well — the swatch
       grid is only half of it. Without this, switching the palette in the
       menu left the preview showing the previous palette's result. */
    VP.workspace.refresh();
  }

  function renderTopBar() {
    syncSizeControls();
    syncCanvasZoom();

    const gridToggle = $("grid-toggle");
    if (gridToggle) {
      gridToggle.classList.toggle("is-active", VP.canvas.state.gridVisible);
      /* The button says whether the grid is on. It used to read "G" and
         rely on its highlight alone to say so. */
      gridToggle.textContent = VP.canvas.state.gridVisible ? "on" : "off";
    }

  }

  /* The canvas's zoom slider and its readout. One value, two controls: the
     slider is an input, the state is the truth, and the readout is told
     what the truth is. */
  function syncCanvasZoom() {
    const slider = $("canvas-zoom");
    if (slider && document.activeElement !== slider) {
      slider.value = String(VP.canvas.sliderFromScale(VP.canvas.state.scale));
    }
    const readout = $("canvas-zoom-readout");
    if (readout) {
      readout.textContent =
        state.prefs.fitZoom && VP.canvas.state.scale === VP.canvas.fitScale()
          ? "fit · " + VP.canvas.state.scale + "×"
          : VP.canvas.state.scale + "×";
    }
  }

  /* The X and Y dropdowns, and the lock between them.

     They show the size the canvas is — or the size it is about to become,
     when a resize is waiting for confirmation. The lock button says whether
     the two are tied together. */
  function syncSizeControls() {
    const pending = state.pendingResize;
    const width = pending ? pending.width : VP.canvas.state.width;
    const height = pending ? pending.height : VP.canvas.state.height;

    const x = $("size-x");
    if (x && x.value !== String(width)) x.value = String(width);
    const y = $("size-y");
    if (y && y.value !== String(height)) y.value = String(height);

    const lock = $("size-lock");
    if (lock) {
      lock.textContent = state.sizeLocked ? "linked" : "separate";
      lock.classList.toggle("is-active", state.sizeLocked);
      lock.setAttribute("aria-pressed", state.sizeLocked ? "true" : "false");
      lock.title = state.sizeLocked
        ? "X and Y are tied together — the canvas is square. Click to set them separately."
        : "X and Y are separate — the canvas can be a rectangle. Click to tie them together.";
    }
  }

  function renderBottomBar() {
    const copy = $("copy-png");
    if (copy && !copy.dataset.armed && !copy._flashTimer) {
      copy.textContent = VP.io.canCopy() ? "Copy PNG" : "Copy PNG (downloads)";
    }
  }

  /* --- the top bar -------------------------------------------------------------- */

  /* The size controls. X and Y are dropdowns, never free text: the canvas
     is either one of the allowed sizes or it is not a canvas this app
     draws. */
  function fillSizes(node) {
    if (!node || node.options.length) return;
    for (const value of Q.ALLOWED_SIZES) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      node.appendChild(option);
    }
  }

  function requestResize(width, height) {
    if (
      width === VP.canvas.state.width &&
      height === VP.canvas.state.height
    ) {
      /* Back to where it started: there is nothing to confirm. */
      state.pendingResize = null;
      const panel = $("resize-panel");
      if (panel) panel.hidden = true;
      syncSizeControls();
      return;
    }

    if (hasArt()) {
      state.pendingResize = { width, height };
      const panel = $("resize-panel");
      if (panel) {
        panel.hidden = false;
        const label = $("resize-label");
        if (label) {
          label.textContent =
            "Resize " +
            VP.canvas.state.width +
            "×" +
            VP.canvas.state.height +
            " → " +
            width +
            "×" +
            height +
            "?";
        }
      }
      syncSizeControls();
      return;
    }
    doResize(width, height);
  }

  function doResize(width, height) {
    VP.canvas.resize(width, height);
    /* The zoom follows the canvas. A 256px canvas at the 16x it inherited
       from a 32px one is 4096 CSS pixels across — three times the pane.
       The current zoom is kept if the canvas still fits; otherwise it
       steps down to the largest that does. */
    VP.canvas.setScale(VP.canvas.scaleForSize());
    /* The grid over the photo is the canvas's size, so it has just changed
       shape. It re-fits itself and the photo is re-centred on it —
       otherwise the grid keeps the cell size it had, grows off the bottom
       of the pane, and half of what is converted is out of sight. */
    VP.workspace.updateCellSize(true);
    VP.workspace.recentreSource();
    autosave();
    renderAll();
  }

  function setZoom(scale) {
    state.prefs.fitZoom = false;
    VP.canvas.setScale(scale);
    autosave();
    renderAll();
  }

  function bindTopBar() {
    /* The one way in that is always visible. The canvas paints, so it
       cannot be the upload target; the top bar can. */
    const loadPhoto = $("load-photo");
    if (loadPhoto) loadPhoto.addEventListener("click", () => openFilePicker("file-image"));

    /* The size: X, Y and the lock between them. */
    const x = $("size-x");
    const y = $("size-y");
    const lock = $("size-lock");
    fillSizes(x);
    fillSizes(y);

    if (x) {
      x.addEventListener("change", () => {
        const value = parseInt(x.value, 10);
        if (!Q.ALLOWED_SIZES.includes(value)) return;
        /* A resize that is waiting for confirmation is the base for the
           next one. Reading the canvas's *current* size instead would
           throw the first change away: set X to 64, then Y to 32, and the
           panel would say "16×32" — the 64 was lost. */
        const base = state.pendingResize || VP.canvas.state;
        /* Linked, the two edges are one number: changing either sets both. */
        if (state.sizeLocked) requestResize(value, value);
        else requestResize(value, base.height);
      });
    }
    if (y) {
      y.addEventListener("change", () => {
        const value = parseInt(y.value, 10);
        if (!Q.ALLOWED_SIZES.includes(value)) return;
        const base = state.pendingResize || VP.canvas.state;
        if (state.sizeLocked) requestResize(value, value);
        else requestResize(base.width, value);
      });
    }
    if (lock) {
      lock.addEventListener("click", () => {
        state.sizeLocked = !state.sizeLocked;
        if (state.sizeLocked) {
          /* Tying them together makes Y match X. */
          const base = state.pendingResize || VP.canvas.state;
          requestResize(base.width, base.width);
        }
        autosave();
        renderAll();
      });
    }

    /* The canvas's own zoom slider. The source pane has its own, and
       neither one moves the other. */
    const zoomSlider = $("canvas-zoom");
    if (zoomSlider) {
      zoomSlider.addEventListener("input", () => {
        setZoom(VP.canvas.scaleFromSlider(parseFloat(zoomSlider.value)));
      });
    }
    const canvasFit = $("canvas-fit");
    if (canvasFit) {
      canvasFit.addEventListener("click", () => {
        state.prefs.fitZoom = true;
        VP.canvas.setScale(VP.canvas.fitScale());
        autosave();
        renderAll();
      });
    }

    const gridToggle = $("grid-toggle");
    if (gridToggle) {
      gridToggle.addEventListener("click", () => {
        VP.canvas.setGridVisible(!VP.canvas.state.gridVisible);
        autosave();
        renderAll();
      });
    }

    const resizeConfirm = $("resize-confirm");
    if (resizeConfirm) {
      resizeConfirm.addEventListener("click", () => {
        const pending = state.pendingResize;
        const panel = $("resize-panel");
        if (panel) panel.hidden = true;
        state.pendingResize = null;
        if (pending) doResize(pending.width, pending.height);
      });
    }

    const resizeCancel = $("resize-cancel");
    if (resizeCancel) {
      resizeCancel.addEventListener("click", () => {
        const panel = $("resize-panel");
        if (panel) panel.hidden = true;
        state.pendingResize = null;
        syncSizeControls();
      });
    }
  }

  function stepZoom(direction) {
    const scales = VP.canvas.SCALES;
    const current = VP.canvas.state.scale;
    let next;
    if (direction > 0) {
      next = scales.find((value) => value > current);
      if (next === undefined) next = scales[scales.length - 1];
    } else {
      const below = scales.filter((value) => value < current);
      next = below.length ? below[below.length - 1] : scales[0];
    }
    setZoom(next);
  }

  /* --- the sidebar ---------------------------------------------------------------- */

  function bindSidebar() {
    const select = $("palette-select");
    if (select) {
      select.addEventListener("change", () => {
        VP.palette.switchTo(select.value);
        autosave();
        renderAll();
      });
    }

    const name = $("palette-name");
    if (name) {
      name.addEventListener("change", () => {
        const renamed = VP.palette.rename(VP.palette.state.activeName, name.value);
        if (!renamed) name.value = VP.palette.state.activeName;
        autosave();
        renderAll();
      });
    }

    const add = $("palette-add");
    if (add) {
      add.addEventListener("click", () => {
        VP.palette.addColour("#ffffff");
        autosave();
        renderAll();
      });
    }

    const remove = $("palette-remove");
    if (remove) {
      remove.addEventListener("click", () => {
        VP.palette.removeColour(VP.palette.state.activeIndex);
        autosave();
        renderAll();
      });
    }

    const reorder = $("palette-reorder");
    if (reorder) {
      reorder.addEventListener("click", () => {
        const note = $("sidebar-note");
        if (note) {
          note.textContent = "Drag a swatch onto another to move it.";
        }
      });
    }

    const colourInput = $("colour-input");
    if (colourInput) {
      colourInput.addEventListener("input", () => {
        VP.palette.setColour(VP.palette.state.activeIndex, colourInput.value);
        autosave();
        renderAll();
      });
    }

    const hexInput = $("colour-hex");
    if (hexInput) {
      hexInput.addEventListener("change", () => {
        const normalised = Q.normaliseHex(hexInput.value);
        if (!normalised) {
          hexInput.value = VP.palette.colours()[VP.palette.state.activeIndex] || "";
          return;
        }
        VP.palette.setColour(VP.palette.state.activeIndex, normalised);
        autosave();
        renderAll();
      });
    }

    const save = $("palette-save");
    if (save) {
      save.addEventListener("click", () => {
        const active = VP.palette.active();
        if (active.builtin) {
          /* A built-in cannot be edited in place — save a copy and work on
             that instead. */
          const copy = VP.palette.duplicate(active.name);
          if (copy) VP.palette.switchTo(copy.name);
        }
        autosave();
        renderAll();
      });
    }

    const duplicate = $("palette-duplicate");
    if (duplicate) {
      duplicate.addEventListener("click", () => {
        VP.palette.duplicate(VP.palette.state.activeName);
        autosave();
        renderAll();
      });
    }

    const removePalette = $("palette-delete");
    if (removePalette) {
      removePalette.addEventListener("click", () => {
        VP.palette.removePalette(VP.palette.state.activeName);
        autosave();
        renderAll();
      });
    }

    const generate = $("palette-generate");
    if (generate) {
      generate.addEventListener("click", () => {
        if (!VP.reference.hasImage()) {
          openFilePicker("file-image");
          return;
        }
        VP.workspace.extract();
        renderAll();
      });
    }
  }

  /* --- the source pane ------------------------------------------------------------------ */

  function bindSourcePane() {
    /* The empty state in the source pane is the other obvious place to click. */
    const sourceLoad = $("ws-source-load");
    if (sourceLoad) sourceLoad.addEventListener("click", () => openFilePicker("file-image"));
  }

  /* --- the bottom bar ------------------------------------------------------------------ */

  function bindBottomBar() {
    const exportPng = $("export-png");
    if (exportPng) {
      exportPng.addEventListener("click", () => {
        const panel = $("export-panel");
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) refreshExportPanel();
      });
    }

    const exportJson = $("export-json");
    if (exportJson) {
      exportJson.addEventListener("click", () => {
        VP.io.exportJSON(
          VP.canvas.state.width,
          VP.canvas.state.height,
          VP.palette.colours(),
          VP.canvas.grid
        );
      });
    }

    const importButton = $("import");
    if (importButton) {
      importButton.addEventListener("click", () => {
        const panel = $("import-panel");
        if (!panel) return;
        panel.hidden = !panel.hidden;
      });
    }

    const copyPng = $("copy-png");
    if (copyPng) {
      copyPng.addEventListener("click", () => {
        VP.io
          .copyPNG(
            VP.canvas.state.width,
            VP.canvas.state.height,
            VP.palette.colours(),
            VP.canvas.grid,
            state.exportScale,
            state.exportBackground
          )
          .then((result) => {
            if (!result.ok) {
              flash(copyPng, "Copy failed", 1500);
              return;
            }
            flash(copyPng, result.mode === "clipboard" ? "Copied" : "Downloaded", 1500);
          });
      });
    }

    const forget = $("forget");
    if (forget) {
      forget.addEventListener("click", () => {
        armConfirm(forget, () => {
          VP.storage.forgetEverything().then(() => {
            root.location.reload();
          });
        });
      });
    }

    /* The export panel. */
    for (const scale of [1, 4, 8, 16, 32]) {
      const node = $("export-scale-" + scale);
      if (node) {
        node.addEventListener("click", () => {
          state.exportScale = scale;
          VP.io.exportPNG(
            VP.canvas.state.width,
            VP.canvas.state.height,
            VP.palette.colours(),
            VP.canvas.grid,
            scale,
            state.exportBackground
          );
          refreshExportPanel();
        });
      }
    }

    const background = $("export-background");
    if (background) {
      background.addEventListener("click", () => {
        state.exportBackground = state.exportBackground ? null : "#0d0d0f";
        refreshExportPanel();
      });
    }

    /* The import panel. */
    const importJson = $("import-json");
    if (importJson) {
      importJson.addEventListener("click", () => openFilePicker("file-json"));
    }
    const adopt = $("import-adopt");
    if (adopt) {
      adopt.addEventListener("click", () => {
        state.importMode = "adopt";
        if (adopt.parentElement) {
          adopt.parentElement.querySelectorAll(".import-mode").forEach((node) => {
            node.classList.toggle("is-active", node === adopt);
          });
        }
      });
    }
    const remap = $("import-remap");
    if (remap) {
      remap.addEventListener("click", () => {
        state.importMode = "remap";
        if (remap.parentElement) {
          remap.parentElement.querySelectorAll(".import-mode").forEach((node) => {
            node.classList.toggle("is-active", node === remap);
          });
        }
      });
    }
  }

  function refreshExportPanel() {
    const width = VP.canvas.state.width;
    const height = VP.canvas.state.height;
    for (const scale of [1, 4, 8, 16, 32]) {
      const node = $("export-scale-" + scale);
      if (!node) continue;
      const allowed = VP.io.scaleAllowed(width, height, scale);
      node.disabled = !allowed;
      node.classList.toggle("is-active", scale === state.exportScale);
      node.textContent = allowed ? scale + "×" : scale + "× too large";
    }
    const background = $("export-background");
    if (background) {
      background.textContent = state.exportBackground
        ? "Background: " + state.exportBackground
        : "Background: transparent";
      background.classList.toggle("is-active", !!state.exportBackground);
    }
  }

  function openFilePicker(id) {
    const input = $(id);
    if (!input) return;
    input.value = "";
    input.click();
  }

  /* --- file inputs ------------------------------------------------------------------------ */

  function bindFileInputs() {
    const image = $("file-image");
    if (image) {
      image.addEventListener("change", () => {
        const file = image.files && image.files[0];
        if (file) loadImageFile(file);
      });
    }

    const json = $("file-json");
    if (json) {
      json.addEventListener("change", () => {
        const file = json.files && json.files[0];
        if (file) importJsonFile(file);
      });
    }

  }

  /* --- the alert bar ----------------------------------------------------------- */

  /* A failure has to be visible. The old code wrote the message into the
     import panel, which is hidden unless you opened it — so a photo that
     would not load produced no message at all, and the app looked broken
     rather than quiet. */
  function showError(message) {
    const bar = $("alert");
    const text = $("alert-text");
    if (text) text.textContent = message;
    if (bar) bar.hidden = false;

    /* And in the workspace, if it is open — that is where the user was. */
    if (VP.workspace && VP.workspace.isOpen()) VP.workspace.setStatus(message);
  }

  function clearError() {
    const bar = $("alert");
    const text = $("alert-text");
    if (text) text.textContent = "";
    if (bar) bar.hidden = true;
  }

  function bindAlert() {
    const dismiss = $("alert-dismiss");
    if (dismiss) dismiss.addEventListener("click", clearError);
  }

  /* --- file inputs ------------------------------------------------------------------------ */

  function loadImageFile(file) {
    VP.reference
      .load(file, file.name, file.type)
      .then(() => {
        VP.storage.savePhoto(file, file.name, file.type);
        /* A freshly loaded photo has to appear somewhere the user is
           looking. The source pane is the only view there is. */
        VP.workspace.fitSource();
        clearError();
        autosave();
        renderAll();
      })
      .catch((problem) => {
        showError(problem.message || "that file could not be read");
      });
  }

  function importJsonFile(file) {
    const error = $("import-error");
    VP.io.importJSON(file).then((result) => {
      if (!result.ok) {
        if (error) error.textContent = result.error;
        showError(result.error);
        return;
      }
      if (error) error.textContent = "";
      clearError();

      const palette = result.palette;
      const pixels = result.pixels;

      if (state.importMode === "adopt") {
        /* The file's palette replaces the current one, and the indices map
           1:1. Exact and lossless. */
        VP.canvas.resize(result.width, result.height);
        const grid = new Int8Array(result.width * result.height);
        for (let row = 0; row < result.height; row += 1) {
          for (let col = 0; col < result.width; col += 1) {
            grid[row * result.width + col] = pixels[row][col];
          }
        }
        VP.palette.adopt(palette);
        VP.canvas.setGrid(grid);
      } else {
        /* Remap: every colour in the file snaps to the nearest colour in the
           current palette. */
        VP.canvas.resize(result.width, result.height);
        const grid = new Int8Array(result.width * result.height);
        for (let row = 0; row < result.height; row += 1) {
          for (let col = 0; col < result.width; col += 1) {
            grid[row * result.width + col] = pixels[row][col];
          }
        }
        VP.canvas.setGrid(Q.remapGrid(grid, palette, VP.palette.colours()));
      }

      autosave();
      renderAll();
    });
  }

  /* Replaces the active palette's colours in place, keeping the art by
     colour. */
  function applyPalette(colours) {
    VP.palette.adopt(colours);
  }

  /* --- drag and drop, and paste ------------------------------------------------------- */

  /* Does this drag carry files? Text drags and drags inside the page must
     not turn the whole page into a drop target. */
  function dragHasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (const type of types) {
      if (type === "Files") return true;
    }
    return false;
  }

  function bindDragAndDrop() {
    /* The WHOLE page is a drop target.

       It used to be the canvas view and the source pane, and the source
       pane only exists while the workspace is open. Releasing a photo over
       the sidebar, the top bar or the bottom bar did nothing at all, which
       made dropping "hit and miss" — you had to release it over exactly
       the right box, and the box was not where you let go.

       One handler on the document covers every release. The drop event
       bubbles, so the old per-target handlers would have loaded the image
       twice; they are gone, and the highlight moved with them. */
    let depth = 0;

    document.addEventListener("dragenter", (event) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      document.body.classList.add("is-drop-target");
    });

    document.addEventListener("dragover", (event) => {
      if (!dragHasFiles(event)) return;
      /* Without this the browser refuses the drop and nothing happens. */
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("dragleave", (event) => {
      if (!dragHasFiles(event)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        document.body.classList.remove("is-drop-target");
      }
    });

    document.addEventListener("drop", (event) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      document.body.classList.remove("is-drop-target");

      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files) return;
      for (const file of files) {
        if (file.type && file.type.startsWith("image/")) {
          loadImageFile(file);
          return;
        }
      }
      /* A non-image file is ignored, silently. */
    });
  }

  function bindPaste() {
    document.addEventListener("paste", (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard || !clipboard.items) return;
      for (const item of clipboard.items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            loadImageFile(file);
          }
          return;
        }
      }
      /* A text paste is left to the browser. */
    });
  }

  /* --- the keyboard ------------------------------------------------------------------------ */

  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable === true
    );
  }

  function closePanels() {
    for (const id of ["export-panel", "import-panel", "resize-panel"]) {
      const node = $(id);
      if (node) node.hidden = true;
    }
  }

  /* Is the source pane the thing the keyboard should act on? The two panes
     have their own zooms, and the keyboard zooms whichever one the pointer
     or the focus is in. */
  function sourceFocused() {
    const active = document.activeElement;
    if (!active) return false;
    const pane = $("ws-source-pane");
    return !!(pane && pane.contains(active));
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (event) => {
      if (isTyping(event.target)) return;

      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key;

      /* Every browser shortcut is left alone. There is no undo stack in a
         pipeline — the way to change the result is to change a setting and
         convert again. */
      if (modifier) return;

      switch (key) {
        case "g":
        case "G":
          VP.canvas.setGridVisible(!VP.canvas.state.gridVisible);
          autosave();
          renderAll();
          break;
        case "+":
        case "=":
          if (sourceFocused()) VP.workspace.zoomBy(1.25);
          else stepZoom(1);
          break;
        case "-":
        case "_":
          if (sourceFocused()) VP.workspace.zoomBy(1 / 1.25);
          else stepZoom(-1);
          break;
        case "0":
          state.prefs.fitZoom = true;
          VP.canvas.setScale(VP.canvas.fitScale());
          autosave();
          renderAll();
          break;
        case "[":
        case "]": {
          const count = VP.palette.colours().length;
          const step = key === "]" ? 1 : -1;
          const next = (VP.palette.state.activeIndex + step + count) % count;
          VP.palette.setActiveIndex(next);
          renderAll();
          break;
        }
        case "i":
        case "I":
          openFilePicker("file-image");
          break;
        case "l":
        case "L":
          VP.reference.autoLevels();
          VP.workspace.updateAdjustReadouts();
          VP.workspace.invalidate();
          VP.workspace.commitPreview();
          break;
        case "x":
        case "X": {
          const order = ["flat", "bayer", "floyd", "clustered"];
          const index = order.indexOf(VP.workspace.state.matchMethod);
          const next = order[(index + 1) % order.length];
          VP.workspace.state.matchMethod = next;
          VP.workspace.markGroup("ws-match", next);
          VP.workspace.commitPreview();
          break;
        }
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          event.preventDefault();
          const step = event.shiftKey ? 32 : 8;
          const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
          const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
          VP.workspace.panBy(dx, dy);
          break;
        }
        case "Escape":
          if (ARMED.length) {
            for (const node of ARMED.slice()) disarmConfirm(node);
            break;
          }
          if (VP.palette.state.activeIndex === -1) {
            VP.palette.setActiveIndex(0);
            renderAll();
          } else {
            closePanels();
          }
          break;
        default:
          break;
      }
    });
  }

  /* --- boot ------------------------------------------------------------------------------ */

  APP.boot = function boot() {
    const prefs = VP.storage.loadPrefs() || {};
    Object.assign(state.prefs, prefs);

    const storedPalettes = VP.storage.loadPalettes();
    const storedCanvas = VP.storage.loadCanvas();

    const activeName = state.prefs.activePalette || "Void Palette";
    const activeIndex = state.prefs.activeIndex || 0;

    VP.palette.init(storedPalettes, activeName, activeIndex);
    VP.palette.hooks.remap = (grid) => {
      VP.canvas.setGrid(grid);
    };
    VP.palette.hooks.save = saveNow;
    VP.palette.hooks.render = renderAll;

    VP.canvas.init($("art-canvas"));
    /* The canvas's zoom slider and readout follow the scale, whoever set
       it — the app's zoom control, a resize, or a layout change. */
    VP.canvas.hooks.scale = () => syncCanvasZoom();
    VP.canvas.state.gridVisible =
      state.prefs.gridVisible === undefined ? true : !!state.prefs.gridVisible;

    if (storedCanvas) {
      VP.canvas.resize(storedCanvas.width, storedCanvas.height);
      VP.canvas.setGrid(storedCanvas.grid);
    }

    state.sizeLocked =
      state.prefs.sizeLocked === undefined ? true : !!state.prefs.sizeLocked;

    /* The source layer's own settings. */
    VP.reference.state.onChange = () => {
      renderAll();
      VP.workspace.refresh();
    };

    VP.menu.init();
    VP.workspace.init();
    watchConfirmations();
    VP.workspace.state.panX = state.prefs.srcPanX || 0;
    VP.workspace.state.panY = state.prefs.srcPanY || 0;
    VP.workspace.state.zoom = state.prefs.srcZoom || 1;
    VP.workspace.onConvert = (result, width, height) => {
      if (
        width !== VP.canvas.state.width ||
        height !== VP.canvas.state.height
      ) {
        VP.canvas.resize(width, height);
      }
      VP.canvas.setGrid(result);
      VP.canvas.clearPreview();
      autosave();
      renderAll();
    };

    bindTopBar();
    bindSidebar();
    bindSourcePane();
    bindBottomBar();
    bindFileInputs();
    bindDragAndDrop();
    bindPaste();
    bindKeyboard();
    bindAlert();

    /* The zoom. The saved scale is a starting point, not a promise: if the
       canvas no longer fits at that zoom, it steps down until it does. */
    if (state.prefs.fitZoom) {
      VP.canvas.setScale(VP.canvas.fitScale());
    } else {
      VP.canvas.setScale(state.prefs.scale || 16);
      VP.canvas.setScale(VP.canvas.scaleForSize());
    }

    VP.palette.render();
    renderAll();
    VP.canvas.composite();

    /* The photo, restored from the local store. */
    VP.storage.loadPhoto().then((record) => {
      if (!record || !record.blob) return;
      VP.reference
        .load(record.blob, record.name, record.type)
        .then(() => {
          if (VP.workspace.state.zoom > 0) {
            VP.workspace.state.panX = state.prefs.srcPanX;
            VP.workspace.state.panY = state.prefs.srcPanY;
            VP.workspace.state.zoom = state.prefs.srcZoom;
          }
          renderAll();
        })
        .catch(() => {
          /* An unreadable photo is handled the same way as a missing one: the
             app opens without it. */
        });
    });

    /* Autosave on the way out. */
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveNow();
    });
    root.addEventListener("pagehide", saveNow);

    root.addEventListener("resize", () => {
      VP.workspace.resizeCanvases();
      if (state.prefs.fitZoom) {
        VP.canvas.setScale(VP.canvas.fitScale());
      } else {
        /* The window got smaller and the canvas no longer fits. */
        VP.canvas.setScale(VP.canvas.scaleForSize());
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", APP.boot);
  } else {
    APP.boot();
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
