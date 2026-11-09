/* ==========================================================================
   VoidPixelatr — io.js
   --------------------------------------------------------------------------
   Import and export.

   PNG export is a nearest-neighbour upscale of the artwork with the
   reference left out — the photo is an input, not art. The scale is capped at
   4096x4096, because an 8192² canvas is 268 MB of backing store and will
   fail on modest hardware; the option is disabled in the UI instead.

   Downloads go out as `data:` URLs. `URL.createObjectURL` is deliberately not
   used anywhere in this app: the shared CSP's `img-src` has no `blob:`, and
   the no-upload guarantee in the spec rules it out by name.

   The exported files are named after THIS project — `voidpixelatr-<w>x<h>...`.
   The project file *format* is a different thing and stays `voidpixlr`:
   it names the format, not the app, and it is what lets a conversion made
   here open in VoidPixlr and an artwork made there open here. The two must
   not be changed together.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = VP.quantise;
  const IO = (VP.io = {});

  const MAX_EXPORT = 4096;

  IO.MAX_EXPORT = MAX_EXPORT;

  /* The export scales a canvas of any shape, so the limit is on the larger
     edge: that is the axis that decides how big the backing store gets. */
  IO.scales = function scales(width, height) {
    const longest = Math.max(width, height === undefined ? width : height);
    return [1, 4, 8, 16, 32].filter((scale) => longest * scale <= MAX_EXPORT);
  };

  IO.scaleAllowed = function scaleAllowed(width, height, scale) {
    const longest = Math.max(width, height === undefined ? width : height);
    return longest * scale <= MAX_EXPORT;
  };

  /* --- downloading ---------------------------------------------------------- */

  function triggerDownload(href, filename) {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  IO.downloadText = function downloadText(text, filename, mime) {
    const href =
      "data:" + (mime || "application/json") + ";charset=utf-8," + encodeURIComponent(text);
    triggerDownload(href, filename);
  };

  /* --- the artwork canvas ---------------------------------------------------- */

  /* Builds a width x height canvas holding the artwork: the palette colours,
     transparent where nothing is drawn. */
  IO.artCanvas = function artCanvas(width, height, palette, grid) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width, height);

    for (let i = 0; i < grid.length; i += 1) {
      const index = grid[i];
      if (index < 0) continue;
      const hex = palette[index];
      if (!hex) continue;
      context.fillStyle = hex;
      context.fillRect(i % width, Math.floor(i / width), 1, 1);
    }

    return canvas;
  };

  /* --- PNG ---------------------------------------------------------------------- */

  /* Renders the artwork at `scale` and downloads it. `background` is null for
     transparent, or a hex string for a solid one. */
  IO.exportPNG = function exportPNG(width, height, palette, grid, scale, background) {
    const art = IO.artCanvas(width, height, palette, grid);
    const targetWidth = Math.min(MAX_EXPORT, width * scale);
    const targetHeight = Math.min(MAX_EXPORT, height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;

    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, targetWidth, targetHeight);
    }

    context.drawImage(art, 0, 0, targetWidth, targetHeight);

    let href;
    try {
      href = canvas.toDataURL("image/png");
    } catch (error) {
      return { ok: false, error: "the image was too large to export" };
    }

    triggerDownload(href, "voidpixelatr-" + width + "x" + height + "-" + scale + "x.png");
    return { ok: true };
  };

  /* Copies the PNG to the clipboard. On a plain-http LAN address there is no
     secure context, so `navigator.clipboard` is undefined — the action falls
     back to a download. It never dead-ends. */
  IO.copyPNG = function copyPNG(width, height, palette, grid, scale, background) {
    const art = IO.artCanvas(width, height, palette, grid);
    const targetWidth = Math.min(MAX_EXPORT, width * scale);
    const targetHeight = Math.min(MAX_EXPORT, height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, targetWidth, targetHeight);
    }
    context.drawImage(art, 0, 0, targetWidth, targetHeight);

    const canCopy =
      root.navigator &&
      root.navigator.clipboard &&
      typeof root.ClipboardItem === "function" &&
      typeof root.isSecureContext !== "undefined" &&
      root.isSecureContext;

    if (!canCopy) {
      let href;
      try {
        href = canvas.toDataURL("image/png");
      } catch (error) {
        return Promise.resolve({ ok: false, mode: "error", error: "too large" });
      }
      triggerDownload(href, "voidpixelatr-" + width + "x" + height + "-" + scale + "x.png");
      return Promise.resolve({ ok: true, mode: "download" });
    }

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve({ ok: false, mode: "error", error: "encode failed" });
          return;
        }
        const item = new root.ClipboardItem({ "image/png": blob });
        root.navigator.clipboard
          .write([item])
          .then(() => resolve({ ok: true, mode: "clipboard" }))
          .catch(() => {
            /* The clipboard can still refuse (permission, focus). Fall back to
               a download rather than showing a dead button. */
            const reader = new root.FileReader();
            reader.onload = () => {
              triggerDownload(
                reader.result,
                "voidpixelatr-" + width + "x" + height + "-" + scale + "x.png"
              );
              resolve({ ok: true, mode: "download" });
            };
            reader.onerror = () =>
              resolve({ ok: false, mode: "error", error: "copy failed" });
            reader.readAsDataURL(blob);
          });
      }, "image/png");
    });
  };

  IO.canCopy = function canCopy() {
    return !!(
      root.navigator &&
      root.navigator.clipboard &&
      typeof root.ClipboardItem === "function" &&
      root.isSecureContext
    );
  };

  /* --- JSON ---------------------------------------------------------------------- */

  IO.exportJSON = function exportJSON(width, height, palette, grid) {
    const project = Q.buildProject(width, height, palette, grid);
    IO.downloadText(
      JSON.stringify(project),
      "voidpixelatr-" + width + "x" + height + ".json",
      "application/json"
    );
    return project;
  };

  IO.readTextFile = function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onerror = () => reject(new Error("read failed"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file);
    });
  };

  /* Reads and validates a project file. A file with no `format` key is a v1
     file; its palette is adopted as-is. */
  IO.importJSON = function importJSON(file) {
    return IO.readTextFile(file).then((text) => {
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        return { ok: false, error: "that file is not valid JSON" };
      }
      const result = Q.validateProject(data);
      if (!result.ok) return { ok: false, error: "invalid file: " + result.error };
      return {
        ok: true,
        version: result.version,
        isV2: result.isV2,
        width: result.width,
        height: result.height,
        palette: result.palette,
        pixels: data.pixels,
      };
    });
  };

  /* --- PNG import ----------------------------------------------------------------- */

  IO.readImageData = function readImageData(file) {
    const blob = file;
    const decoding =
      typeof root.createImageBitmap === "function"
        ? root.createImageBitmap(blob)
        : new Promise((resolve, reject) => {
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

    return decoding.then((decoded) => {
      const canvas = document.createElement("canvas");
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, decoded.width, decoded.height);
      context.drawImage(decoded, 0, 0);
      const data = context.getImageData(0, 0, decoded.width, decoded.height);
      if (decoded.close) decoded.close();
      return data;
    });
  };

  /* Snaps every pixel of an image to the nearest palette colour. Alpha below
     128 becomes an empty pixel. */
  IO.snapToPalette = function snapToPalette(imageData, palette) {
    const paletteRgb = Q.buildPaletteRgb(palette);
    const width = imageData.width;
    const height = imageData.height;
    const grid = new Int8Array(width * height);

    for (let i = 0; i < width * height; i += 1) {
      const offset = i * 4;
      if (imageData.data[offset + 3] < 128) {
        grid[i] = -1;
        continue;
      }
      grid[i] = Q.nearestIndex(
        imageData.data[offset],
        imageData.data[offset + 1],
        imageData.data[offset + 2],
        paletteRgb
      );
    }

    return grid;
  };

  /* An ImageData is not a drawImage source in every browser, so it is
     painted into a canvas first and the canvas is what gets scaled. */
  function imageDataCanvas(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  /* Scales an image to an exact size, nearest-neighbour, so it stays crisp. */
  IO.scaleImageData = function scaleImageData(imageData, width, height) {
    const source = imageDataCanvas(imageData);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  };

  /* Crops from the top-left to an exact size. */
  IO.cropImageData = function cropImageData(imageData, width, height) {
    const source = imageDataCanvas(imageData);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(
      source,
      0,
      0,
      Math.min(width, imageData.width),
      Math.min(height, imageData.height),
      0,
      0,
      width,
      height
    );
    return context.getImageData(0, 0, width, height);
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
