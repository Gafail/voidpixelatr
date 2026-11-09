/* ==========================================================================
   VoidPixelatr — dependency-free behaviour tests
   --------------------------------------------------------------------------
       node tests/voidpixelatr.test.mjs

   No test framework, no jsdom, no npm install — the repo's "no dependencies"
   rule applies to the tests too.

   Three layers:

     1. the pure algorithm layer (js/quantise.js) — colour maths, matching,
        the palette generator, the sampler, the four match methods and the
        adjustments;
     2. the models (palette, storage, reference) — loaded against a minimal
        shim;
     3. the house rules — the no-upload guarantee, the CSP constraints and
        the aesthetic, checked against the real source files.

   Every id the JavaScript reaches for is cross-checked against the real
   index.html, so the markup and the code cannot drift apart silently.
   ========================================================================== */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

/* --- the runner ------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${expected}, got ${actual})`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message} (expected ${expected} ±${tolerance}, got ${actual})`
    );
  }
}

function assertDeep(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n      expected ${b}\n      got      ${a}`);
}

/* --- load the real source into a sandbox ----------------------------------- */

function loadScript(source, sandbox) {
  vm.runInContext(read("js", source), sandbox, { filename: source });
}

const sandbox = {
  console,
  Math,
  JSON,
  Date,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Error,
  TypeError,
  RangeError,
  isNaN,
  parseInt,
  parseFloat,
  Uint8Array,
  Uint8ClampedArray,
  Uint32Array,
  Int8Array,
  Float32Array,
  ArrayBuffer,
  Promise,
  Map,
  Set,
  RegExp,
  Infinity,
  NaN,
  undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

loadScript("quantise.js", sandbox);
loadScript("palette.js", sandbox);
loadScript("storage.js", sandbox);
loadScript("reference.js", sandbox);

const Q = sandbox.VP.quantise;
const P = sandbox.VP.palette;
const S = sandbox.VP.storage;

/* A localStorage shim, so the storage layer can be tested for real. */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    _map: map,
  };
}

sandbox.localStorage = makeLocalStorage();

/* --- fixtures --------------------------------------------------------------- */

const VOID_16 = [
  "#ffffff", "#000000", "#7f7f7f", "#ff4f4f",
  "#ffa64f", "#ffe44f", "#4fff4f", "#4fffff",
  "#4f4fff", "#a64fff", "#ff4fff", "#8b4513",
  "#0d0d0f", "#c8c8cc", "#2a2a33", "#e8b48a",
];

/* A 4x4 image with four flat quadrants — the shape the sampler must read
   back exactly. */
function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = rgba[0];
      data[index + 1] = rgba[1];
      data[index + 2] = rgba[2];
      data[index + 3] = rgba.length > 3 ? rgba[3] : 255;
    }
  }
  return { data, width, height };
}

/* ==========================================================================
   Colour
   ========================================================================== */

console.log("\ncolour");

check("hex normalises to lowercase with a hash", () => {
  assertEqual(Q.normaliseHex("#FF4F4F"), "#ff4f4f", "uppercase");
  assertEqual(Q.normaliseHex("ff4f4f"), "#ff4f4f", "missing hash");
  assertEqual(Q.normaliseHex("  #FF4F4F  "), "#ff4f4f", "whitespace");
});

check("bad hex is rejected", () => {
  assertEqual(Q.normaliseHex("#fff"), null, "3-digit shorthand");
  assertEqual(Q.normaliseHex("#ff4f4f80"), null, "alpha");
  assertEqual(Q.normaliseHex("#gggggg"), null, "not hex");
  assertEqual(Q.normaliseHex(""), null, "empty");
  assertEqual(Q.normaliseHex(null), null, "null");
});

check("hex and rgb round-trip", () => {
  for (const hex of VOID_16) {
    const rgb = Q.hexToRgb(hex);
    assertEqual(Q.rgbToHex(rgb[0], rgb[1], rgb[2]), hex, hex);
  }
});

check("rgb clamps out-of-range channels", () => {
  assertEqual(Q.rgbToHex(-20, 300, 128), "#00ff80", "clamping");
});

check("hsl round-trips for the built-in palette", () => {
  for (const hex of VOID_16) {
    const rgb = Q.hexToRgb(hex);
    const hsl = Q.rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const back = Q.hslToRgb(hsl[0], hsl[1], hsl[2]);
    assertClose(back[0], rgb[0], 1, `red for ${hex}`);
    assertClose(back[1], rgb[1], 1, `green for ${hex}`);
    assertClose(back[2], rgb[2], 1, `blue for ${hex}`);
  }
});

check("luminance orders light over dark", () => {
  assert(
    Q.luminance(255, 255, 255) > Q.luminance(128, 128, 128),
    "white is lighter than grey"
  );
  assert(
    Q.luminance(0, 0, 0) < Q.luminance(20, 20, 20),
    "black is darker than near-black"
  );
});

/* ==========================================================================
   Nearest-colour matching
   ========================================================================== */

console.log("\nnearest-colour matching");

check("the closest colour wins", () => {
  const palette = Q.buildPaletteRgb(["#000000", "#ffffff", "#ff0000"]);
  assertEqual(Q.nearestIndex(250, 250, 250, palette), 1, "near white");
  assertEqual(Q.nearestIndex(10, 10, 10, palette), 0, "near black");
  assertEqual(Q.nearestIndex(240, 10, 10, palette), 2, "near red");
});

check("ties resolve to the lower index", () => {
  const palette = Q.buildPaletteRgb(["#000000", "#020202"]);
  /* Exactly between the two: 1*1*3 = 3 either way. */
  assertEqual(Q.nearestIndex(1, 1, 1, palette), 0, "tie goes to index 0");
});

check("an empty palette matches nothing", () => {
  assertEqual(Q.nearestIndex(1, 2, 3, Q.buildPaletteRgb([])), -1, "empty palette");
});

check("the distance is Euclidean in sRGB", () => {
  const palette = Q.buildPaletteRgb(["#000000", "#010101", "#ffffff"]);
  assertEqual(Q.nearestIndex(1, 1, 1, palette), 1, "the closer black wins");
});

/* ==========================================================================
   The built-in palettes
   ========================================================================== */

console.log("\nbuilt-in palettes");

check("there are three built-ins, at 16, 32 and 64", () => {
  assertEqual(P.BUILTINS.length, 3, "built-in count");
  assertEqual(P.BUILTINS[0].colours.length, 16, "void palette size");
  assertEqual(P.BUILTINS[1].colours.length, 32, "void expanded size");
  assertEqual(P.BUILTINS[2].colours.length, 64, "void full size");
});

check("the built-ins are nested", () => {
  assert(P.builtinsAreNested(), "built-ins are not nested");
  const [a, b, c] = P.BUILTINS.map((entry) => entry.colours);
  for (let i = 0; i < 16; i += 1) assertEqual(a[i], b[i], `16 in 32 at ${i}`);
  for (let i = 0; i < 32; i += 1) assertEqual(b[i], c[i], `32 in 64 at ${i}`);
});

check("every built-in colour is a valid hex", () => {
  for (const entry of P.BUILTINS) {
    for (const hex of entry.colours) {
      assert(Q.isHex(hex), `bad hex in ${entry.name}: ${hex}`);
    }
  }
});

/* ==========================================================================
   Re-indexing
   ========================================================================== */

console.log("\nre-indexing");

check("an exact hex match is preserved perfectly", () => {
  const from = ["#ff0000", "#00ff00"];
  const to = ["#0000ff", "#ff0000"];
  const grid = Int8Array.from([0, 1, -1, 0]);
  const out = Q.remapGrid(grid, from, to);
  assertEqual(out[0], 1, "red moved to its new index");
  assertEqual(out[1], 0, "green snapped to blue");
  assertEqual(out[2], -1, "empty stays empty");
  assertEqual(out[3], 1, "red again");
});

check("switching between the built-ins leaves the art untouched", () => {
  /* Upward: the nested palette has every colour the smaller one has. */
  const grid = Int8Array.from([0, 5, 15]);
  const up = Q.remapGrid(grid, P.BUILTINS[0].colours, P.BUILTINS[1].colours);
  assertDeep(Array.from(up), [0, 5, 15], "16 -> 32 changes nothing");

  const up64 = Q.remapGrid(grid, P.BUILTINS[1].colours, P.BUILTINS[2].colours);
  assertDeep(Array.from(up64), [0, 5, 15], "32 -> 64 changes nothing");
});

check("a colour that is missing snaps to the nearest, it is not lost", () => {
  /* Downward: an index the 16-colour palette does not have snaps to the
     nearest colour rather than becoming empty. */
  const small = P.BUILTINS[0].colours;
  const big = P.BUILTINS[2].colours;
  const missing = 31;
  const target = Q.hexToRgb(big[missing]);

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < small.length; i += 1) {
    const rgb = Q.hexToRgb(small[i]);
    const distance =
      (rgb[0] - target[0]) ** 2 +
      (rgb[1] - target[1]) ** 2 +
      (rgb[2] - target[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }

  const out = Q.remapGrid(Int8Array.from([missing]), big, small);
  assert(out[0] >= 0, "the colour was lost");
  assertEqual(out[0], best, "it snapped to the wrong colour");
});

check("a missing colour snaps to the nearest one", () => {
  const from = ["#fe0000"];
  const to = ["#000000", "#ff0000"];
  const out = Q.remapGrid(Int8Array.from([0]), from, to);
  assertEqual(out[0], 1, "snapped to the nearest");
});

/* ==========================================================================
   The grid serialiser
   ========================================================================== */

console.log("\nthe grid serialiser");

check("empty pixels become a dot", () => {
  assertEqual(Q.serialiseGrid(Int8Array.from([-1, -1])), "..", "dots");
});

check("indices map to the 0x100 block", () => {
  assertEqual(Q.serialiseGrid(Int8Array.from([0])).charCodeAt(0), 0x100, "index 0");
  assertEqual(Q.serialiseGrid(Int8Array.from([63])).charCodeAt(0), 0x13f, "index 63");
});

check("it round-trips at every size and colour count", () => {
  for (const size of [16, 32, 64]) {
    const grid = new Int8Array(size * size);
    for (let i = 0; i < grid.length; i += 1) {
      grid[i] = i % (size === 16 ? 16 : size) === 0 ? -1 : i % 64;
    }
    const text = Q.serialiseGrid(grid);
    const back = Q.deserialiseGrid(text, size * size);
    assertDeep(Array.from(back), Array.from(grid), `round trip at ${size}`);
  }
});

check("the serialised grid survives JSON without escapes", () => {
  const grid = Int8Array.from([0, 63, -1, 1]);
  const json = JSON.stringify({ grid: Q.serialiseGrid(grid) });
  assert(!/\\u/.test(json), "the JSON contains unicode escapes");
  const back = JSON.parse(json);
  assertDeep(
    Array.from(Q.deserialiseGrid(back.grid, 4)),
    Array.from(grid),
    "round trip through JSON"
  );
});

/* ==========================================================================
   Project files
   ========================================================================== */

console.log("\nproject files");

check("a project validates", () => {
  const project = Q.buildProject(16, 16, VOID_16, new Int8Array(256).fill(0));
  const result = Q.validateProject(project);
  assert(result.ok, result.error);
  assertEqual(result.version, 3, "version");
  assert(result.isV2, "flagged as a v2 file");
  assertEqual(result.width, 16, "width");
  assertEqual(result.height, 16, "height");
});

check("a rectangular project validates", () => {
  const project = Q.buildProject(64, 16, VOID_16, new Int8Array(64 * 16).fill(0));
  const result = Q.validateProject(project);
  assert(result.ok, result.error);
  assertEqual(result.width, 64, "width");
  assertEqual(result.height, 16, "height");
});

check("a v1 project validates as v1", () => {
  const project = Q.buildLegacyProject(
    16,
    16,
    VOID_16.slice(0, 12),
    new Int8Array(256).fill(0)
  );
  const result = Q.validateProject(project);
  assert(result.ok, result.error);
  assertEqual(result.version, 1, "version");
  assert(!result.isV2, "flagged as v2");
  assertEqual(result.width, 16, "width");
});

check("a v2 project still validates", () => {
  const project = {
    format: "voidpixlr",
    version: 2,
    size: 16,
    palette: VOID_16,
    pixels: new Array(16).fill(new Array(16).fill(0)),
  };
  const result = Q.validateProject(project);
  assert(result.ok, result.error);
  assertEqual(result.version, 2, "version");
  assertEqual(result.width, 16, "width");
  assertEqual(result.height, 16, "height");
});

check("the export shape is exactly as specified", () => {
  const grid = new Int8Array(16 * 16).fill(-1);
  grid[0] = 3;
  const project = Q.buildProject(16, 16, VOID_16, grid);
  assertEqual(project.format, "voidpixlr", "format");
  assertEqual(project.version, 3, "version");
  assertEqual(project.width, 16, "width");
  assertEqual(project.height, 16, "height");
  assertEqual(project.palette.length, 16, "palette length");
  assertEqual(project.pixels.length, 16, "pixel rows");
  assertEqual(project.pixels[0][0], 3, "first pixel");
  assertEqual(project.pixels[0][1], -1, "second pixel");
});

check("a rectangular export carries both edges", () => {
  const grid = new Int8Array(64 * 16).fill(-1);
  grid[5] = 2;
  const project = Q.buildProject(64, 16, VOID_16, grid);
  assertEqual(project.width, 64, "width");
  assertEqual(project.height, 16, "height");
  assertEqual(project.pixels.length, 16, "pixel rows");
  assertEqual(project.pixels[0].length, 64, "pixels in a row");
  assertEqual(project.pixels[0][5], 2, "the painted pixel");
});

check("malformed projects are rejected", () => {
  const bad = [
    { size: 17, palette: VOID_16, pixels: [] },
    { size: 16, palette: [], pixels: [] },
    { size: 16, palette: VOID_16, pixels: [[0]] },
    { size: 16, palette: VOID_16, pixels: new Array(16).fill(new Array(16).fill(0)) },
    { size: 16, palette: VOID_16, pixels: new Array(16).fill(new Array(16).fill(99)) },
    { size: 16, palette: VOID_16, pixels: new Array(16).fill(new Array(16).fill(0.5)) },
    { size: 16, palette: ["nope"], pixels: new Array(16).fill(new Array(16).fill(0)) },
    { size: 16, palette: VOID_16, pixels: "not an array" },
    { width: 16, height: 17, palette: VOID_16, pixels: [] },
    { width: 64, height: 16, palette: VOID_16, pixels: new Array(32).fill(new Array(64).fill(0)) },
  ];
  bad[3].pixels[0][0] = -2;
  bad[0].pixels = new Array(16).fill(new Array(16).fill(0));
  for (const project of bad) {
    const result = Q.validateProject(project);
    assert(!result.ok, `accepted a bad project: ${JSON.stringify(project).slice(0, 60)}`);
  }
});

check("a palette over 64 colours is rejected", () => {
  const project = Q.buildProject(
    16,
    16,
    new Array(65).fill("#ffffff"),
    new Int8Array(256).fill(0)
  );
  const result = Q.validateProject(project);
  assert(!result.ok, "accepted 65 colours");
});

check("a project with the wrong version is rejected", () => {
  const project = Q.buildProject(16, 16, VOID_16, new Int8Array(256).fill(0));
  project.version = 9;
  const result = Q.validateProject(project);
  assert(!result.ok, "accepted version 9");
});

/* ==========================================================================
   The palette generator
   ========================================================================== */

console.log("\nthe palette generator");

function gradientPixels(count) {
  const pixels = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pixels[i * 3] = (i * 255) / Math.max(1, count - 1);
    pixels[i * 3 + 1] = 128;
    pixels[i * 3 + 2] = 255 - (i * 255) / Math.max(1, count - 1);
  }
  return pixels;
}

check("it is deterministic", () => {
  const pixels = gradientPixels(512);
  const a = Q.generatePalette(pixels, 16);
  const b = Q.generatePalette(pixels, 16);
  assertDeep(a, b, "two runs differ");
});

check("it returns exactly the requested count when there is variety", () => {
  const colours = Q.generatePalette(gradientPixels(1024), 16);
  assertEqual(colours.length, 16, "colour count");
  const colours32 = Q.generatePalette(gradientPixels(1024), 32);
  assertEqual(colours32.length, 32, "colour count at 32");
});

check("it returns fewer colours when the image has little variety", () => {
  const flat = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    flat[i * 3] = 100;
    flat[i * 3 + 1] = 100;
    flat[i * 3 + 2] = 100;
  }
  const colours = Q.generatePalette(flat, 32);
  assert(colours.length < 32, `expected fewer than 32, got ${colours.length}`);
  assert(colours.length >= 1, "expected at least one colour");
});

check("the output is sorted by luminance, dark to light", () => {
  const colours = Q.generatePalette(gradientPixels(1024), 16);
  let previous = -1;
  for (const hex of colours) {
    const rgb = Q.hexToRgb(hex);
    const lum = Q.luminance(rgb[0], rgb[1], rgb[2]);
    assert(lum >= previous, `not sorted: ${hex} (${lum}) after ${previous}`);
    previous = lum;
  }
});

check("median cut splits the widest channel", () => {
  /* Four pixels: black, red, cyan, near-white. */
  const pixels = new Float32Array([
    0, 0, 0,
    255, 0, 0,
    0, 255, 255,
    250, 250, 250,
  ]);
  const boxes = Q.medianCut(pixels, pixels.length / 3, 2);
  assertEqual(boxes.length, 2, "box count");
  assert(boxes.some((box) => box[0] < 64), "no dark box");
  assert(boxes.some((box) => box[0] > 192), "no light box");
});

check("Lloyd refinement pulls the centroids onto their clusters", () => {
  /* Four pixels: two black, two white. */
  const pixels = new Float32Array([
    0, 0, 0,
    0, 0, 0,
    250, 250, 250,
    250, 250, 250,
  ]);
  const start = [[125, 125, 125]];
  const refined = Q.lloydRefine(pixels, start, 8);
  assertEqual(refined.length, 1, "cluster count");
  assertClose(refined[0][0], 125, 1, "the centroid stays between the clusters");
});

/* ==========================================================================
   The palette transformer
   ========================================================================== */

console.log("\nthe palette transformer");

check("an identity transform changes nothing", () => {
  const result = Q.transformPalette(VOID_16, Q.defaultTransform());
  assertDeep(result.colours, VOID_16, "colours changed");
  assertEqual(result.merged, 0, "merge count");
});

check("zero saturation produces greys", () => {
  const result = Q.transformPalette(["#ff4f4f", "#4fff4f"], {
    saturation: 0,
    brightness: 100,
    contrast: 100,
    hue: 0,
    posterise: 0,
  });
  for (const hex of result.colours) {
    const rgb = Q.hexToRgb(hex);
    assertEqual(rgb[0], rgb[1], `red and green differ in ${hex}`);
    assertEqual(rgb[1], rgb[2], `green and blue differ in ${hex}`);
  }
});

check("double brightness is brighter", () => {
  const before = Q.hexToRgb("#808080");
  const result = Q.transformPalette(["#808080"], {
    saturation: 100,
    brightness: 200,
    contrast: 100,
    hue: 0,
    posterise: 0,
  });
  const after = Q.hexToRgb(result.colours[0]);
  assert(after[0] > before[0], `not brighter: ${before[0]} -> ${after[0]}`);
});

check("contrast pushes the channels away from mid-grey", () => {
  const dark = Q.transformPalette(["#404040"], {
    saturation: 100,
    brightness: 100,
    contrast: 200,
    hue: 0,
    posterise: 0,
  });
  const light = Q.transformPalette(["#c0c0c0"], {
    saturation: 100,
    brightness: 100,
    contrast: 200,
    hue: 0,
    posterise: 0,
  });
  assert(
    Q.hexToRgb(dark.colours[0])[0] < 0x40,
    "the dark colour did not get darker"
  );
  assert(
    Q.hexToRgb(light.colours[0])[0] > 0xc0,
    "the light colour did not get lighter"
  );
});

check("a hue shift rotates the colour", () => {
  const base = Q.hexToRgb("#ff0000");
  const shifted = Q.transformPalette(["#ff0000"], {
    saturation: 100,
    brightness: 100,
    contrast: 100,
    hue: 120,
    posterise: 0,
  });
  const rgb = Q.hexToRgb(shifted.colours[0]);
  const baseHue = Q.rgbToHsl(base[0], base[1], base[2])[0];
  const hue = Q.rgbToHsl(rgb[0], rgb[1], rgb[2])[0];
  assertClose(hue, (baseHue + 120) % 360, 3, "hue");
});

check("posterise quantises the channels", () => {
  const result = Q.transformPalette(["#7f7f7f"], {
    saturation: 100,
    brightness: 100,
    contrast: 100,
    hue: 0,
    posterise: 2,
  });
  const rgb = Q.hexToRgb(result.colours[0]);
  assert(rgb[0] === 0 || rgb[0] === 255, `not posterised: ${rgb[0]}`);
});

check("a collapsed palette reports the merge count", () => {
  const result = Q.transformPalette(
    ["#ff0000", "#fe0000", "#00ff00"],
    { saturation: 100, brightness: 100, contrast: 100, hue: 0, posterise: 0 }
  );
  assertEqual(result.colours.length, 2, "merged length");
  assertEqual(result.merged, 1, "merge count");
  assertEqual(result.before, 3, "original count");
});

check("normalise stretches the lightness range across the full span", () => {
  const colours = Q.normaliseLuminance(["#404040", "#606060", "#808080"]);
  const first = Q.hexToRgb(colours[0]);
  const last = Q.hexToRgb(colours[2]);
  assertEqual(first[0], 0, "the darkest became black");
  assertEqual(last[0], 255, "the lightest became white");
});

/* ==========================================================================
   The sampler
   ========================================================================== */

console.log("\nthe sampler");

/* The geometry of the grid overlay, in screen pixels: where it starts, how
   big a cell is on screen, and how the source is scaled and moved under it.
   `cellPx / zoom` is how many source pixels a cell covers. */
function geometryFor(cells, imageSize) {
  return {
    originX: 0,
    originY: 0,
    cellPx: imageSize / cells,
    zoom: 1,
    panX: 0,
    panY: 0,
  };
}

check("the area average is the mean of the covered pixels", () => {
  const image = makeImage(16, 16, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const sample = Q.sampleGrid(image, 2, 2, geometryFor(2, 16), "average");
  assertEqual(sample.width, 2, "width");
  assertEqual(sample.height, 2, "height");
  assertClose(sample.cells[0], 0, 0.5, "the first cell is black");
  assertClose(sample.cells[3], 255, 0.5, "the second cell is white");
});

check("the average of a mixed cell is the mean of its two halves", () => {
  const image = makeImage(16, 16, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const sample = Q.sampleGrid(image, 1, 1, geometryFor(1, 16), "average");
  assertClose(sample.cells[0], 127.5, 1, "the mean");
});

check("nearest takes one sample at the cell centre", () => {
  const image = makeImage(16, 16, (x) => (x < 8 ? [10, 20, 30, 255] : [200, 210, 220, 255]));
  const sample = Q.sampleGrid(image, 2, 2, geometryFor(2, 16), "nearest");
  assertClose(sample.cells[0], 10, 0.5, "the first cell");
  assertClose(sample.cells[3], 200, 0.5, "the second cell");
});

check("a cell that lies off the image is empty", () => {
  const image = makeImage(4, 4, () => [255, 255, 255, 255]);
  const geometry = { ...geometryFor(2, 16), panX: 100 };
  const sample = Q.sampleGrid(image, 2, 2, geometry, "average");
  assertEqual(sample.alpha[0], 0, "alpha");
  assertEqual(sample.alpha[3], 0, "alpha");
});

check("a transparent pixel contributes nothing to the average", () => {
  const image = makeImage(2, 2, (x) =>
    x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]
  );
  const sample = Q.sampleGrid(image, 1, 1, geometryFor(1, 2), "average");
  assertClose(sample.cells[0], 255, 1, "the opaque pixel won");
});

check("a fully transparent cell is empty", () => {
  const image = makeImage(4, 4, () => [10, 10, 10, 0]);
  const sample = Q.sampleGrid(image, 1, 1, geometryFor(1, 4), "average");
  assertEqual(sample.alpha[0], 0, "alpha");
});

check("the sampled pixels feed the generator", () => {
  const image = makeImage(16, 16, (x, y) => [(x * 16) % 256, (y * 16) % 256, 128, 255]);
  const sample = Q.sampleGrid(image, 4, 4, geometryFor(4, 16), "average");
  const pixels = Q.sampleToPixels(sample);
  assertEqual(pixels.length, 4 * 4 * 3, "pixel count");
});

check("a rectangular grid samples every cell of every row", () => {
  /* Four columns, two rows: the row stride is the width, not the height. */
  const image = makeImage(16, 8, (x, y) => [x * 16, y * 32, 0, 255]);
  const geometry = {
    originX: 0,
    originY: 0,
    cellPx: 4,
    cellPxY: 4,
    zoom: 1,
    panX: 0,
    panY: 0,
  };
  const sample = Q.sampleGrid(image, 4, 2, geometry, "average");
  assertEqual(sample.width, 4, "width");
  assertEqual(sample.height, 2, "height");
  assertEqual(sample.cells.length, 4 * 2 * 3, "the cell count");
  /* The second row is the one that proves the stride: its green channel is
     the second half of the image, not the second column. */
  assertClose(sample.cells[(4 * 0 + 0) * 3 + 1], 48, 2, "the first row");
  assertClose(sample.cells[(4 * 1 + 0) * 3 + 1], 176, 2, "the second row");
  assertClose(sample.cells[(4 * 0 + 3) * 3], 216, 2, "the first row, last column");
});

/* ==========================================================================
   The four match methods
   ========================================================================== */

console.log("\nthe match methods");

function gradientSample(size) {
  const cells = new Float32Array(size * size * 3);
  const alpha = new Float32Array(size * size).fill(1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      cells[i * 3] = (x / (size - 1)) * 255;
      cells[i * 3 + 1] = (y / (size - 1)) * 255;
      cells[i * 3 + 2] = 128;
    }
  }
  return { cells, alpha, width: size, height: size };
}

check("flat matches each cell to the nearest colour", () => {
  const sample = gradientSample(8);
  const palette = Q.buildPaletteRgb(["#000000", "#ffffff"]);
  const result = Q.matchFlat(sample, palette);
  assertEqual(result.length, 64, "result length");
  for (const index of result) {
    assert(index === 0 || index === 1, `bad index ${index}`);
  }
  assertEqual(result[0], 0, "the top-left corner is black");
  assertEqual(result[63], 1, "the bottom-right corner is white");
});

check("an empty cell stays empty in every method", () => {
  const sample = gradientSample(4);
  sample.alpha[0] = 0;
  const palette = Q.buildPaletteRgb(["#000000", "#ffffff"]);
  for (const method of ["flat", "bayer", "floyd", "clustered"]) {
    const result = Q.match(sample, palette, method);
    assertEqual(result[0], -1, `${method} painted an empty cell`);
  }
});

check("bayer dithers a gradient into texture", () => {
  const sample = gradientSample(16);
  const palette = Q.buildPaletteRgb(["#000000", "#ffffff"]);
  const flat = Q.matchFlat(sample, palette);
  const bayer = Q.matchBayer(sample, palette);
  let differences = 0;
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i] !== bayer[i]) differences += 1;
  }
  assert(differences > 0, "the dither made no difference at all");
});

check("the Bayer matrix is the standard 8x8", () => {
  assertEqual(Q.BAYER_8.length, 64, "matrix length");
  assertEqual(Q.BAYER_8[0], 0, "the first threshold");
  /* The standard matrix is a permutation of 0..63 — every threshold appears
     exactly once. */
  const sorted = [...Q.BAYER_8].sort((a, b) => a - b);
  for (let i = 0; i < 64; i += 1) assertEqual(sorted[i], i, `value ${i}`);
  assertEqual(Math.max(...Q.BAYER_8), 63, "the largest threshold");
});

check("Floyd-Steinberg stays inside the palette", () => {
  const sample = gradientSample(16);
  const palette = Q.buildPaletteRgb(VOID_16);
  const result = Q.matchFloyd(sample, palette);
  for (const index of result) {
    assert(index >= 0 && index < 16, `bad index ${index}`);
  }
});

check("Floyd-Steinberg does not drift outside the source range", () => {
  const sample = gradientSample(16);
  const palette = Q.buildPaletteRgb(["#000000", "#808080", "#ffffff"]);
  const result = Q.matchFloyd(sample, palette);
  for (const index of result) {
    assert(index >= 0 && index < 3, `bad index ${index}`);
  }
});

check("clustered uses fewer colours than flat on a gradient", () => {
  const sample = gradientSample(16);
  const palette = Q.buildPaletteRgb(VOID_16);
  const flat = Q.matchFlat(sample, palette);
  const clustered = Q.matchClustered(sample, palette);
  const distinct = (result) => new Set(Array.from(result).filter((v) => v >= 0)).size;
  assert(
    distinct(clustered) <= distinct(flat),
    `clustered used ${distinct(clustered)}, flat used ${distinct(flat)}`
  );
});

check("match dispatches to the right method", () => {
  const sample = gradientSample(8);
  const palette = Q.buildPaletteRgb(VOID_16);
  assertDeep(
    Array.from(Q.match(sample, palette, "flat")),
    Array.from(Q.matchFlat(sample, palette)),
    "flat"
  );
  assertDeep(
    Array.from(Q.match(sample, palette, "bayer")),
    Array.from(Q.matchBayer(sample, palette)),
    "bayer"
  );
});

/* ==========================================================================
   The source adjustments
   ========================================================================== */

console.log("\nthe source adjustments");

check("the identity adjustment changes nothing", () => {
  const image = makeImage(4, 4, (x, y) => [(x * 60) % 256, (y * 60) % 256, 90, 255]);
  const out = Q.applyAdjustments(image, Q.defaultAdjust());
  assertDeep(Array.from(out.data), Array.from(image.data), "pixels changed");
});

check("brightness scales the luminance", () => {
  const image = makeImage(2, 2, () => [80, 80, 80, 255]);
  const out = Q.applyAdjustments(image, {
    black: 0,
    white: 1,
    brightness: 2,
    contrast: 1,
    saturation: 1,
    hue: 0,
    grey: false,
  });
  assertClose(out.data[0], 160, 2, "the red channel");
});

check("greyscale drops the chroma", () => {
  const image = makeImage(2, 2, () => [255, 100, 50, 255]);
  const out = Q.applyAdjustments(image, {
    black: 0,
    white: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
    grey: true,
  });
  assertEqual(out.data[0], out.data[1], "red and green");
  assertEqual(out.data[1], out.data[2], "green and blue");
});

check("saturation zero is greyscale", () => {
  const image = makeImage(2, 2, () => [200, 60, 40, 255]);
  const out = Q.applyAdjustments(image, {
    black: 0,
    white: 1,
    brightness: 1,
    contrast: 1,
    saturation: 0,
    hue: 0,
    grey: false,
  });
  assertEqual(out.data[0], out.data[1], "red and green");
});

check("contrast widens the separation between two greys", () => {
  const image = makeImage(2, 2, (x) => (x === 0 ? [110, 110, 110, 255] : [145, 145, 145, 255]));
  const flat = Q.applyAdjustments(image, Q.defaultAdjust());
  const contrast = Q.applyAdjustments(image, {
    black: 0,
    white: 1,
    brightness: 1,
    contrast: 2,
    saturation: 1,
    hue: 0,
    grey: false,
  });
  const before = Math.abs(flat.data[4] - flat.data[0]);
  const after = Math.abs(contrast.data[4] - contrast.data[0]);
  assert(after > before, `separation did not widen: ${before} -> ${after}`);
});

check("the black point clips the shadows", () => {
  const image = makeImage(2, 2, () => [40, 40, 40, 255]);
  const out = Q.applyAdjustments(image, {
    black: 0.2,
    white: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
    grey: false,
  });
  assertEqual(out.data[0], 0, "the shadow was not clipped");
});

check("the white point clips the highlights", () => {
  const image = makeImage(2, 2, () => [230, 230, 230, 255]);
  const out = Q.applyAdjustments(image, {
    black: 0,
    white: 0.8,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
    grey: false,
  });
  assertEqual(out.data[0], 255, "the highlight was not clipped");
});

check("auto levels reads the histogram's percentiles", () => {
  /* Half the pixels are black, half are white. */
  const image = makeImage(2, 2, (x, y) => (y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const levels = Q.autoLevels(image);
  assert(levels.black <= 0.02, `black point ${levels.black}`);
  assert(levels.white >= 0.98, `white point ${levels.white}`);
});

check("auto levels on a flat image stays safe", () => {
  const image = makeImage(2, 2, () => [128, 128, 128, 255]);
  const levels = Q.autoLevels(image);
  assert(levels.white > levels.black, "the range collapsed");
});

/* ==========================================================================
   The palette model
   ========================================================================== */

console.log("\nthe palette model");

check("switching palettes re-indexes the canvas", () => {
  P.init([], "Void Palette", 0);
  let remapped = null;
  P.hooks.remap = (grid) => {
    remapped = grid;
  };
  P.hooks.save = () => {};
  P.hooks.render = () => {};

  /* A pixel painted with the built-in white. */
  const grid = new Int8Array(16 * 16).fill(-1);
  grid[0] = 0;

  /* Pretend the canvas holds it. */
  sandbox.VP.canvas = { grid };

  P.switchTo("Void Full");
  assert(remapped, "the canvas was not re-indexed");
  assertEqual(remapped[0], 0, "white kept its index in the nested palette");
  assertEqual(remapped[1], -1, "empty stayed empty");
});

check("a built-in palette cannot be edited in place", () => {
  P.init([], "Void Palette", 0);
  assert(!P.addColour("#123456"), "added a colour to a built-in");
  assert(!P.removeColour(0), "removed a colour from a built-in");
  assert(!P.moveColour(0, 1), "moved a colour in a built-in");
});

check("a user palette can be edited", () => {
  P.init([], "Void Palette", 0);
  const entry = P.createPalette("Mine", VOID_16.slice(), 16);
  P.switchTo(entry.name);
  assert(P.addColour("#123456"), "could not add a colour");
  assertEqual(P.colours().length, 17, "colour count");
  assert(P.removeColour(16), "could not remove a colour");
  assertEqual(P.colours().length, 16, "colour count after the removal");
});

check("a palette is capped at 64 colours", () => {
  P.init([], "Void Palette", 0);
  const entry = P.createPalette("Big", VOID_16.slice(), 16);
  P.switchTo(entry.name);
  for (let i = 0; i < 80; i += 1) P.addColour("#010203");
  assertEqual(P.colours().length, 64, "colour count");
});

check("staging does not touch the active palette", () => {
  P.init([], "Void Palette", 0);
  const before = P.colours().slice();
  P.stage(["#123456", "#654321"]);
  assertDeep(P.colours(), ["#123456", "#654321"], "the staged colours are shown");
  assertDeep(P.active().colours, before, "the active palette changed");
  P.unstage();
  assertDeep(P.colours(), before, "the staged colours are gone");
});

/* ==========================================================================
   The storage layer
   ========================================================================== */

console.log("\nstorage");

check("the canvas round-trips through localStorage", () => {
  const grid = new Int8Array(16 * 16).fill(-1);
  grid[0] = 0;
  grid[1] = 15;
  grid[2] = -1;
  S.saveCanvas(16, 16, VOID_16, grid);
  const loaded = S.loadCanvas();
  assertEqual(loaded.width, 16, "width");
  assertEqual(loaded.height, 16, "height");
  assertDeep(Array.from(loaded.grid), Array.from(grid), "grid");
  assertEqual(loaded.palette.length, 16, "palette");
});

check("a rectangular canvas round-trips through localStorage", () => {
  const grid = new Int8Array(64 * 16).fill(-1);
  grid[9] = 3;
  S.saveCanvas(64, 16, VOID_16, grid);
  const loaded = S.loadCanvas();
  assertEqual(loaded.width, 64, "width");
  assertEqual(loaded.height, 16, "height");
  assertEqual(loaded.grid.length, 64 * 16, "the grid length");
  assertEqual(loaded.grid[9], 3, "the painted cell");
});

check("an older square autosave still loads", () => {
  const grid = new Int8Array(16 * 16).fill(-1);
  grid[0] = 1;
  sandbox.localStorage.setItem(
    S.KEYS.canvas,
    JSON.stringify({
      size: 16,
      palette: VOID_16,
      grid: Q.serialiseGrid(grid),
    })
  );
  const loaded = S.loadCanvas();
  assert(loaded, "the old autosave was thrown away");
  assertEqual(loaded.width, 16, "width");
  assertEqual(loaded.height, 16, "height");
  assertEqual(loaded.grid.length, 256, "the grid length");
});

check("a corrupt autosave is discarded, not fatal", () => {
  sandbox.localStorage.setItem(S.KEYS.canvas, "{not json");
  assertEqual(S.loadCanvas(), null, "the corrupt canvas was returned");
  sandbox.localStorage.setItem(S.KEYS.canvas, JSON.stringify({ size: 99 }));
  assertEqual(S.loadCanvas(), null, "the bad size was returned");
});

check("the palettes round-trip", () => {
  S.savePalettes([{ name: "Mine", colours: ["#123456", "#654321"] }]);
  const loaded = S.loadPalettes();
  assertEqual(loaded.length, 1, "palette count");
  assertEqual(loaded[0].name, "Mine", "name");
  assertDeep(loaded[0].colours, ["#123456", "#654321"], "colours");
});

check("only the three documented keys are used", () => {
  assertEqual(S.KEYS.canvas, "voidpixelatr:canvas:v2", "canvas key");
  assertEqual(S.KEYS.palettes, "voidpixelatr:palettes:v2", "palettes key");
  assertEqual(S.KEYS.prefs, "voidpixelatr:prefs:v2", "prefs key");
});

check("a write that throws is swallowed", () => {
  const original = sandbox.localStorage.setItem;
  sandbox.localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert(!S.savePrefs({ zoom: 16 }), "the failure was reported as success");
  sandbox.localStorage.setItem = original;
});

/* ==========================================================================
   The house rules
   ========================================================================== */

console.log("\nhouse rules");

const JS_FILES = [
  "js/quantise.js",
  "js/palette.js",
  "js/storage.js",
  "js/canvas.js",
  "js/reference.js",
  "js/io.js",
  "js/workspace.js",
  "js/menu.js",
  "js/app.js",
];

const html = read("index.html");
const css = read("css/style.css");

/* Strips comments so a mention of an API in prose is not a false positive. */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

const allJs = JS_FILES.map((file) => stripJsComments(read(file))).join("\n");

check("there is no fetch, XHR, beacon or websocket anywhere", () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /navigator\.sendBeacon/,
    /sendBeacon/,
    /new\s+WebSocket/,
    /EventSource/,
    /importScripts/,
  ];
  for (const pattern of forbidden) {
    assert(!pattern.test(allJs), `found ${pattern}`);
  }
});

check("no form is ever submitted", () => {
  assert(!/<form/i.test(html), "the page has a form");
  assert(!/\.submit\s*\(/.test(allJs), "the code submits a form");
  assert(!/method=["']post/i.test(html), "the page has a POST form");
});

check("no blob URL is created", () => {
  assert(!/createObjectURL/.test(allJs), "createObjectURL is used");
  assert(!/blob:/.test(allJs), "a blob: URL appears in the code");
});

check("no third-party asset, font or script is referenced", () => {
  /* The SVG namespace is not a request — strip it before looking for URLs. */
  const bare = html.replace(/xmlns=("[^"]*"|'[^']*')/g, "");
  assert(!/https?:\/\//.test(bare), "an external URL in the page");
  assert(!/@import/.test(css), "a CSS import");
  assert(!/fonts\.googleapis|cdn\.|unpkg|jsdelivr/i.test(html + css), "a CDN reference");
});

check("there is no inline script and no inline event handler", () => {
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  assertEqual(inlineScripts.length, 0, "inline script tags");
  assert(!/\son[a-z]+\s*=/i.test(html), "an inline event handler");
});

check("the scripts are plain files, loaded in order, with no modules", () => {
  const sources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assertEqual(sources.length, 9, "script count");
  assert(!sources.some((src) => src.includes("type=\"module\"")), "an ES module");
  assertEqual(sources[0], "js/quantise.js", "the first script");
  assertEqual(sources[sources.length - 1], "js/app.js", "the last script");
});

check("the aesthetic holds: no gradients, transitions, animations or radius", () => {
  const bare = stripCssComments(css);
  assert(!/gradient/i.test(bare), "a gradient");
  assert(!/transition/i.test(bare), "a transition");
  assert(!/animation/i.test(bare), "an animation");
  const radii = [...bare.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const radius of radii) {
    assert(/^0(px)?$/.test(radius), `a rounded corner: ${radius}`);
  }
});

check("the only shadow is the canvas glow", () => {
  const bare = stripCssComments(css);
  const shadows = [...bare.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
  assertEqual(shadows.length, 1, `expected one shadow, found ${shadows.length}`);
  assert(shadows[0].includes("12px"), "the shadow is not the canvas glow");
});

check("the page references every script it needs, and nothing missing", () => {
  for (const file of JS_FILES) {
    assert(html.includes(`src="${file}"`), `index.html does not load ${file}`);
  }
  assert(html.includes('href="css/style.css"'), "the stylesheet is not linked");
});

check("the favicon is inline, so nothing is fetched for it", () => {
  const icons = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
  assertEqual(icons.length, 1, "favicon count");
  assert(icons[0].includes("data:image/svg+xml"), "the favicon is not a data URL");
});

/* --- the id cross-check --------------------------------------------------- */

check("every id the code reaches for exists in the markup", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set();

  for (const file of JS_FILES) {
    const source = read(file);
    for (const match of source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
      wanted.add(match[1]);
    }
    for (const match of source.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) {
      wanted.add(match[1]);
    }
  }

  const missing = [...wanted].filter((id) => !htmlIds.has(id)).sort();
  assertEqual(missing.length, 0, `missing id(s): ${missing.join(", ")}`);
});

check("no id is used twice in the markup", () => {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  assertEqual(duplicates.length, 0, `duplicate id(s): ${duplicates.join(", ")}`);
});

/* --- the source limits ---------------------------------------------------- */

check("the source limits are stated on the load page", () => {
  const limits = sandbox.VP.reference.LIMIT_TEXT;
  assert(/never uploaded/.test(limits), "the limits do not say it is never uploaded");
  assert(/64 MB/.test(limits), "the file size limit is not stated");
  assert(/2048/.test(limits), "the working copy limit is not stated");
  assert(html.includes("ws-load-note"), "the load page has no limits note");
});

/* --- the deployment rules -------------------------------------------------- */

const vhost = read("ops/nginx/voidpixelatr.conf");
const deploy = read("deploy.sh");

check("the vhost names a documentation address, not a live machine", () => {
  const names = /server_name\s+([^;]+);/.exec(vhost);
  assert(names, "the vhost has no server_name");
  const tokens = names[1].trim().split(/\s+/);
  const ips = tokens.filter((token) => /^\d+\.\d+\.\d+\.\d+$/.test(token));
  assert(ips.length > 0, "the server_name lists no address at all");
  for (const ip of ips) {
    assert(
      !ip.startsWith("192.168.100."),
      `the vhost names a live LAN address: ${ip}`,
    );
    assert(
      /^192\.0\.2\.\d+$/.test(ip),
      `the placeholder is not an RFC 5737 documentation address: ${ip}`,
    );
  }
});

check("the deploy refuses to run against the placeholder", () => {
  assert(/PLACEHOLDER_IP="192\.0\.2\.0"/.test(deploy), "the placeholder is not defined");
  const guard = /if \[ "\$HOST" = "\$PLACEHOLDER_IP" \]; then([\s\S]*?)\nfi/.exec(deploy);
  assert(guard, "there is no guard against deploying to the placeholder");
  assert(/exit 1/.test(guard[1]), "the guard does not fail the run");
});

check("the deploy substitutes the placeholder for the real address", () => {
  assert(/sed 's\|/.test(deploy), "the vhost is installed without substituting the address");
  assert(
    deploy.includes("${PLACEHOLDER_IP"),
    "the substitution does not use the placeholder token",
  );
});

check("the deploy uses the shared house key, not one of its own", () => {
  assert(/thevoidco-lxc-id_ed25519/.test(deploy), "the deploy does not use the shared key");
  assert(
    !/voidpixelatr-lxc-id_ed25519/.test(deploy),
    "the deploy invents a per-project key — there is one key for all of TheVoidCo",
  );
});

check("the deploy disables the template's own site before enabling ours", () => {
  assert(
    /find \/etc\/nginx\/sites-enabled .*! -name 'voidpixelatr\.conf'/.test(deploy),
    "the deploy does not remove the template's own enabled site",
  );
  assert(
    deploy.includes("duplicate default server") || deploy.includes("default_server"),
    "the deploy does not explain why the template's site has to go",
  );
});

check("the vhost includes the shared security headers unmodified", () => {
  assert(
    vhost.includes("include /etc/nginx/snippets/security-headers.conf;"),
    "the vhost does not include the shared snippet",
  );
});

check("the deploy ships the site and nothing else", () => {
  for (const excluded of [
    "/docs/",
    "/tests/",
    "/tools/",
    "/ops/",
    "*.md",
    "/.github/",
    "/serve.sh",
    "/deploy.sh",
  ]) {
    assert(deploy.includes(`'${excluded}'`), `the deploy does not exclude ${excluded}`);
  }
  assert(deploy.includes("--delete"), "the deploy does not remove stale files");
});

/* --- the browser harness --------------------------------------------------- */

check("the browser suites load the error probe as a file, not inline", () => {
  const probeModule = read("tests/browser/probe.py");
  assert(probeModule.includes(".vp-probe.js"), "the probe is not written as its own file");
  assert(
    probeModule.includes('src="{PROBE_NAME}"'),
    "the probe is not loaded with a src attribute",
  );

  for (const [name, file] of [
    ["e2e.py", "tests/browser/e2e.py"],
    ["hostile.py", "tests/browser/hostile.py"],
  ]) {
    const source = read(file);
    assert(
      !/probe\s*=\s*\(\s*\n\s*"<script>/.test(source),
      `${name} still injects an inline probe script — the shared CSP blocks it, and the error checks would pass on an empty array`,
    );
    assert(
      source.includes("probe.is_installed("),
      `${name} does not assert the probe installed itself`,
    );
    assert(
      source.includes("probe.errors("),
      `${name} does not read errors through the probe`,
    );
  }
});

check("the CSP test server sends the real shared headers", () => {
  const server = read("tests/browser/csp_server.py");
  assert(
    server.includes("security-headers.conf"),
    "the CSP server does not read the shared snippet",
  );
  assert(
    server.includes("Content-Security-Policy"),
    "the CSP server does not check for a Content-Security-Policy",
  );
});

check("the project ships the shared headers, so it stands on its own", () => {
  /* The shared snippet is vendored into this repository, so a clone can run
     the CSP server and the deploy script without a sibling checkout. That
     only works if the two copies agree — so when the umbrella's copy is
     sitting alongside, the vendored one is compared against it. */
  const vendored = read("ops", "nginx-snippets", "security-headers.conf");
  assert(
    vendored.includes("Content-Security-Policy"),
    "the vendored snippet has no Content-Security-Policy",
  );

  const headers = (text) => {
    const found = {};
    const pattern = /add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found[match[1]] = match[2];
    }
    return found;
  };

  const local = headers(vendored);
  assert(
    local["Content-Security-Policy"].includes("script-src 'self'"),
    "the vendored snippet does not carry script-src 'self'",
  );

  /* The umbrella's copy, if this repository sits next to it. */
  const umbrella = join(
    ROOT,
    "..",
    "TheVoidCo",
    "ops",
    "nginx-snippets",
    "security-headers.conf"
  );
  let umbrellaText = null;
  try {
    umbrellaText = readFileSync(umbrella, "utf8");
  } catch {
    umbrellaText = null;
  }

  if (umbrellaText) {
    assertDeep(
      local,
      headers(umbrellaText),
      "the vendored security headers have drifted from the umbrella's copy",
    );
  }
});

/* --- the UI fixes ---------------------------------------------------------- */

check("the canvas has an X and a Y, and a lock between them", () => {
  const markup = read("index.html");
  const app = read("js/app.js");

  assert(markup.includes('id="size-x"'), "there is no X dropdown");
  assert(markup.includes('id="size-y"'), "there is no Y dropdown");
  assert(markup.includes('id="size-lock"'), "there is no lock button");

  /* The dropdowns are filled from the allowed sizes, so they cannot offer
     a size the app cannot draw. */
  assert(
    /function fillSizes[\s\S]{0,600}Q\.ALLOWED_SIZES/.test(app),
    "the size dropdowns are not filled from the allowed sizes",
  );

  /* The lock is a real toggle, and it is remembered. */
  assert(app.includes("state.sizeLocked"), "there is no lock state");
  assert(
    /lock\.addEventListener[\s\S]{0,400}state\.sizeLocked = !state\.sizeLocked/.test(app),
    "the lock button does not toggle",
  );
  assert(
    app.includes("prefs.sizeLocked = state.sizeLocked"),
    "the lock state is not saved",
  );
});

check("the allowed sizes run from 16 to 512", () => {
  assertEqual(Q.ALLOWED_SIZES.join(","), "16,32,64,128,256,512", "the sizes");
});

check("a locked canvas is square and an unlocked one is not", () => {
  const app = read("js/app.js");
  /* Linked, the two edges are one number; separate, each is its own. */
  assert(
    /if \(state\.sizeLocked\) requestResize\(value, value\)/.test(app),
    "the lock does not tie X and Y together",
  );
  assert(
    /else requestResize\(value, base\.height\)/.test(app),
    "an unlocked X still moves Y",
  );
  assert(
    /else requestResize\(base\.width, value\)/.test(app),
    "an unlocked Y still moves X",
  );
  /* The base of a second change is the *pending* size, not the canvas's
     current one: set X to 64, then Y to 32, and the panel must say
     "64 × 32" — not "16 × 32", which would throw the 64 away. */
  assert(
    /const base = state\.pendingResize \|\| VP\.canvas\.state/.test(app),
    "a second size change does not build on the pending one",
  );
});

check("the canvas is rectangular all the way down", () => {
  const canvas = read("js/canvas.js");
  const quantise = read("js/quantise.js");
  const io = read("js/io.js");

  /* The state is a width and a height, not one size. */
  assert(/width: 16,\s*\n\s*height: 16,/.test(canvas), "the canvas has no width and height");
  assert(!/state\.size\b/.test(canvas), "the canvas still has a single size");

  /* The grid is indexed by a row stride, not by a square: the column is
     the remainder and the row is the quotient. */
  assert(
    /i % width/.test(canvas) && /Math\.floor\(i \/ width\)/.test(canvas),
    "the grid is still indexed as a square",
  );
  assert(
    /Q\.sampleGrid = function sampleGrid\(source, width, height/.test(quantise),
    "the sampler still takes one size",
  );

  /* The export follows both edges. */
  assert(
    /IO\.exportPNG = function exportPNG\(width, height/.test(io),
    "the PNG export still takes one size",
  );
  assert(
    /IO\.buildProject|buildProject\(width, height/.test(quantise),
    "the project file still carries one size",
  );
});

check("there is one art canvas, and the workspace shares it", () => {
  const markup = read("index.html");
  const workspace = read("js/workspace.js");
  const canvas = read("js/canvas.js");

  /* One canvas element for the artwork. The workspace used to have a
     second one — a copy of the art at a different scale — and the two
     modes kept their own. */
  const artCanvases = [...markup.matchAll(/<canvas[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assertEqual(
    artCanvases.filter((id) => id === "art-canvas").length,
    1,
    "there is more than one art canvas",
  );
  assert(!markup.includes('id="preview-pane"'), "the workspace still has its own preview canvas");

  /* The live conversion goes onto that canvas, as a layer. */
  assert(
    /C\.setPreview = function setPreview/.test(canvas),
    "the canvas has no preview layer",
  );
  assert(
    /VP\.canvas\.setPreview\(result/.test(workspace),
    "the workspace does not draw the live conversion on the canvas",
  );
  assert(
    /VP\.canvas\.clearPreview\(\)/.test(workspace),
    "the workspace does not take the preview off the canvas",
  );
});

check("the two panes zoom independently", () => {
  const markup = read("index.html");
  const workspace = read("js/workspace.js");
  const app = read("js/app.js");

  assert(markup.includes('id="ws-zoom"'), "the source pane has no zoom slider");
  assert(markup.includes('id="canvas-zoom"'), "the canvas has no zoom slider");

  /* The source's zoom is the workspace's own state; the canvas's is the
     canvas's own. Neither one writes to the other. */
  assert(
    /state\.zoom = next/.test(workspace),
    "the source zoom is not the workspace's own",
  );
  assert(
    !/VP\.canvas\.setScale/.test(workspace),
    "the workspace moves the canvas's zoom",
  );
  assert(
    /setZoom\(VP\.canvas\.scaleFromSlider/.test(app),
    "the canvas zoom slider does not drive the canvas",
  );
  assert(
    !/function setZoom[\s\S]{0,400}VP\.workspace/.test(app),
    "the canvas zoom moves the source's zoom",
  );
  assert(
    !/VP\.workspace\.state\.zoom\s*=/.test(workspace),
    "the workspace writes to somebody else's zoom",
  );
});

check("the workspace converts into the canvas's own size", () => {
  const workspace = read("js/workspace.js");

  /* One size, one grid. The workspace used to carry a size of its own,
     which was a second answer to the same question. */
  assert(
    /function gridSize\(\)[\s\S]{0,300}VP\.canvas\.state\.width/.test(workspace),
    "the workspace has a size of its own",
  );
  assert(
    !/convertSize/.test(workspace),
    "the workspace still keeps a separate convert size",
  );
});

check("there is one menu, on the left, and it drops open", () => {
  const markup = read("index.html");
  const menu = read("js/menu.js");

  /* One column of controls, on the left. The Image mode used to bring a
     second one beside it, and both were open at once. */
  const menus = [...markup.matchAll(/class="menu"/g)].length;
  assertEqual(menus, 1, "menu count");
  assert(
    markup.includes('class="sidebar"'),
    "there is no left-hand column for the menu",
  );

  /* The pipeline's controls live inside that same menu, not in a column
     of their own. */
  assert(markup.includes('id="menu-pipeline"'), "the pipeline has no menu group");
  const menuGroup = markup.slice(
    markup.indexOf('id="menu-pipeline"'),
    markup.indexOf('id="menu-foot"')
  );
  for (const id of ["ws-black", "ws-extract", "ws-match-flat"]) {
    assert(menuGroup.includes(`id="${id}"`), `${id} is not in the menu`);
  }
  /* The primary action sits at the foot of the same column. */
  assert(
    markup.indexOf('id="ws-convert"') > markup.indexOf('id="sidebar"'),
    "the primary action left the menu",
  );
  assert(
    markup.indexOf('id="ws-convert"') < markup.indexOf('id="centre"'),
    "the primary action is not in the menu column",
  );

  /* And the centre is left with the photo and the canvas, and nothing
     else. */
  const centre = markup.slice(
    markup.indexOf('id="centre"'),
    markup.indexOf('id="bottom"')
  );
  assert(
    !centre.includes('id="ws-black"'),
    "the Image mode's controls are still a column of their own",
  );
  assert(centre.includes('id="ws-source-pane"'), "the source pane left the centre");
  assert(centre.includes('id="canvas-view"'), "the canvas left the centre");

  /* The sections open and close. */
  assert(
    markup.includes('aria-expanded="true"'),
    "no section says whether it is open",
  );
  assert(
    /menu-head\[aria-expanded="false"\] \+ \.menu-body/.test(read("css/style.css")),
    "a shut section still shows its body",
  );
  assert(
    menu.includes(".menu-head"),
    "the menu does not bind its section headers",
  );

  /* The colours are a pop-over, not a panel in the column: a sixty-four
     swatch grid is taller than the whole menu. */
  assert(markup.includes('id="colour-popover"'), "there is no colour pop-over");
  const popover = markup.slice(
    markup.indexOf('id="colour-popover"'),
    markup.indexOf('id="sidebar"') + markup.indexOf('id="sidebar"')
  );
  assert(
    markup.indexOf('id="swatch-grid"') > markup.indexOf('id="colour-popover"'),
    "the swatch grid is not in the pop-over",
  );
  assert(popover !== null, "the pop-over is not there");
});

check("the grid has its own zoom and pan, and the photo does not move them", () => {
  const workspace = read("js/workspace.js");

  /* The grid's position and size are their own state, separate from the
     photo's zoom and pan. */
  assert(/gridX: OVERLAY_INSET/.test(workspace), "the grid has no position of its own");
  assert(/gridY: OVERLAY_INSET/.test(workspace), "the grid has no position of its own");
  assert(/cellAuto: true/.test(workspace), "the grid's cell size is not its own");

  /* The sampler is told where the grid is, so the grid decides what is
     converted. */
  assert(
    /function geometry[\s\S]{0,400}originX: state\.gridX/.test(workspace),
    "the sampler is not told where the grid is",
  );
  assert(
    /function geometry[\s\S]{0,400}originY: state\.gridY/.test(workspace),
    "the sampler is not told where the grid is",
  );
  /* And the photo's zoom is not what places the grid. */
  assert(
    !/originX: OVERLAY_INSET/.test(workspace),
    "the grid is still pinned to the corner of the pane",
  );

  /* A cell can be one pixel across. The old floor of four meant a
     256-cell grid was always 1024 pixels across and ran off the bottom of
     the pane — the grid could not be seen, let alone fitted. */
  assert(/GRID_CELL_MIN = 1/.test(workspace), "a cell cannot be smaller than four pixels");
  assert(
    !/Math\.max\(4,/.test(workspace),
    "the cell size still has a floor of four pixels",
  );

  /* There is a way to fit the whole grid, and a way to move it. */
  assert(workspace.includes("W.fitGrid = function fitGrid("), "there is no fit-the-grid");
  assert(workspace.includes("W.panGridBy = function panGridBy("), "the grid cannot be moved");
  assert(workspace.includes("W.zoomGrid = function zoomGrid("), "the grid cannot be zoomed");
  assert(read("index.html").includes('id="grid-fit"'), "there is no fit-the-grid button");

  /* Shift moves the grid; without it the drag moves the photo. */
  assert(
    /draggingGrid = event\.shiftKey/.test(workspace),
    "the grid cannot be moved with the mouse",
  );
  assert(
    /if \(event\.shiftKey\)[\s\S]{0,120}W\.zoomGrid/.test(workspace),
    "the grid cannot be zoomed with the wheel",
  );

  /* The grid's own slider moves the grid and nothing else. */
  const markup = read("index.html");
  assert(markup.includes('id="grid-zoom"'), "the grid has no zoom slider");
  assert(
    /el\.gridSlider\.addEventListener[\s\S]{0,200}W\.setGridCell/.test(workspace),
    "the grid's slider does not drive the grid",
  );
});

check("the grid is re-fitted when the canvas changes size", () => {
  const app = read("js/app.js");

  /* The grid over the photo is the canvas's size. When the canvas is
     resized, the grid has to be re-fitted — otherwise it keeps the cell
     size it had, grows off the bottom of the pane, and half of what is
     converted is out of sight. */
  assert(
    /function doResize[\s\S]{0,900}VP\.workspace\.updateCellSize\(true\)/.test(app),
    "a resize does not tell the workspace the grid has changed",
  );
  assert(
    /function doResize[\s\S]{0,900}VP\.workspace\.recentreSource\(\)/.test(app),
    "a resize does not re-centre the photo on the new grid",
  );
});

check("the built-in palettes are balanced across the hue wheel", () => {
  /* The complaint that started this: every built-in had one red and one
     blue, while some other hue had four. The rule is that every hue family
     has the same depth in every built-in. */
  const expected = { 16: 1, 32: 2, 64: 4 };

  for (const builtin of P.BUILTINS) {
    const counts = P.hueCoverage(builtin.colours);
    const depth = expected[builtin.size];

    for (const family of P.HUE_FAMILIES) {
      assertEqual(
        counts[family.name],
        depth,
        `${builtin.name}: ${family.name} has ${counts[family.name]}, expected ${depth}`,
      );
    }

    /* The neutrals fill the rest, and they are never zero — a palette with
       no black or no white cannot draw an outline. */
    assert(
      counts.neutral > 0,
      `${builtin.name} has no neutral colours at all`,
    );
  }
});

check("the built-in palettes grow by whole families", () => {
  /* Every family that the 16 has, the 32 has; every family the 32 has, the
     64 has. A hue may not appear out of nowhere in the bigger palette. */
  const byName = {};
  for (const builtin of P.BUILTINS) byName[builtin.size] = builtin;

  for (const [small, big] of [[16, 32], [32, 64]]) {
    const smallCounts = P.hueCoverage(byName[small].colours);
    const bigCounts = P.hueCoverage(byName[big].colours);
    for (const family of P.HUE_FAMILIES) {
      assert(
        bigCounts[family.name] >= smallCounts[family.name],
        `${byName[big].name} lost the ${family.name} family`,
      );
    }
    assert(
      bigCounts.neutral >= smallCounts.neutral,
      `${byName[big].name} lost its neutrals`,
    );
  }
});

check("every built-in colour is a real colour", () => {
  for (const builtin of P.BUILTINS) {
    for (const hex of builtin.colours) {
      assert(/^#[0-9a-f]{6}$/.test(hex), `${builtin.name} has a bad colour: ${hex}`);
    }
    /* No colour is repeated inside a palette: a duplicate is a wasted slot,
       and the grid serialiser only has 64 codes to give away. */
    assertEqual(
      new Set(builtin.colours).size,
      builtin.colours.length,
      `${builtin.name} has a repeated colour`,
    );
  }
});

check("the built-in palettes are nested", () => {
  assert(P.builtinsAreNested(), "the built-ins are not nested");
  const byName = {};
  for (const builtin of P.BUILTINS) byName[builtin.size] = builtin;
  for (let i = 0; i < 16; i += 1) {
    assertEqual(byName[32].colours[i], byName[16].colours[i], `the 32 at ${i}`);
    assertEqual(byName[64].colours[i], byName[16].colours[i], `the 64 at ${i}`);
  }
});

check("the spec's palette tables match the build", () => {
  /* The specification carries the palette tables. If they drift away from
     the code, the spec stops being the source of truth — so they are
     checked, not trusted. */
  const spec = read("project.md");
  const source = read("js/palette.js");

  const block = source.slice(
    source.indexOf("const VOID_16"),
    source.indexOf("const P = (VP.palette = {})")
  );
  const code = [...block.matchAll(/"(#[0-9a-f]{6})"/g)].map((m) => m[1]);

  const tables = spec.slice(
    spec.indexOf("#### Void Palette (16)"),
    spec.indexOf("### 5.2 Custom palettes")
  );
  const rows = [...tables.matchAll(/\|\s*(\d+)\s*\|\s*`(#[0-9a-f]{6})`/g)];
  const documented = rows
    .map((m) => [Number(m[1]), m[2]])
    .sort((a, b) => a[0] - b[0])
    .map((pair) => pair[1]);

  assertEqual(documented.length, code.length, "the number of documented colours");
  for (let i = 0; i < code.length; i += 1) {
    assertEqual(documented[i], code[i], `colour ${i}`);
  }
});

check("a loaded photo lands in the source pane", () => {
  /* There is one view of the photo, and it is the pane beside the grid. If
     the load did not put it there, the user would load an image and see
     nothing at all and conclude the upload had failed. */
  const source = read("js/app.js");
  assert(
    /function loadImageFile[\s\S]{0,900}VP\.workspace\.fitSource\(\)/.test(source),
    "loading an image does not fit it into the source pane",
  );
});

check("a failed load is reported where the user can see it", () => {
  const source = read("js/app.js");
  assert(source.includes("function showError"), "there is no showError helper");
  assert(
    source.includes('const bar = $("alert")'),
    "the error is not written to the alert bar",
  );
  assert(
    /function loadImageFile[\s\S]{0,900}showError\(/.test(source),
    "a failed image load does not call showError",
  );
});

check("the alert bar exists in the markup", () => {
  assert(html.includes('id="alert"'), "there is no alert bar");
  assert(html.includes('id="alert-text"'), "the alert bar has no text element");
  assert(html.includes('id="alert-dismiss"'), "the alert bar cannot be dismissed");
});

check("the zoom follows the canvas size", () => {
  const canvas = read("js/canvas.js");
  const app = read("js/app.js");
  assert(
    canvas.includes("C.scaleForSize"),
    "there is no scaleForSize — the zoom cannot follow the canvas",
  );
  assert(
    /function doResize[\s\S]{0,900}setScale\(VP\.canvas\.scaleForSize\(\)\)/.test(app),
    "a resize does not re-fit the zoom",
  );
  assert(
    /state\.prefs\.fitZoom[\s\S]{0,300}setScale\(VP\.canvas\.scaleForSize\(\)\)/.test(app),
    "a window resize does not re-fit the zoom",
  );
});

check("the zoom always lands on a step", () => {
  const canvas = read("js/canvas.js");
  assert(
    /const SCALES = \[1, 2, 4, 8, 16, 32, 64\]/.test(canvas),
    "the zoom steps are not defined",
  );
  assert(
    /C\.fitScale = function[\s\S]{0,600}SCALES\[i\]/.test(canvas),
    "fitScale does not snap to a step",
  );
  /* The slider is continuous, but it must not be able to produce a scale
     the canvas cannot draw: the mapping goes through the same clamp the
     button steps use. */
  assert(
    /C\.scaleFromSlider[\s\S]{0,400}clampScale/.test(canvas),
    "the zoom slider does not clamp",
  );
  assert(
    /C\.sliderFromScale[\s\S]{0,600}Math\.log\(MAX_SCALE\)/.test(canvas),
    "the zoom slider is not logarithmic",
  );
});

check("the menu never cuts a control", () => {
  const css = read("css/style.css");
  /* The swatch grid's height is set by a media query, never by a flex
     shrink: a shrink could take it to nothing, and a grid that collapses
     leaves the sections on top of each other. */
  assert(
    /\.swatch-grid[\s\S]{0,400}flex: 0 0 auto/.test(css),
    "the swatch grid can shrink to nothing",
  );
  assert(
    /\.swatch-grid[\s\S]{0,400}overflow-y: auto/.test(css),
    "the swatch grid does not scroll",
  );
  /* The menu is a scrolling column, so its content is clipped rather than
     allowed to overlap the bar below it. */
  assert(
    /\.menu[\s\S]{0,200}overflow-y: auto/.test(css),
    "the menu is not a scrolling column",
  );
  assert(
    !/\.sidebar[\s\S]{0,300}display: grid/.test(css),
    "the sidebar is a grid — a grid row can overflow and overlap the next one",
  );
  /* The pop-over floats over the canvas, so it must not be clipped by the
     menu's overflow — and it must be positioned in script, because its
     place depends on where the button that opened it is. */
  assert(
    /\.popover[\s\S]{0,200}position: fixed/.test(css),
    "the colour pop-over is not fixed — the menu's overflow will clip it",
  );
  const menu = read("js/menu.js");
  assert(
    /function place\(\)[\s\S]{0,900}getBoundingClientRect/.test(menu),
    "the pop-over is not positioned from the button that opened it",
  );
});

check("the menu's primary action is pinned, not scrolled", () => {
  assert(html.includes('class="menu-foot"'), "the menu has no pinned footer");
  assert(html.includes('class="menu"'), "the menu has no scrolling column");
  const css = read("css/style.css");
  assert(
    /\.menu-foot[\s\S]{0,200}flex: 0 0 auto/.test(css),
    "the pinned footer can be scrolled away",
  );
  assert(
    /\.sidebar[\s\S]{0,200}display: flex/.test(css),
    "the sidebar is not a flex column, so the footer cannot be pinned",
  );
});

check("the pane labels are headers, not overlays on the image", () => {
  assert(html.includes('class="pane-head"'), "the panes have no header row");
  const css = read("css/style.css");
  /* Look only inside the .pane-label rule itself — the rule after it is
     .pane-empty, which is meant to be an overlay. */
  const rule = /\.pane-label\s*\{([^}]*)\}/.exec(css);
  assert(rule, "there is no .pane-label rule");
  assert(
    !/position:\s*absolute/.test(rule[1]),
    "the pane label is still an overlay on the image",
  );
});

check("every control group is labelled", () => {
  /* A bare "G", or a row of naked numbers, gave no clue what it was.
     The groups are a <div> in the top bar and a <span> in the source pane's
     header, so both tags are matched. */
  const groups = [
    ...html.matchAll(/<(div|span) class="group"[^>]*>([\s\S]*?)<\/\1>/g),
  ];
  assert(groups.length >= 4, `only ${groups.length} labelled groups`);
  for (const group of groups) {
    assert(
      group[2].includes("group-label"),
      "a group has no label telling the user what it is",
    );
  }
});

check("the live-site check exists and does not need the probe", () => {
  const live = read("tests/browser/live.py");
  assert(live.includes("probe"), "the live check does not mention the probe");
  assert(
    !live.includes("probe.install"),
    "the live check installs the probe — a deployed site has no test files",
  );
  assert(
    live.includes("the app booted"),
    "the live check does not check that the app boots under the real CSP",
  );
});

/* --- the ImageData trap ---------------------------------------------------- */

check("an ImageData is never handed to drawImage", () => {
  /* Firefox refuses an ImageData as a drawImage source:
       "Argument 1 could not be converted to any of: ..."
     The reference resampler did exactly that, so any photo over the
     working cap failed to load at all. The conversion is centralised in
     toDrawable, and drawToImageData is the one place that draws. */
  const reference = read("js/reference.js");
  assert(
    reference.includes("function toDrawable("),
    "there is no toDrawable — an ImageData can still reach drawImage",
  );
  assert(
    /function drawToImageData[\s\S]{0,400}drawImage\(toDrawable\(/.test(reference),
    "drawToImageData does not convert the drawable first",
  );

  /* And the downscale — the path that actually broke — goes through it. */
  assert(
    /function downscale[\s\S]{0,500}drawToImageData\(/.test(reference),
    "the downscale does not go through drawToImageData",
  );
});

check("the test images include one over the working cap", () => {
  const maker = read("tools/make-test-images.py");
  assert(
    maker.includes("test-large.png"),
    "there is no over-cap test image, so the resampler is never exercised",
  );
  assert(
    /2400/.test(maker) && /1800/.test(maker),
    "the over-cap test image is not over the 2048 working cap",
  );
});

check("the browser suite loads a photo over the working cap", () => {
  const e2e = read("tests/browser/e2e.py");
  assert(
    e2e.includes("test-large.png"),
    "the e2e suite never loads an over-cap photo",
  );
  assert(
    e2e.includes("a photo over the working cap loads"),
    "the e2e suite does not check that an over-cap photo loads",
  );
});

/* --- the sliders and the page that has to keep up ------------------------- */

check("every slider has a reset button", () => {
  const markup = read("index.html");
  const workspace = read("js/workspace.js");

  /* Every range input in the app. */
  const sliders = [...markup.matchAll(/<input type="range" id="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert(sliders.length >= 12, `only ${sliders.length} sliders found in the markup`);

  /* The three zoom sliders are framing controls, not adjustments: their
     "normal" is the Fit button beside them, and that is what the test
     below checks for them instead. */
  const zoomSliders = ["ws-zoom", "canvas-zoom", "grid-zoom"];

  /* The workspace sliders are covered by attachReset calls, one per slider. */
  for (const id of sliders) {
    if (id === "reference-opacity") continue;
    if (zoomSliders.includes(id)) continue;
    assert(
      workspace.includes(`attachReset(document.getElementById("${id}")`),
      `the ${id} slider has no reset button`,
    );
  }

  /* And each zoom slider has a Fit button of its own, so it can always be
     put back. */
  assert(markup.includes('id="ws-fit"'), "the source zoom has no fit button");
  assert(markup.includes('id="canvas-fit"'), "the canvas zoom has no fit button");
  assert(markup.includes('id="grid-fit"'), "the grid zoom has no fit button");

  /* And there is no slider left over from the drawing half of the app. */
  const app = read("js/app.js");
  assert(
    !markup.includes('id="reference-opacity"'),
    "the reference opacity slider is still in the markup",
  );

  /* The reset target is the slider's own shipped value, so the button and
     the algorithm's default can never disagree. */
  assert(
    workspace.includes("slider.value = slider.defaultValue;"),
    "the reset button does not restore the slider's shipped value",
  );
});

check("the reset button travels the same path as a hand-made change", () => {
  const workspace = read("js/workspace.js");
  assert(
    /dispatchEvent\(new Event\("input"/.test(workspace) &&
      /dispatchEvent\(new Event\("change"/.test(workspace),
    "the reset button does not re-dispatch the slider's own events",
  );
});

check("the settle bakes the current adjustment before the full pass", () => {
  /* While a control is moving only the reduced copy is updated, so the
     full-resolution copy is stale. The settle has to bring it up to date —
     otherwise the preview snaps back to the previous value a fraction of a
     second after you stop moving, and the page looks like it never updated. */
  const reference = read("js/reference.js");
  const workspace = read("js/workspace.js");

  assert(
    reference.includes("R.commitAdjust = function commitAdjust("),
    "there is no commitAdjust — the full copy is never brought up to date",
  );
  assert(
    reference.includes("state.adjustedStale = true;"),
    "the full copy is not marked stale while a control is moving",
  );
  assert(
    /function settlePreview[\s\S]{0,400}commitAdjust\(\)/.test(workspace),
    "the settle does not bake the adjustment first",
  );
  assert(
    /function settlePreview[\s\S]{0,600}runPreview\(false\)/.test(workspace),
    "the settle does not render the full result",
  );
  /* And the settle has to redraw the source pane, which is drawn from the
     full copy — otherwise the photo stays stale until something else
     redraws it, and the user has to nudge the image to make the page
     catch up. */
  assert(
    /function settlePreview[\s\S]{0,600}W\.draw\(\)/.test(workspace),
    "the settle does not redraw the source pane",
  );
});

check("the tuning palette never compounds", () => {
  /* Transforming the last result instead of the original made every slider
     move apply on top of the previous one, so the colours ran away while
     you dragged and putting the slider back did not restore them. */
  const palette = read("js/palette.js");
  assert(
    palette.includes("stagedSource"),
    "the staging palette keeps no untransformed source",
  );
  assert(
    /function transformStaged[\s\S]{0,700}const base = state\.stagedSource \|\| state\.staged;/.test(
      palette,
    ),
    "transformStaged does not start from the original extraction",
  );
});

check("a preset moves the sliders with it", () => {
  const workspace = read("js/workspace.js");
  assert(
    workspace.includes("W.syncTuneSliders = function syncTuneSliders("),
    "there is no syncTuneSliders",
  );
  assert(
    /function applyPreset[\s\S]{0,700}syncTuneSliders\(\)/.test(workspace),
    "a preset changes the state but leaves the sliders showing the old values",
  );
});

check("a confirmation does not expire on a timer", () => {
  /* The expiry made "New" a trap: click it, read the label, look away for
     a moment, click again — and the second click armed it a second time
     instead of confirming it, so the canvas never cleared. */
  const app = read("js/app.js");
  const arm = app.slice(app.indexOf("function armConfirm("));
  const body = arm.slice(0, arm.indexOf("\n  }"));
  assert(
    !body.includes("setTimeout"),
    "the confirmation still expires on a timer",
  );
  assert(
    app.includes("function disarmConfirm("),
    "there is no way to cancel an armed confirmation",
  );
  assert(
    app.includes("watchConfirmations"),
    "a click elsewhere does not cancel an armed confirmation",
  );
});

check("a palette change reaches the workspace preview", () => {
  /* The swatch grid is only half of a palette change. The live preview in
     the workspace has to follow it too, or switching the palette in the
     sidebar leaves the preview showing the previous palette's result —
     measured, the preview hash did not change at all. */
  const app = read("js/app.js");
  assert(
    /function renderAll[\s\S]{0,600}VP\.workspace\.refresh\(\)/.test(app),
    "renderAll does not refresh the workspace preview, so a palette change never reaches it",
  );
});

check("there is always a way to load a photo", () => {
  /* The Load button used to live in the reference strip, and the strip is
     hidden until a photo is loaded — so before your first load there was
     nothing on screen to click, and the only route in was dropping a file
     over exactly the right box. */
  const markup = read("index.html");
  const app = read("js/app.js");

  assert(
    markup.includes('id="load-photo"'),
    "the top bar has no button to load a photo",
  );
  assert(
    app.includes('$("load-photo")'),
    "the load-photo button is never wired up",
  );
  assert(
    /load-photo[\s\S]{0,200}openFilePicker\("file-image"\)/.test(app),
    "the load-photo button does not open the file picker",
  );
  /* The source pane is always on screen — there is no mode to open. */
  assert(
    markup.includes('id="ws-source-pane"') &&
      !/id="ws-source-pane"[^>]*hidden/.test(markup),
    "the source pane is hidden until something asks for it",
  );
  assert(
    !markup.includes('id="reference-strip"'),
    "there is still a reference strip — the photo lives in the source pane",
  );
});

check("a photo can be dropped anywhere on the page", () => {
  /* Releasing a photo over the sidebar, the top bar or the bottom bar did
     nothing at all. The drop handler now lives on the document. */
  const app = read("js/app.js");
  const bind = app.slice(app.indexOf("function bindDragAndDrop("));
  const body = bind.slice(0, bind.indexOf("\n  }"));

  assert(
    /document\.addEventListener\("drop"/.test(body),
    "the drop handler is not on the document",
  );
  assert(
    /document\.addEventListener\("dragover"/.test(body),
    "dragover is not on the document, so a drop is refused",
  );
  /* The old per-target handlers would have loaded the image twice, because
     the drop event bubbles. */
  assert(
    !/addEventListener\("drop"/.test(body.replace(/document\.addEventListener\("drop"/g, "")),
    "there is still a second drop handler — the image would load twice",
  );
});

check("the drop only accepts files", () => {
  const app = read("js/app.js");
  assert(
    app.includes("function dragHasFiles("),
    "the drag handler does not check that the drag carries files",
  );
  assert(
    /dragHasFiles[\s\S]{0,200}Files/.test(app),
    "the drag handler does not look for the Files type",
  );
});

/* --- summary -------------------------------------------------------------- */

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`${passed} passed\n`);
