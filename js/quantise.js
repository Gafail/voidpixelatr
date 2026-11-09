/* ==========================================================================
   VoidPixelatr — quantise.js
   --------------------------------------------------------------------------
   The pure algorithm layer. No DOM, no globals beyond `VP`, no side effects.

   Everything here is directly unit-testable in Node, which is why the house
   test suite can cover the interesting parts of the app without a browser:

     · colour conversion        hex <-> rgb <-> hsl
     · nearest-colour matching  sRGB Euclidean, ties to the lower index
     · palette remapping        exact hex first, nearest colour second
     · the palette generator    median cut -> Lloyd refinement -> luminance sort
     · palette transformation   saturation / brightness / contrast / hue /
                                posterise, plus de-duplication
     · source adjustments       levels -> brightness -> contrast -> saturation
                                -> hue -> greyscale
     · grid sampling            area average and nearest
     · the four match methods   flat, Bayer 8x8, Floyd-Steinberg, clustered
     · the grid serialiser      one character per cell, and back again

   Loaded as a plain <script> (no modules, no build step) and attached to the
   single `VP` namespace.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = (VP.quantise = {});

  /* --- constants ---------------------------------------------------------- */

  const HEX_RE = /^#[0-9a-f]{6}$/;

  /* The 8x8 ordered-dither threshold matrix. Values run 0..63; the classic
     Bayer construction puts the smallest offsets at the top-left and the
     largest at the bottom-right. */
  const BAYER_8 = [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ];

  /* A cell whose pixels average to less than this alpha is treated as empty. */
  const EMPTY_ALPHA = 0.5;

  /* --- small helpers ------------------------------------------------------ */

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  function isHex(value) {
    return typeof value === "string" && HEX_RE.test(value.trim().toLowerCase());
  }

  Q.isHex = isHex;
  Q.BAYER_8 = BAYER_8;

  /* --- colour ------------------------------------------------------------- */

  /* Normalises `#RRGGBB` to lowercase. Returns null for anything else —
     no 3-digit shorthand, no alpha. */
  Q.normaliseHex = function normaliseHex(input) {
    if (typeof input !== "string") return null;
    let value = input.trim().toLowerCase();
    if (!value.startsWith("#")) value = "#" + value;
    if (!HEX_RE.test(value)) return null;
    return value;
  };

  Q.hexToRgb = function hexToRgb(hex) {
    const value = Q.normaliseHex(hex);
    if (!value) return null;
    return [
      parseInt(value.slice(1, 3), 16),
      parseInt(value.slice(3, 5), 16),
      parseInt(value.slice(5, 7), 16),
    ];
  };

  Q.rgbToHex = function rgbToHex(r, g, b) {
    const part = (v) => {
      const n = clamp(Math.round(v), 0, 255);
      return n.toString(16).padStart(2, "0");
    };
    return "#" + part(r) + part(g) + part(b);
  };

  /* Relative luminance of an sRGB triple, 0..1. Used for sorting palettes
     and for the levels / brightness / contrast maths. */
  Q.luminance = function luminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  Q.rgbToHsl = function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;

    if (d === 0) return [0, 0, l];

    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;

    return [h, s, l];
  };

  Q.hslToRgb = function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360;
    const sat = clamp(s, 0, 1);
    const lig = clamp(l, 0, 1);

    if (sat === 0) {
      const v = Math.round(lig * 255);
      return [v, v, v];
    }

    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let rgb;

    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];

    const m = lig - c / 2;
    return [
      Math.round((rgb[0] + m) * 255),
      Math.round((rgb[1] + m) * 255),
      Math.round((rgb[2] + m) * 255),
    ];
  };

  /* Quantises each channel of a colour to `levels` steps. */
  Q.posterise = function posterise(r, g, b, levels) {
    const n = Math.max(2, Math.round(levels));
    const step = 255 / (n - 1);
    const q = (v) => clamp(Math.round(Math.round(v / step) * step), 0, 255);
    return [q(r), q(g), q(b)];
  };

  /* --- palettes as flat arrays ------------------------------------------- */

  /* Flattens a palette of hex strings into a Float32Array of RGB triplets.
     The matcher walks this, so the inner loop stays cache-friendly. */
  Q.buildPaletteRgb = function buildPaletteRgb(colours) {
    const out = new Float32Array(colours.length * 3);
    for (let i = 0; i < colours.length; i += 1) {
      const rgb = Q.hexToRgb(colours[i]) || [0, 0, 0];
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
    return out;
  };

  /* sRGB Euclidean distance to the nearest palette colour. Ties resolve to
     the lower index, because the comparison is strict. */
  Q.nearestIndex = function nearestIndex(r, g, b, paletteRgb) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0, n = paletteRgb.length / 3; i < n; i += 1) {
      const dr = r - paletteRgb[i * 3];
      const dg = g - paletteRgb[i * 3 + 1];
      const db = b - paletteRgb[i * 3 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  /* The mean distance from each palette colour to its nearest neighbour.
     Used to scale the dither strength so a dither is visible but not noisy. */
  Q.averageSpacing = function averageSpacing(paletteRgb) {
    const n = paletteRgb.length / 3;
    if (n < 2) return 0;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      let nearest = Infinity;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const dr = paletteRgb[i * 3] - paletteRgb[j * 3];
        const dg = paletteRgb[i * 3 + 1] - paletteRgb[j * 3 + 1];
        const db = paletteRgb[i * 3 + 2] - paletteRgb[j * 3 + 2];
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);
        if (distance < nearest) nearest = distance;
      }
      total += nearest;
    }
    return total / n;
  };

  /* Re-indexes a grid onto a new palette. Exact hex matches are preserved
     perfectly; anything else snaps to the nearest colour. */
  Q.remapGrid = function remapGrid(grid, fromColours, toColours) {
    const exact = new Map();
    for (let i = 0; i < toColours.length; i += 1) {
      const hex = Q.normaliseHex(toColours[i]);
      if (hex && !exact.has(hex)) exact.set(hex, i);
    }
    const toRgb = Q.buildPaletteRgb(toColours);
    const out = new Int8Array(grid.length);

    for (let i = 0; i < grid.length; i += 1) {
      const value = grid[i];
      if (value < 0) {
        out[i] = -1;
        continue;
      }
      const hex = Q.normaliseHex(fromColours[value]);
      if (hex && exact.has(hex)) {
        out[i] = exact.get(hex);
        continue;
      }
      const rgb = Q.hexToRgb(hex) || [0, 0, 0];
      out[i] = Q.nearestIndex(rgb[0], rgb[1], rgb[2], toRgb);
    }

    return out;
  };

  /* --- the palette generator (median cut + Lloyd) ------------------------- */

  function boxBounds(pixels, indices) {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (let k = 0; k < indices.length; k += 1) {
      const p = pixels[indices[k] * 3];
      const g = pixels[indices[k] * 3 + 1];
      const b = pixels[indices[k] * 3 + 2];
      if (p < rMin) rMin = p;
      if (p > rMax) rMax = p;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    return { rMin, rMax, gMin, gMax, bMin, bMax };
  }

  /* Splits one box along its widest channel at the median of that channel.
     The sort is stable, so equal channel values keep their original order
     and the result is deterministic. */
  function splitBox(box) {
    const bounds = boxBounds(box.pixels, box.indices);
    const ranges = [
      bounds.rMax - bounds.rMin,
      bounds.gMax - bounds.gMin,
      bounds.bMax - bounds.bMin,
    ];

    let channel = 0;
    if (ranges[1] > ranges[channel]) channel = 1;
    if (ranges[2] > ranges[channel]) channel = 2;
    if (ranges[channel] <= 0) return null;

    const order = box.indices.slice();
    order.sort((a, b) => {
      const av = box.pixels[a * 3 + channel];
      const bv = box.pixels[b * 3 + channel];
      if (av !== bv) return av - bv;
      /* Break ties on the remaining channels, then the original order, so the
         split point never depends on the input order of equal values. */
      for (let c = 0; c < 3; c += 1) {
        if (c === channel) continue;
        const ac = box.pixels[a * 3 + c];
        const bc = box.pixels[b * 3 + c];
        if (ac !== bc) return ac - bc;
      }
      return a - b;
    });

    const middle = Math.floor(order.length / 2);
    if (middle <= 0 || middle >= order.length) return null;

    return [
      { pixels: box.pixels, indices: order.slice(0, middle) },
      { pixels: box.pixels, indices: order.slice(middle) },
    ];
  }

  function averageBox(box) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < box.indices.length; k += 1) {
      r += box.pixels[box.indices[k] * 3];
      g += box.pixels[box.indices[k] * 3 + 1];
      b += box.pixels[box.indices[k] * 3 + 2];
    }
    const n = box.indices.length || 1;
    return [r / n, g / n, b / n];
  }

  /* Median cut to `k` boxes, then the mean colour of each box. */
  Q.medianCut = function medianCut(pixels, count, k) {
    const indices = [];
    for (let i = 0; i < pixels.length / 3; i += 1) indices.push(i);

    if (!indices.length) return [];

    let boxes = [{ pixels, indices }];
    while (boxes.length < k) {
      let target = -1;
      let widest = 0;
      let widestRange = 0;

      for (let i = 0; i < boxes.length; i += 1) {
        const bounds = boxBounds(pixels, boxes[i].indices);
        const range = Math.max(
          bounds.rMax - bounds.rMin,
          bounds.gMax - bounds.gMin,
          bounds.bMax - bounds.bMin
        );
        if (range > widestRange && boxes[i].indices.length > 1) {
          widestRange = range;
          widest = i;
        }
      }

      /* Nothing left to split — the image has fewer distinct colours than k. */
      if (widest < 0) break;

      const halves = splitBox(boxes[widest]);
      if (!halves) break;

      boxes = boxes.slice(0, widest).concat(halves, boxes.slice(widest + 1));
    }

    return boxes.map(averageBox);
  };

  /* Lloyd's algorithm: assign every pixel to the nearest centroid, then move
     each centroid to the mean of its members. Empty clusters keep their old
     centroid, which keeps the result deterministic. */
  Q.lloydRefine = function lloydRefine(pixels, centroids, iterations) {
    const rounds = iterations === undefined ? 8 : iterations;
    let current = centroids.map((c) => c.slice());

    for (let round = 0; round < rounds; round += 1) {
      const sums = current.map(() => [0, 0, 0, 0]);

      for (let i = 0; i < pixels.length / 3; i += 1) {
        const r = pixels[i * 3];
        const g = pixels[i * 3 + 1];
        const b = pixels[i * 3 + 2];
        let best = -1;
        let bestDistance = Infinity;
        for (let c = 0; c < current.length; c += 1) {
          const dr = r - current[c][0];
          const dg = g - current[c][1];
          const db = b - current[c][2];
          const distance = dr * dr + dg * dg + db * db;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = c;
          }
        }
        if (best < 0) continue;
        sums[best][0] += r;
        sums[best][1] += g;
        sums[best][2] += b;
        sums[best][3] += 1;
      }

      current = current.map((centroid, index) => {
        const sum = sums[index];
        if (sum[3] === 0) return centroid;
        return [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
      });
    }

    return current;
  };

  /* The full generator: median cut, Lloyd refinement, de-duplication, and a
     luminance sort. Deterministic — the same input always gives the same
     output, byte for byte. */
  Q.generatePalette = function generatePalette(pixels, k) {
    if (!pixels || pixels.length < 3) return [];

    const boxes = Q.medianCut(pixels, pixels.length / 3, k);
    if (!boxes.length) return [];

    const refined = Q.lloydRefine(pixels, boxes, 8);

    /* De-duplicate: two clusters can land on the same colour when the image
       has less variety than the requested count. */
    const unique = [];
    for (const centroid of refined) {
      const hex = Q.rgbToHex(centroid[0], centroid[1], centroid[2]);
      if (!unique.includes(hex)) unique.push(hex);
    }

    /* Sort dark -> light. Ties break by hue, then by the original order. */
    const decorated = unique.map((hex, index) => {
      const rgb = Q.hexToRgb(hex);
      const hsl = Q.rgbToHsl(rgb[0], rgb[1], rgb[2]);
      return { hex, lum: Q.luminance(rgb[0], rgb[1], rgb[2]), hue: hsl[0], index };
    });

    decorated.sort((a, b) => {
      if (a.lum !== b.lum) return a.lum - b.lum;
      if (a.hue !== b.hue) return a.hue - b.hue;
      return a.index - b.index;
    });

    return decorated.map((d) => d.hex);
  };

  /* --- palette transformation --------------------------------------------- */

  const DEFAULT_TRANSFORM = {
    saturation: 100,
    brightness: 100,
    contrast: 100,
    hue: 0,
    posterise: 0,
  };

  Q.defaultTransform = function defaultTransform() {
    return Object.assign({}, DEFAULT_TRANSFORM);
  };

  /* Applies a transform to a palette. Returns the transformed colours and the
     number that were merged away by de-duplication. */
  Q.transformPalette = function transformPalette(colours, transform) {
    const settings = Object.assign({}, DEFAULT_TRANSFORM, transform || {});
    const out = [];

    for (const hex of colours) {
      const rgb = Q.hexToRgb(hex);
      if (!rgb) continue;
      const hsl = Q.rgbToHsl(rgb[0], rgb[1], rgb[2]);

      hsl[1] = clamp(hsl[1] * (settings.saturation / 100), 0, 1);
      hsl[2] = clamp(hsl[2] * (settings.brightness / 100), 0, 1);
      hsl[2] = clamp((hsl[2] - 0.5) * (settings.contrast / 100) + 0.5, 0, 1);
      hsl[0] = hsl[0] + settings.hue;

      let result = Q.hslToRgb(hsl[0], hsl[1], hsl[2]);
      if (settings.posterise > 1) {
        result = Q.posterise(result[0], result[1], result[2], settings.posterise);
      }
      out.push(Q.rgbToHex(result[0], result[1], result[2]));
    }

    const deduped = Q.dedupeColours(out, 6);
    return { colours: deduped.colours, merged: deduped.merged, before: out.length };
  };

  /* Merges colours that sit within `tolerance` (Euclidean RGB distance) of
     one another. The first of a near-duplicate pair wins. */
  Q.dedupeColours = function dedupeColours(colours, tolerance) {
    const limit = tolerance === undefined ? 6 : tolerance;
    const kept = [];
    let merged = 0;

    for (const hex of colours) {
      const rgb = Q.hexToRgb(hex);
      if (!rgb) continue;
      let duplicate = false;
      for (const other of kept) {
        const a = Q.hexToRgb(other);
        const dr = rgb[0] - a[0];
        const dg = rgb[1] - a[1];
        const db = rgb[2] - a[2];
        if (Math.sqrt(dr * dr + dg * dg + db * db) < limit) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) merged += 1;
      else kept.push(hex);
    }

    return { colours: kept, merged };
  };

  /* Stretches the palette's lightness range across the full 0..1 span,
     preserving the relative spacing between the colours. */
  Q.normaliseLuminance = function normaliseLuminance(colours) {
    const values = colours.map((hex) => {
      const rgb = Q.hexToRgb(hex);
      return { hex, rgb, hsl: Q.rgbToHsl(rgb[0], rgb[1], rgb[2]) };
    });
    if (!values.length) return [];

    let min = Infinity;
    let max = -Infinity;
    for (const item of values) {
      if (item.hsl[2] < min) min = item.hsl[2];
      if (item.hsl[2] > max) max = item.hsl[2];
    }

    if (max - min < 1e-6) return values.map((item) => item.hex);

    return values.map((item) => {
      const l = (item.hsl[2] - min) / (max - min);
      const rgb = Q.hslToRgb(item.hsl[0], item.hsl[1], l);
      return Q.rgbToHex(rgb[0], rgb[1], rgb[2]);
    });
  };

  Q.TRANSFORM_PRESETS = {
    "sprite pop": { saturation: 135, brightness: 108, contrast: 110, hue: 0, posterise: 0 },
    muted: { saturation: 78, brightness: 100, contrast: 100, hue: 0, posterise: 0 },
    deep: { saturation: 100, brightness: 85, contrast: 125, hue: 0, posterise: 0 },
    pastel: { saturation: 70, brightness: 115, contrast: 100, hue: 0, posterise: 0 },
  };

  /* --- source adjustments -------------------------------------------------- */

  Q.defaultAdjust = function defaultAdjust() {
    return {
      black: 0,
      white: 1,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hue: 0,
      grey: false,
    };
  };

  /* Applies the source adjustments to an image, in the documented order:
     black point -> white point -> brightness -> contrast -> saturation ->
     hue shift -> greyscale.

     `image` is anything with `.data`, `.width` and `.height` — an ImageData in
     the browser, a plain object in the tests. */
  Q.applyAdjustments = function applyAdjustments(image, adjust) {
    const settings = Object.assign({}, Q.defaultAdjust(), adjust || {});
    const source = image.data;
    const out = new Uint8ClampedArray(source.length);

    const black = clamp(settings.black, 0, 1);
    const white = clamp(settings.white, 0, 1);
    const span = white - black;
    const brightness = settings.brightness;
    const contrast = settings.contrast;
    const saturation = settings.saturation;
    const hue = settings.hue;
    const grey = !!settings.grey;

    const needsHsl = saturation !== 1 || hue !== 0;
    const identity =
      black === 0 && white === 1 && brightness === 1 && contrast === 1 && !needsHsl && !grey;

    if (identity) {
      out.set(source);
      return { data: out, width: image.width, height: image.height };
    }

    for (let i = 0; i < source.length; i += 4) {
      const alpha = source[i + 3];
      if (alpha === 0) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
        continue;
      }

      let r = source[i];
      let g = source[i + 1];
      let b = source[i + 2];

      /* Levels: remap [black, white] onto [0, 1] and scale the colour so its
         hue survives the remap. */
      let lum = Q.luminance(r, g, b);
      if (span > 1e-6) {
        const target = clamp((lum - black) / span, 0, 1);
        if (lum > 1e-6) {
          const scale = target / lum;
          r = clamp(r * scale, 0, 255);
          g = clamp(g * scale, 0, 255);
          b = clamp(b * scale, 0, 255);
        } else {
          r = g = b = 0;
        }
        lum = target;
      }

      /* Brightness. */
      if (brightness !== 1) {
        const target = clamp(lum * brightness, 0, 1);
        if (lum > 1e-6) {
          const scale = target / lum;
          r = clamp(r * scale, 0, 255);
          g = clamp(g * scale, 0, 255);
          b = clamp(b * scale, 0, 255);
        } else if (target > 0) {
          r = g = b = target * 255;
        }
        lum = target;
      }

      /* Contrast. */
      if (contrast !== 1) {
        const target = clamp((lum - 0.5) * contrast + 0.5, 0, 1);
        if (lum > 1e-6) {
          const scale = target / lum;
          r = clamp(r * scale, 0, 255);
          g = clamp(g * scale, 0, 255);
          b = clamp(b * scale, 0, 255);
        }
        lum = target;
      }

      if (needsHsl) {
        const hsl = Q.rgbToHsl(r, g, b);
        hsl[1] = clamp(hsl[1] * saturation, 0, 1);
        hsl[0] = hsl[0] + hue;
        const rgb = Q.hslToRgb(hsl[0], hsl[1], hsl[2]);
        r = rgb[0];
        g = rgb[1];
        b = rgb[2];
      }

      if (grey) {
        const value = Q.luminance(r, g, b) * 255;
        r = g = b = value;
      }

      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = alpha;
    }

    return { data: out, width: image.width, height: image.height };
  };

  /* The black and white points from an image's own luminance histogram:
     the 0.5th and 99.5th percentiles. */
  Q.autoLevels = function autoLevels(image) {
    const data = image.data;
    const histogram = new Uint32Array(256);
    let total = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const lum = Math.round(Q.luminance(data[i], data[i + 1], data[i + 2]) * 255);
      histogram[lum] += 1;
      total += 1;
    }

    if (!total) return { black: 0, white: 1 };

    const lowTarget = total * 0.005;
    const highTarget = total * 0.995;
    let running = 0;
    let black = 0;
    let white = 255;

    for (let bin = 0; bin < 256; bin += 1) {
      running += histogram[bin];
      if (running >= lowTarget) {
        black = bin;
        break;
      }
    }

    running = 0;
    for (let bin = 0; bin < 256; bin += 1) {
      running += histogram[bin];
      if (running >= highTarget) {
        white = bin;
        break;
      }
    }

    if (white <= black) return { black: 0, white: 1 };

    return { black: black / 255, white: Math.min(1, (white + 1) / 255) };
  };

  /* --- grid sampling ------------------------------------------------------ */

  /* Samples the region under the grid overlay into `width` x `height` cells.

     `geometry` is the inverse of the screen transform:
       originX, originY  top-left of the overlay, in screen pixels
       cellPx            on-screen width of one cell
       cellPxY           on-screen height of one cell; defaults to cellPx
       zoom              screen pixels per source pixel
       panX, panY        screen position of the source's top-left pixel

     `method` is "average" (a true area average) or "nearest" (one sample at
     the cell centre).

     The grid is not necessarily square, so the cell's width and height are
     separate numbers: a reduced-quality pass halves both axes, and a
     rectangular grid halves them by different amounts. */
  Q.sampleGrid = function sampleGrid(source, width, height, geometry, method) {
    const cells = new Float32Array(width * height * 3);
    const alpha = new Float32Array(width * height);
    const data = source.data;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const { originX, originY, cellPx, zoom, panX, panY } = geometry;
    const cellPxY = geometry.cellPxY === undefined ? cellPx : geometry.cellPxY;
    const nearest = method === "nearest";

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const cell = row * width + col;

        const sx0 = originX + col * cellPx;
        const sy0 = originY + row * cellPxY;
        const x0 = (sx0 - panX) / zoom;
        const y0 = (sy0 - panY) / zoom;
        const x1 = (sx0 + cellPx - panX) / zoom;
        const y1 = (sy0 + cellPxY - panY) / zoom;

        if (nearest) {
          const ix = Math.floor((sx0 + cellPx / 2 - panX) / zoom);
          const iy = Math.floor((sy0 + cellPxY / 2 - panY) / zoom);
          if (ix < 0 || iy < 0 || ix >= sourceWidth || iy >= sourceHeight) continue;
          const index = (iy * sourceWidth + ix) * 4;
          const a = data[index + 3] / 255;
          if (a <= 0) continue;
          cells[cell * 3] = data[index];
          cells[cell * 3 + 1] = data[index + 1];
          cells[cell * 3 + 2] = data[index + 2];
          alpha[cell] = a;
          continue;
        }

        /* Area average. Every source pixel falls in exactly one cell, so the
           whole pass touches the image once. */
        const px0 = Math.max(0, Math.floor(x0));
        const px1 = Math.min(sourceWidth, Math.ceil(x1));
        const py0 = Math.max(0, Math.floor(y0));
        const py1 = Math.min(sourceHeight, Math.ceil(y1));

        let rSum = 0, gSum = 0, bSum = 0, weight = 0, coverage = 0;

        for (let py = py0; py < py1; py += 1) {
          const overlapY = Math.min(y1, py + 1) - Math.max(y0, py);
          if (overlapY <= 0) continue;
          for (let px = px0; px < px1; px += 1) {
            const overlapX = Math.min(x1, px + 1) - Math.max(x0, px);
            if (overlapX <= 0) continue;
            const cover = overlapX * overlapY;
            coverage += cover;
            const index = (py * sourceWidth + px) * 4;
            const a = data[index + 3] / 255;
            if (a <= 0) continue;
            const w = cover * a;
            rSum += data[index] * w;
            gSum += data[index + 1] * w;
            bSum += data[index + 2] * w;
            weight += w;
          }
        }

        if (weight <= 0 || coverage <= 0) continue;

        const averageAlpha = weight / coverage;
        if (averageAlpha < EMPTY_ALPHA) continue;

        cells[cell * 3] = rSum / weight;
        cells[cell * 3 + 1] = gSum / weight;
        cells[cell * 3 + 2] = bSum / weight;
        alpha[cell] = averageAlpha;
      }
    }

    return { cells, alpha, width, height };
  };

  /* The RGB triplets of the sampled cells, as a flat array — the palette
     generator's input. Empty cells are dropped. */
  Q.sampleToPixels = function sampleToPixels(sample) {
    const out = [];
    const total = sample.width * sample.height;
    for (let i = 0; i < total; i += 1) {
      if (sample.alpha[i] <= 0) continue;
      out.push(
        sample.cells[i * 3],
        sample.cells[i * 3 + 1],
        sample.cells[i * 3 + 2]
      );
    }
    return new Float32Array(out);
  };

  /* --- matching ------------------------------------------------------------ */

  /* Flat: each cell takes the nearest palette colour. */
  Q.matchFlat = function matchFlat(sample, paletteRgb) {
    const width = sample.width;
    const height = sample.height;
    const out = new Int8Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      if (sample.alpha[i] <= 0) {
        out[i] = -1;
        continue;
      }
      out[i] = Q.nearestIndex(
        sample.cells[i * 3],
        sample.cells[i * 3 + 1],
        sample.cells[i * 3 + 2],
        paletteRgb
      );
    }
    return out;
  };

  /* Bayer 8x8: an ordered threshold offset is added before matching, so a
     gradient turns into texture instead of banding. */
  Q.matchBayer = function matchBayer(sample, paletteRgb) {
    const width = sample.width;
    const height = sample.height;
    const out = new Int8Array(width * height);
    const spacing = Q.averageSpacing(paletteRgb);
    const strength = spacing / 8;

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const cell = row * width + col;
        if (sample.alpha[cell] <= 0) {
          out[cell] = -1;
          continue;
        }
        const threshold = (BAYER_8[(row % 8) * 8 + (col % 8)] / 64 - 0.5) * 2;
        const offset = threshold * strength;
        out[cell] = Q.nearestIndex(
          clamp(sample.cells[cell * 3] + offset, 0, 255),
          clamp(sample.cells[cell * 3 + 1] + offset, 0, 255),
          clamp(sample.cells[cell * 3 + 2] + offset, 0, 255),
          paletteRgb
        );
      }
    }

    return out;
  };

  /* Floyd-Steinberg: the error from each cell is diffused to its unprocessed
     neighbours. The scan is serpentine, so the directional artefacts of a
     naive left-to-right pass do not show. */
  Q.matchFloyd = function matchFloyd(sample, paletteRgb) {
    const width = sample.width;
    const height = sample.height;
    const out = new Int8Array(width * height);
    const work = new Float32Array(sample.cells);

    for (let row = 0; row < height; row += 1) {
      const leftToRight = row % 2 === 0;
      for (let step = 0; step < width; step += 1) {
        const col = leftToRight ? step : width - 1 - step;
        const cell = row * width + col;
        if (sample.alpha[cell] <= 0) {
          out[cell] = -1;
          continue;
        }

        const r = work[cell * 3];
        const g = work[cell * 3 + 1];
        const b = work[cell * 3 + 2];
        const index = Q.nearestIndex(r, g, b, paletteRgb);
        out[cell] = index;

        const errR = r - paletteRgb[index * 3];
        const errG = g - paletteRgb[index * 3 + 1];
        const errB = b - paletteRgb[index * 3 + 2];

        const right = leftToRight ? 1 : -1;
        const push = (target, weight) => {
          if (target < 0 || target >= width) return;
          const t = row * width + target;
          if (sample.alpha[t] <= 0) return;
          work[t * 3] = clamp(work[t * 3] + errR * weight, 0, 255);
          work[t * 3 + 1] = clamp(work[t * 3 + 1] + errG * weight, 0, 255);
          work[t * 3 + 2] = clamp(work[t * 3 + 2] + errB * weight, 0, 255);
        };

        push(col + right, 7 / 16);
        push(col - right, 3 / 16);
        if (row + 1 < height) {
          const below = (row + 1) * width;
          const t = below + col;
          if (sample.alpha[t] > 0) {
            work[t * 3] = clamp(work[t * 3] + errR * (5 / 16), 0, 255);
            work[t * 3 + 1] = clamp(work[t * 3 + 1] + errG * (5 / 16), 0, 255);
            work[t * 3 + 2] = clamp(work[t * 3 + 2] + errB * (5 / 16), 0, 255);
          }
          const diag = below + col + right;
          if (diag >= 0 && diag < width * height && sample.alpha[diag] > 0) {
            work[diag * 3] = clamp(work[diag * 3] + errR * (1 / 16), 0, 255);
            work[diag * 3 + 1] = clamp(work[diag * 3 + 1] + errG * (1 / 16), 0, 255);
            work[diag * 3 + 2] = clamp(work[diag * 3 + 2] + errB * (1 / 16), 0, 255);
          }
        }
      }
    }

    return out;
  };

  /* Clustered: k-means over the cell averages, then each cluster maps to the
     nearest palette colour. Few coherent colours, flat and hand-made. */
  Q.matchClustered = function matchClustered(sample, paletteRgb) {
    const width = sample.width;
    const height = sample.height;
    /* -1 is "empty". A cell that carries no pixels must stay empty, so the
       result starts empty and only the cells that were sampled are filled. */
    const out = new Int8Array(width * height).fill(-1);
    const count = paletteRgb.length / 3;

    const pixels = [];
    const cellIndex = [];
    for (let i = 0; i < width * height; i += 1) {
      if (sample.alpha[i] <= 0) continue;
      pixels.push(sample.cells[i * 3], sample.cells[i * 3 + 1], sample.cells[i * 3 + 2]);
      cellIndex.push(i);
    }

    if (!pixels.length) return out;

    const flat = new Float32Array(pixels);
    const clusters = Q.lloydRefine(flat, Q.medianCut(flat, flat.length / 3, count), 8);

    const clusterColour = clusters.map((centroid) =>
      Q.nearestIndex(centroid[0], centroid[1], centroid[2], paletteRgb)
    );

    for (let i = 0; i < cellIndex.length; i += 1) {
      const cell = cellIndex[i];
      let best = -1;
      let bestDistance = Infinity;
      for (let c = 0; c < clusters.length; c += 1) {
        const dr = flat[i * 3] - clusters[c][0];
        const dg = flat[i * 3 + 1] - clusters[c][1];
        const db = flat[i * 3 + 2] - clusters[c][2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      out[cell] = clusterColour[best];
    }

    return out;
  };

  /* Dispatches to one of the four match methods. */
  Q.match = function match(sample, paletteRgb, method) {
    switch (method) {
      case "bayer":
        return Q.matchBayer(sample, paletteRgb);
      case "floyd":
        return Q.matchFloyd(sample, paletteRgb);
      case "clustered":
        return Q.matchClustered(sample, paletteRgb);
      default:
        return Q.matchFlat(sample, paletteRgb);
    }
  };

  /* --- the grid serialiser -------------------------------------------------- */

  /* One character per cell: `-1` becomes `.`, palette index `i` becomes the
     code point 0x100 + i. That range is printable and survives JSON without
     escapes, and it works precisely because the palette caps at 64. */
  Q.serialiseGrid = function serialiseGrid(grid) {
    let out = "";
    for (let i = 0; i < grid.length; i += 1) {
      const value = grid[i];
      out += value < 0 ? "." : String.fromCharCode(0x100 + value);
    }
    return out;
  };

  Q.deserialiseGrid = function deserialiseGrid(text, length) {
    const grid = new Int8Array(length);
    if (typeof text !== "string") return grid;
    for (let i = 0; i < grid.length && i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      grid[i] = code === 46 ? -1 : code - 0x100;
    }
    return grid;
  };

  /* --- project files -------------------------------------------------------- */

  /* The canvas sizes a project may have. The grid is a width x height pair,
     and every one of these is allowed in either direction — a 64 x 16 canvas
     is as valid as a 64 x 64 one. */
  const ALLOWED_SIZES = [16, 32, 64, 128, 256, 512];

  Q.ALLOWED_SIZES = ALLOWED_SIZES;

  /* Validates a parsed project file. A file with no `format` key is a v1
     file: same shape, older palette. A v2 file has a single `size` and is
     square; a v3 file has a `width` and a `height`. */
  Q.validateProject = function validateProject(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "not a project file" };
    }

    const isV2 = data.format === "voidpixlr";
    const version = isV2 ? data.version : 1;

    if (isV2 && version !== 2 && version !== 3) {
      return { ok: false, error: "unsupported version" };
    }

    /* A v1 or v2 file has one `size`; a v3 file has a width and a height. */
    const width = data.width === undefined ? data.size : data.width;
    const height = data.height === undefined ? data.size : data.height;

    if (!ALLOWED_SIZES.includes(width) || !ALLOWED_SIZES.includes(height)) {
      return { ok: false, error: "bad size" };
    }

    if (!Array.isArray(data.palette) || !data.palette.length) {
      return { ok: false, error: "no palette" };
    }
    if (data.palette.length > 64) {
      return { ok: false, error: "palette too large" };
    }
    for (const hex of data.palette) {
      if (!isHex(hex)) return { ok: false, error: "bad palette colour" };
    }

    if (!Array.isArray(data.pixels) || data.pixels.length !== height) {
      return { ok: false, error: "bad pixel grid" };
    }
    for (const row of data.pixels) {
      if (!Array.isArray(row) || row.length !== width) {
        return { ok: false, error: "bad pixel row" };
      }
      for (const value of row) {
        if (!Number.isInteger(value)) return { ok: false, error: "bad pixel value" };
        if (value < -1 || value >= data.palette.length) {
          return { ok: false, error: "pixel out of range" };
        }
      }
    }

    return {
      ok: true,
      version,
      isV2,
      width,
      height,
      palette: data.palette.map((hex) => Q.normaliseHex(hex)),
    };
  };

  /* Builds the export payload. The `format` and `version` keys are what make
     v1 files readable: a file without them is treated as v1. */
  Q.buildProject = function buildProject(width, height, palette, grid) {
    const pixels = [];
    for (let row = 0; row < height; row += 1) {
      const line = [];
      for (let col = 0; col < width; col += 1) line.push(grid[row * width + col]);
      pixels.push(line);
    }
    return {
      format: "voidpixlr",
      version: 3,
      width,
      height,
      palette: palette.slice(),
      pixels,
    };
  };

  /* A v1-shaped payload, for the import compatibility test. */
  Q.buildLegacyProject = function buildLegacyProject(width, height, palette, grid) {
    const project = Q.buildProject(width, height, palette, grid);
    delete project.format;
    delete project.version;
    delete project.width;
    delete project.height;
    project.size = width;
    return project;
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
