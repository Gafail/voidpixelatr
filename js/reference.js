/* ==========================================================================
   VoidPixelatr — reference.js
   --------------------------------------------------------------------------
   The source layer: the photo, and everything that adjusts it.

   There is one session image. It has one view — the source pane, beside the
   grid — and one set of adjustments. Loading it sets it; clearing it releases
   it completely.

   The no-upload guarantee holds here without exception: the file is decoded
   locally with createImageBitmap (or a data: URL on older Safari), drawn to a
   canvas, and read back as ImageData. No fetch, no XHR, no blob: URL — the
   CSP's img-src has no blob: anyway.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = VP.quantise;
  const R = (VP.reference = {});

  /* --- the limits, stated openly on the load page ------------------------- */

  const LIMITS = {
    /* The largest file we will even look at. */
    maxFileBytes: 64 * 1024 * 1024,
    /* The largest source dimension we will decode. */
    maxDimension: 16384,
    /* The working copy is downscaled to this, preserving the aspect ratio.
       A decoded bitmap costs 4 bytes per pixel, so this is 16 MB. */
    workingMax: 2048,
    /* The reduced copy used for the live previews while a slider moves. */
    previewMax: 512,
  };

  R.LIMITS = LIMITS;

  R.LIMIT_TEXT =
    "One image at a time · up to " +
    Math.round(LIMITS.maxFileBytes / (1024 * 1024)) +
    " MB · decoded at most " +
    LIMITS.workingMax +
    "×" +
    LIMITS.workingMax +
    " · decoded in this browser, never uploaded.";

  /* --- state ---------------------------------------------------------------- */

  const state = {
    source: null,
    adjust: Q.defaultAdjust(),
    onChange: null,
    /* True when the full-resolution copy is behind the current adjustment.
       While a control is moving only the reduced copy is updated, so the full
       copy has to be brought up to date when the control settles. */
    adjustedStale: false,
  };

  R.state = state;

  /* The module's own properties are the state's properties. Reading
     `VP.reference.adjust` and `VP.reference.state.adjust` must mean the same
     thing — there is only one set of adjustments. */
  Object.defineProperties(R, {
    adjust: {
      get: () => state.adjust,
      set: (value) => {
        state.adjust = value;
      },
    },
    source: {
      get: () => state.source,
    },
  });

  R.hasImage = function hasImage() {
    return !!state.source;
  };

  /* --- decoding -------------------------------------------------------------- */

  /* Reads the dimensions out of a PNG or JPEG header without decoding the
     pixels, so an absurd image is refused before it is decoded. Returns null
     for formats we do not sniff. */
  function readImageSize(blob) {
    return blob
      .slice(0, 65536)
      .arrayBuffer()
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 24) return null;

        /* PNG: the IHDR chunk sits at a fixed offset. */
        if (
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47
        ) {
          const width =
            (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
          const height =
            (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
          return { width, height };
        }

        /* JPEG: walk the segment markers to the frame header. */
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
          let offset = 2;
          while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
              offset += 1;
              continue;
            }
            const marker = bytes[offset + 1];
            const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
            const isFrame =
              marker >= 0xc0 &&
              marker <= 0xcf &&
              marker !== 0xc4 &&
              marker !== 0xc8 &&
              marker !== 0xcc;
            if (isFrame) {
              const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
              const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
              return { width, height };
            }
            offset += 2 + length;
          }
        }

        return null;
      })
      .catch(() => null);
  }

  function decodeWithBitmap(blob) {
    if (typeof root.createImageBitmap === "function") {
      return root.createImageBitmap(blob);
    }
    return null;
  }

  /* The fallback for browsers without createImageBitmap: a data: URL and an
     <img> element. Still no network — the data never leaves the machine. */
  function decodeWithDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onerror = () => reject(new Error("read failed"));
      reader.onload = () => {
        const image = new root.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("decode failed"));
        image.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  /* An ImageData is not a drawImage source in Firefox. Handing one over
     throws:

       CanvasRenderingContext2D.drawImage: Argument 1 could not be
       converted to any of: HTMLImageElement, SVGImageElement,
       HTMLCanvasElement, HTMLVideoElement, OffscreenCanvas, ImageBitmap,
       VideoFrame.

     When the drawable is an ImageData it is painted into a canvas first,
     and the canvas is what gets drawn. A canvas is a valid source
     everywhere.

     This bit the resampler: a photo larger than the working cap was
     downscaled by handing its ImageData straight to drawImage, so any
     photo over 2048 pixels failed to load at all. */
  function toDrawable(source) {
    if (!source || typeof source !== "object") return source;
    /* An ImageData has `data`; an ImageBitmap, an <img> and a canvas do not. */
    if (!("data" in source) || !("width" in source)) return source;
    const canvas = makeCanvas(source.width, source.height);
    paintCanvas(canvas, source);
    return canvas;
  }

  function drawToImageData(drawable, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.drawImage(toDrawable(drawable), 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /* Paints an ImageData into a canvas.

     The image is drawn through a canvas rather than handed to drawImage
     directly: Firefox does not accept ImageData as a drawImage source, and a
     canvas is a valid source everywhere. */
  function paintCanvas(canvas, image) {
    const context = canvas.getContext("2d");
    context.putImageData(
      new root.ImageData(image.data, image.width, image.height),
      0,
      0
    );
  }

  function downscale(imageData, max) {
    const longest = Math.max(imageData.width, imageData.height);
    if (longest <= max) return imageData;

    const scale = max / longest;
    const width = Math.max(1, Math.round(imageData.width * scale));
    const height = Math.max(1, Math.round(imageData.height * scale));
    return drawToImageData(imageData, width, height);
  }

  /* --- loading ----------------------------------------------------------------- */

  /* Loads the session image from a Blob. Rejects with a message that can be
     shown to the user as-is. */
  R.load = function load(blob, name, type) {
    if (!blob) return Promise.reject(new Error("no file"));

    if (blob.size > LIMITS.maxFileBytes) {
      return Promise.reject(
        new Error(
          "That file is " +
            (blob.size / (1024 * 1024)).toFixed(0) +
            " MB. The limit is " +
            Math.round(LIMITS.maxFileBytes / (1024 * 1024)) +
            " MB."
        )
      );
    }

    return readImageSize(blob).then((sniffed) => {
      if (sniffed && (sniffed.width > LIMITS.maxDimension || sniffed.height > LIMITS.maxDimension)) {
        return Promise.reject(
          new Error(
            "That image is " +
              sniffed.width +
              "×" +
              sniffed.height +
              ". The limit is " +
              LIMITS.maxDimension +
              "×" +
              LIMITS.maxDimension +
              "."
          )
        );
      }

      const bitmap = decodeWithBitmap(blob);
      const decoding = bitmap
        ? bitmap.then((decoded) => decoded)
        : decodeWithDataUrl(blob);

      return decoding.then((decoded) => {
        const width = decoded.width;
        const height = decoded.height;

        if (width > LIMITS.maxDimension || height > LIMITS.maxDimension) {
          return Promise.reject(
            new Error(
              "That image is " +
                width +
                "×" +
                height +
                ". The limit is " +
                LIMITS.maxDimension +
                "×" +
                LIMITS.maxDimension +
                "."
            )
          );
        }

        const base = downscale(drawToImageData(decoded, width, height), LIMITS.workingMax);
        const small = downscale(base, LIMITS.previewMax);

        if (decoded.close) decoded.close();

        state.source = {
          blob,
          name: name || "image",
          type: type || blob.type || "image/*",
          width: base.width,
          height: base.height,
          originalWidth: width,
          originalHeight: height,
          base,
          small,
          adjusted: base,
          adjustedSmall: small,
          canvas: makeCanvas(base.width, base.height),
          canvasSmall: makeCanvas(small.width, small.height),
        };

        paintCanvas(state.source.canvas, base);
        paintCanvas(state.source.canvasSmall, small);
        state.adjustedStale = false;

        R.notify();
        return state.source;
      });
    });
  };

  /* Releases the session image completely: the source pane goes blank and
     the photo is deleted from IndexedDB. It does not touch the artwork. */
  R.clear = function clear() {
    state.source = null;
    state.adjust = Q.defaultAdjust();
    state.adjustedStale = false;
    if (VP.storage && VP.storage.deletePhoto) VP.storage.deletePhoto();
    R.notify();
  };

  R.notify = function notify() {
    if (state.onChange) state.onChange();
  };

  /* --- the adjustments ------------------------------------------------------------ */

  /* Sets the source adjustments. `fast` computes them on the reduced copy,
     which is what makes the live preview possible; the full-resolution pass
     runs when the control settles. */
  R.setAdjust = function setAdjust(partial, fast) {
    state.adjust = Object.assign({}, state.adjust, partial || {});
    if (!state.source) return;

    if (fast) {
      /* The reduced copy only. The full-resolution image keeps the last
         settled adjustment, so the pane does not flicker while a slider
         is moving. It is brought up to date by commitAdjust() when the
         control settles. */
      state.source.adjustedSmall = Q.applyAdjustments(state.source.small, state.adjust);
      paintCanvas(state.source.canvasSmall, state.source.adjustedSmall);
      state.adjustedStale = true;
    } else {
      state.source.adjusted = Q.applyAdjustments(state.source.base, state.adjust);
      paintCanvas(state.source.canvas, state.source.adjusted);
      state.source.adjustedSmall = Q.applyAdjustments(state.source.small, state.adjust);
      paintCanvas(state.source.canvasSmall, state.source.adjustedSmall);
      state.adjustedStale = false;
    }

    R.notify();
  };

  /* Brings the full-resolution copy up to date with the current adjustment.

     This is what the settle calls. Without it the full-resolution pass
     renders the *last settled* adjustment — stale, and wrong — while the
     control is still being moved. The settle must not wait for a `change`
     event either, because a control can be left without one: a drag that
     ends off the track, a value set from the keyboard, a reset button.
     Whichever way the value changed, the settle renders what is current. */
  R.commitAdjust = function commitAdjust() {
    if (!state.source || !state.adjustedStale) return false;
    state.source.adjusted = Q.applyAdjustments(state.source.base, state.adjust);
    paintCanvas(state.source.canvas, state.source.adjusted);
    state.adjustedStale = false;
    return true;
  };

  R.resetAdjust = function resetAdjust() {
    state.adjust = Q.defaultAdjust();
    R.setAdjust({}, false);
  };

  R.autoLevels = function autoLevels() {
    if (!state.source) return null;
    const levels = Q.autoLevels(state.source.base);
    if (!levels) return null;
    /* The black and white sliders can only show 0–40% and 60–100%. An
       auto-level outside that would leave the slider and the state
       disagreeing — the thumb pinned at an end while the readout said
       something else — so the result is clamped to what the controls can
       actually represent. */
    const black = Math.min(0.4, Math.max(0, levels.black));
    const white = Math.min(1, Math.max(0.6, levels.white));
    R.setAdjust({ black, white }, false);
    return { black, white };
  };

  /* The image the workspace should draw: a canvas, because ImageData is not
     a drawImage source in every browser. */
  R.sourceCanvas = function sourceCanvas() {
    return state.source ? state.source.canvas : null;
  };

  /* The adjusted pixels, for the sampler. */
  R.adjustedImage = function adjustedImage() {
    return state.source ? state.source.adjusted : null;
  };

  /* --- the underlay is gone -----------------------------------------------------------------

     The photo is shown in the source pane, beside the grid, and nowhere else.
     There is no underlay on the canvas, no overdraw on top of it, no opacity
     and no fit mode: the grid decides what is converted, and the pane decides
     how the photo is magnified to line up with it. */
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
