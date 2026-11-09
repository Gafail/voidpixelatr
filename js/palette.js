/* ==========================================================================
   VoidPixelatr — palette.js
   --------------------------------------------------------------------------
   The palette model and its UI: three nested built-ins, user palettes, colour
   editing, reordering, the staging palette used by the generator and the
   transformer, and the re-indexing that happens when the palette changes.

   Every function that touches the DOM is called from app.js at boot, so this
   file can be loaded in Node without a document.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = VP.quantise;

  /* --- the built-in palettes ---------------------------------------------- */

  /* Twelve hue families, each with one step in the 16, two in the 32 and
     four in the 64 — so every hue gets the same depth and no hue is left
     with a single lonely colour while another has a ramp.

     The families, in order: red, orange, yellow, lime, green, teal, cyan,
     azure, blue, indigo, violet, magenta.

     Each ramp runs dark to light, and the shadows drift cool while the
     highlights drift warm — the same "B-grading" the good pixel-art
     palettes use, so a sprite lit from one side still reads correctly.

     The neutrals fill the rest: four in the 16, eight in the 32, sixteen in
     the 64. The extra ones are the earths — browns, tans and warm greys —
     which pixel art needs far more of than a hue wheel suggests. */

  const VOID_16 = [
    /* the neutrals */
    "#0d0d0f", "#2a2a33", "#8b8b96", "#ffffff",
    /* the base step of every hue family */
    "#d1333a", "#e07a1f", "#d9b30a", "#8fc626",
    "#2f9e44", "#17a89a", "#12b5cc", "#2f7fd6",
    "#3559d9", "#4f4fd9", "#7a3fd0", "#c22fb8",
  ];

  const VOID_32 = VOID_16.concat([
    /* the shadow step of every hue family */
    "#4a0e14", "#5c2a00", "#5c4a00", "#2e4a00",
    "#0d3a18", "#003a3a", "#00454c", "#0a2a52",
    "#101c4f", "#1a1440", "#2a0f45", "#3f0a35",
    /* four more neutrals */
    "#000000", "#55555f", "#b8b8c2", "#f4f4f8",
  ]);

  const VOID_64 = VOID_32.concat([
    /* the light step of every hue family */
    "#f26b62", "#f9a54a", "#f5d94a", "#c2e35c",
    "#6ecf6e", "#4fd6c2", "#4fd9ea", "#62b0f0",
    "#6b8cf0", "#8a8af0", "#a878f0", "#f06ad6",
    /* the highlight step of every hue family */
    "#ffb0a2", "#ffd08a", "#fff5a8", "#eaf7a8",
    "#b6f0a8", "#a8f0e2", "#a8f0f7", "#a8d8ff",
    "#a8bcff", "#c0c0ff", "#d8b8ff", "#ffb0ee",
    /* eight more neutrals — the earths */
    "#16161e", "#3a3a46", "#6b6b76", "#d8d8e0",
    "#2e2620", "#554840", "#8a7259", "#b8a68d",
  ]);

  const P = (VP.palette = {});

  P.BUILTINS = [
    { name: "Void Palette", colours: VOID_16.slice(), builtin: true, size: 16 },
    { name: "Void Expanded", colours: VOID_32.slice(), builtin: true, size: 32 },
    { name: "Void Full", colours: VOID_64.slice(), builtin: true, size: 64 },
  ];

  /* The built-ins are nested, so switching between them is always an exact
     match and existing art is never touched. */
  P.builtinsAreNested = function builtinsAreNested() {
    const a = VOID_16;
    const b = VOID_32;
    const c = VOID_64;
    for (let i = 0; i < 16; i += 1) if (a[i] !== b[i]) return false;
    for (let i = 0; i < 32; i += 1) if (b[i] !== c[i]) return false;
    return true;
  };

  /* --- the hue families ---------------------------------------------------- */

  /* Twelve families around the wheel, and the neutral family. The families
     are given by their representative hue; a colour belongs to the family
     whose hue it is closest to, which is how a drifting shadow or a warm
     highlight still lands on the family it belongs to. */
  const HUE_FAMILIES = [
    { name: "red", hue: 353 },
    { name: "orange", hue: 28 },
    { name: "yellow", hue: 49 },
    { name: "lime", hue: 81 },
    { name: "green", hue: 131 },
    { name: "teal", hue: 174 },
    { name: "cyan", hue: 187 },
    { name: "azure", hue: 211 },
    { name: "blue", hue: 227 },
    { name: "indigo", hue: 240 },
    { name: "violet", hue: 264 },
    { name: "magenta", hue: 304 },
  ];

  P.HUE_FAMILIES = HUE_FAMILIES;

  /* Below this saturation a colour is a neutral or an earth, not a hue. */
  const HUE_SATURATION_FLOOR = 0.3;

  P.HUE_SATURATION_FLOOR = HUE_SATURATION_FLOOR;

  /* The family a colour belongs to: "neutral" for the greys and the earths,
     otherwise the nearest family on the wheel. */
  P.familyOf = function familyOf(hex) {
    const rgb = Q.hexToRgb(hex);
    if (!rgb) return "neutral";
    const hsl = Q.rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (hsl[1] < HUE_SATURATION_FLOOR) return "neutral";

    let best = HUE_FAMILIES[0];
    let bestDistance = 360;
    for (const family of HUE_FAMILIES) {
      let distance = Math.abs(hsl[0] - family.hue);
      if (distance > 180) distance = 360 - distance;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = family;
      }
    }
    return best.name;
  };

  /* How many colours of each family a palette holds. This is the balance
     the built-ins are designed around: every hue family has the same depth,
     so no hue is left with one lonely colour. */
  P.hueCoverage = function hueCoverage(colours) {
    const counts = { neutral: 0 };
    for (const family of HUE_FAMILIES) counts[family.name] = 0;
    for (const hex of colours) {
      const family = P.familyOf(hex);
      counts[family] = (counts[family] || 0) + 1;
    }
    return counts;
  };

  /* --- model --------------------------------------------------------------- */

  const state = {
    list: [],
    activeName: "Void Palette",
    activeIndex: 0,
    /* The staging palette: what the generator produced and the transformer
       is tuning. It is live in the sidebar and in the pixel preview, but the
       real palette is untouched until Apply. */
    staged: null,
    /* The untransformed extraction the staging palette was made from. */
    stagedSource: null,
    stagedTransform: null,
  };

  P.state = state;

  /* Throws the staging palette away, with everything that came with it. */
  function clearStaged() {
    state.staged = null;
    state.stagedSource = null;
    state.stagedTransform = null;
  }

  /* Hooks the app fills in: remapping the canvas, persisting, re-rendering. */
  P.hooks = {
    remap: null,
    save: null,
    render: null,
  };

  P.init = function init(list, activeName, activeIndex) {
    state.list = P.BUILTINS.map((entry) => ({
      name: entry.name,
      colours: entry.colours.slice(),
      builtin: true,
    }));

    for (const entry of list || []) {
      if (!entry || !Array.isArray(entry.colours) || !entry.colours.length) continue;
      state.list.push({
        name: String(entry.name || "Untitled"),
        colours: entry.colours.map((hex) => Q.normaliseHex(hex)).filter(Boolean),
        builtin: false,
      });
    }

    state.activeName = activeName || "Void Palette";
    if (!P.find(state.activeName)) state.activeName = "Void Palette";
    state.activeIndex = typeof activeIndex === "number" ? activeIndex : 0;
    P.clampActiveIndex();
  };

  P.find = function find(name) {
    return state.list.find((entry) => entry.name === name) || null;
  };

  P.active = function active() {
    return P.find(state.activeName) || state.list[0];
  };

  /* The colours the app is currently working with: the staging palette when
     one exists, otherwise the active palette. */
  P.colours = function colours() {
    if (state.staged) return state.staged;
    return P.active().colours;
  };

  P.userPalettes = function userPalettes() {
    return state.list.filter((entry) => !entry.builtin);
  };

  P.clampActiveIndex = function clampActiveIndex() {
    const count = P.colours().length;
    if (count === 0) {
      state.activeIndex = -1;
      return;
    }
    if (state.activeIndex >= count) state.activeIndex = count - 1;
    if (state.activeIndex < 0) state.activeIndex = 0;
  };

  /* --- switching ------------------------------------------------------------ */

  /* Switching palettes re-indexes the canvas: exact hex first, nearest
     colour second. The art is never lost. */
  P.switchTo = function switchTo(name) {
    const target = P.find(name);
    if (!target || target.name === state.activeName) return false;

    const from = P.active().colours;
    const to = target.colours;

    state.activeName = target.name;
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, to.length - 1));

    if (P.hooks.remap) {
      P.hooks.remap(Q.remapGrid(VP.canvas.grid, from, to));
    }
    if (P.hooks.save) P.hooks.save();
    return true;
  };

  P.setActiveIndex = function setActiveIndex(index) {
    state.activeIndex = index;
    if (P.hooks.render) P.hooks.render();
  };

  /* --- editing -------------------------------------------------------------- */

  P.setColour = function setColour(index, hex) {
    const normalised = Q.normaliseHex(hex);
    if (!normalised) return false;
    const entry = P.active();
    if (index < 0 || index >= entry.colours.length) return false;
    entry.colours[index] = normalised;
    P.commit();
    return true;
  };

  P.addColour = function addColour(hex) {
    const entry = P.active();
    if (entry.builtin) return false;
    if (entry.colours.length >= 64) return false;
    const normalised = Q.normaliseHex(hex) || "#000000";
    entry.colours.push(normalised);
    state.activeIndex = entry.colours.length - 1;
    P.commit();
    return true;
  };

  P.removeColour = function removeColour(index) {
    const entry = P.active();
    if (entry.builtin) return false;
    if (index < 0 || index >= entry.colours.length) return false;
    entry.colours.splice(index, 1);
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, entry.colours.length - 1));
    P.commit();
    return true;
  };

  P.moveColour = function moveColour(from, to) {
    const entry = P.active();
    if (entry.builtin) return false;
    if (from < 0 || from >= entry.colours.length) return false;
    if (to < 0 || to >= entry.colours.length) return false;
    if (from === to) return false;

    const moved = entry.colours.splice(from, 1)[0];
    entry.colours.splice(to, 0, moved);
    state.activeIndex = to;
    P.commit();
    return true;
  };

  P.commit = function commit() {
    P.clampActiveIndex();
    if (P.hooks.save) P.hooks.save();
    if (P.hooks.render) P.hooks.render();
  };

  /* --- user palettes -------------------------------------------------------- */

  P.createPalette = function createPalette(name, colours, size) {
    const count = size === 32 || size === 64 ? size : 16;
    const base = (colours && colours.length ? colours : []).slice(0, count);
    while (base.length < count) base.push("#000000");

    const entry = {
      name: name || "Untitled",
      colours: base,
      builtin: false,
    };
    state.list.push(entry);
    return entry;
  };

  P.rename = function rename(oldName, newName) {
    const entry = P.find(oldName);
    if (!entry || entry.builtin) return false;
    const name = String(newName || "").trim();
    if (!name) return false;
    entry.name = name;
    if (state.activeName === oldName) state.activeName = name;
    P.commit();
    return true;
  };

  P.duplicate = function duplicate(name) {
    const entry = P.find(name);
    if (!entry) return null;
    const copy = {
      name: nextCopyName(entry.name),
      colours: entry.colours.slice(),
      builtin: false,
    };
    state.list.push(copy);
    P.commit();
    return copy;
  };

  function nextCopyName(name) {
    let candidate = name + " copy";
    let n = 2;
    while (P.find(candidate)) {
      candidate = name + " copy " + n;
      n += 1;
    }
    return candidate;
  }

  P.removePalette = function removePalette(name) {
    const entry = P.find(name);
    if (!entry || entry.builtin) return false;
    state.list = state.list.filter((item) => item !== entry);
    if (state.activeName === name) {
      state.activeName = "Void Palette";
      state.activeIndex = 0;
    }
    P.commit();
    return true;
  };

  /* Adopts a palette wholesale — the "adopt the file's palette" import mode.

     A built-in is never mutated: it is copied first, so the built-ins stay
     exactly as they ship. Existing art is re-indexed by colour either way. */
  P.adopt = function adopt(colours) {
    const entry = P.active();
    const from = entry.colours;

    let target = entry;
    if (entry.builtin) {
      /* The file's palette is kept exactly as it is — twelve colours stays
         twelve. The ladder applies to palettes the user creates, not to
         ones they import. */
      target = {
        name: "Imported",
        colours: colours.slice(),
        builtin: false,
      };
      state.list.push(target);
    } else {
      target.colours = colours.slice();
    }

    if (P.hooks.remap) {
      P.hooks.remap(Q.remapGrid(VP.canvas.grid, from, target.colours));
    }

    state.activeName = target.name;
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, target.colours.length - 1));

    if (P.hooks.save) P.hooks.save();
    if (P.hooks.render) P.hooks.render();
    return target;
  };

  /* --- the staging palette -------------------------------------------------- */

  P.stage = function stage(colours) {
    state.staged = colours.slice();
    /* The untransformed extraction. Every transform starts from this, never
       from the last result — see transformStaged. */
    state.stagedSource = colours.slice();
    state.stagedTransform = null;
    if (P.hooks.render) P.hooks.render();
  };

  P.unstage = function unstage() {
    clearStaged();
    if (P.hooks.render) P.hooks.render();
  };

  P.hasStaged = function hasStaged() {
    return !!state.staged;
  };

  /* Applies a transform to the staging palette and keeps the merge count. */
  P.transformStaged = function transformStaged(transform) {
    if (!state.staged) return null;
    /* Always transform from the ORIGINAL extraction. Transforming the last
       result instead compounds: every slider move would apply on top of the
       previous one, so the colours would run away while you dragged and
       putting the slider back would not restore them. */
    const base = state.stagedSource || state.staged;
    const result = Q.transformPalette(base, transform);
    state.staged = result.colours;
    state.stagedTransform = transform;
    state.stagedMerged = result.merged;
    state.stagedBefore = result.before;
    if (P.hooks.render) P.hooks.render();
    return result;
  };

  P.stagedMerged = 0;
  P.stagedBefore = 0;

  /* Commits the staging palette. `target` is "replace", "append" or "new". */
  P.commitStaged = function commitStaged(target, name) {
    if (!state.staged) return null;
    const staged = state.staged.slice();
    const active = P.active();

    if (target === "new") {
      const entry = P.createPalette(name || "From image", staged, staged.length > 32 ? 64 : staged.length > 16 ? 32 : 16);
      clearStaged();
      state.activeName = entry.name;
      state.activeIndex = 0;
      if (P.hooks.save) P.hooks.save();
      if (P.hooks.render) P.hooks.render();
      return entry;
    }

    if (target === "append") {
      if (active.builtin) {
        /* A built-in cannot grow, so appending to one starts a copy. */
        const copy = P.createPalette(
          active.name + " +",
          active.colours.concat(staged),
          Math.min(64, active.colours.length + staged.length)
        );
        state.activeName = copy.name;
        state.activeIndex = 0;
        clearStaged();
        if (P.hooks.save) P.hooks.save();
        if (P.hooks.render) P.hooks.render();
        return copy;
      }
      const merged = active.colours.concat(staged).slice(0, 64);
      P.hooks.remap(
        Q.remapGrid(VP.canvas.grid, active.colours, merged)
      );
      active.colours = merged;
    } else {
      /* Replace: the canvas keeps its art by colour, not by position. */
      P.hooks.remap(
        Q.remapGrid(VP.canvas.grid, active.colours, staged)
      );
      active.colours = staged.slice();
    }

    clearStaged();
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, active.colours.length - 1));
    if (P.hooks.save) P.hooks.save();
    if (P.hooks.render) P.hooks.render();
    return active;
  };

  /* --- rendering -------------------------------------------------------------- */

  /* Builds the swatch grid: the eraser tile on top, then one tile per
     colour. */
  P.render = function render() {
    const grid = document.getElementById("swatch-grid");
    if (!grid) return;

    const colours = P.colours();
    const previous = grid.querySelector(".swatch.is-dragging");
    grid.textContent = "";

    const eraser = document.createElement("button");
    eraser.type = "button";
    eraser.className = "swatch swatch-eraser";
    eraser.textContent = "";
    eraser.title = "Eraser (E)";
    eraser.setAttribute("aria-label", "Eraser");
    if (state.activeIndex === -1) eraser.classList.add("is-active");
    eraser.addEventListener("click", () => {
      state.activeIndex = -1;
      if (P.hooks.render) P.hooks.render();
    });
    grid.appendChild(eraser);

    colours.forEach((hex, index) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.background = hex;
      swatch.title = hex;
      swatch.setAttribute("aria-label", `Colour ${index + 1} ${hex}`);
      swatch.dataset.index = String(index);
      swatch.draggable = true;
      if (state.activeIndex === index) swatch.classList.add("is-active");

      swatch.addEventListener("click", () => {
        state.activeIndex = index;
        if (P.hooks.render) P.hooks.render();
      });

      swatch.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
        swatch.classList.add("is-dragging");
      });

      swatch.addEventListener("dragend", () => {
        swatch.classList.remove("is-dragging");
        grid.querySelectorAll(".swatch.is-drop").forEach((node) => {
          node.classList.remove("is-drop");
        });
      });

      swatch.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        swatch.classList.add("is-drop");
      });

      swatch.addEventListener("dragleave", () => {
        swatch.classList.remove("is-drop");
      });

      swatch.addEventListener("drop", (event) => {
        event.preventDefault();
        swatch.classList.remove("is-drop");
        const from = parseInt(event.dataTransfer.getData("text/plain"), 10);
        if (!Number.isInteger(from)) return;
        P.moveColour(from, index);
      });

      grid.appendChild(swatch);
    });

    if (previous) grid.appendChild(previous);

    const nameSelect = document.getElementById("palette-select");
    if (nameSelect) {
      nameSelect.textContent = "";
      for (const entry of state.list) {
        const option = document.createElement("option");
        option.value = entry.name;
        option.textContent = entry.name + (entry.builtin ? "" : " · " + entry.colours.length);
        if (entry.name === state.activeName) option.selected = true;
        nameSelect.appendChild(option);
      }
    }

    const count = document.getElementById("palette-count");
    if (count) count.textContent = colours.length + " colours";

    /* The menu's header carries the two things worth knowing without
       opening anything: which palette is in use, and what colour the
       active swatch is. */
    const chip = document.getElementById("colour-chip");
    if (chip) {
      chip.style.background = colours[state.activeIndex] || "transparent";
    }

    const summary = document.getElementById("palette-summary");
    if (summary) summary.textContent = state.activeName || "palette";

    const addButton = document.getElementById("palette-add");
    if (addButton) {
      const full = colours.length >= 64;
      addButton.disabled = full;
      /* The label used to become "palette full (64)" — which reads as the
         name of a palette, not as the state of a button. */
      addButton.textContent = full ? "Full — 64 max" : "+ Add";
      addButton.title = full
        ? "The palette is full — 64 colours is the maximum"
        : "Add a colour to this palette";
    }

    const removeButton = document.getElementById("palette-remove");
    if (removeButton) removeButton.disabled = P.active().builtin;

    const reorderButton = document.getElementById("palette-reorder");
    if (reorderButton) reorderButton.disabled = P.active().builtin;

    const stageNote = document.getElementById("palette-stage-note");
    if (stageNote) {
      stageNote.hidden = !state.staged;
      if (state.staged) {
        stageNote.textContent =
          "Staged palette — not applied yet (" + state.staged.length + " colours)";
      }
    }

    const colourInput = document.getElementById("colour-input");
    if (colourInput) {
      const current = colours[state.activeIndex];
      colourInput.value = current || "#000000";
    }

    const hexInput = document.getElementById("colour-hex");
    if (hexInput) {
      const current = colours[state.activeIndex];
      if (document.activeElement !== hexInput) hexInput.value = current || "";
    }
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
