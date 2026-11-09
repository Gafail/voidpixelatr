/* ==========================================================================
   VoidPixelatr — storage.js
   --------------------------------------------------------------------------
   Local persistence. Nothing here ever talks to a server: the only stores
   touched are `localStorage` (the artwork, the palettes and the preferences)
   and IndexedDB (the photo, because a photo is megabytes and localStorage is
   a synchronous ~5 MB string store).

   Three localStorage keys, exactly as specified:

       voidpixelatr:canvas:v2    { width, height, palette, grid }
       voidpixelatr:palettes:v2  [ { name, colours } ]
       voidpixelatr:prefs:v2     { zoom, gridVisible, activePalette, ... }

   The namespace is this project's own. VoidPixlr keeps `voidpixlr:*`, and
   the two apps are served from the same origin during local development, so
   they must not share a key — one would read the other's artwork.

   Every write is wrapped: a quota error or a private-mode browser must never
   take the app down. Persistence is a convenience, never a dependency.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const Q = VP.quantise;
  const S = (VP.storage = {});

  const KEYS = {
    canvas: "voidpixelatr:canvas:v2",
    palettes: "voidpixelatr:palettes:v2",
    prefs: "voidpixelatr:prefs:v2",
  };

  const DB_NAME = "voidpixelatr";
  const DB_STORE = "source";
  const DB_KEY = "photo";

  S.KEYS = KEYS;

  function store() {
    try {
      return root.localStorage || null;
    } catch (error) {
      /* Private mode can throw on access, not just on write. */
      return null;
    }
  }

  function readRaw(key) {
    const local = store();
    if (!local) return null;
    try {
      return local.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeRaw(key, value) {
    const local = store();
    if (!local) return false;
    try {
      local.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeRaw(key) {
    const local = store();
    if (!local) return;
    try {
      local.removeItem(key);
    } catch (error) {
      /* Nothing to do — the data is already unreachable. */
    }
  }

  /* --- the canvas ---------------------------------------------------------- */

  /* The saved canvas carries its width and its height. An older save — one
     written before the canvas could be rectangular — has a single `size` and
     is read as a square. */
  S.saveCanvas = function saveCanvas(width, height, palette, grid) {
    return writeRaw(
      KEYS.canvas,
      JSON.stringify({
        width,
        height,
        palette: palette.slice(),
        grid: Q.serialiseGrid(grid),
      })
    );
  };

  S.loadCanvas = function loadCanvas() {
    const raw = readRaw(KEYS.canvas);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data) return null;
      const width = data.width === undefined ? data.size : data.width;
      const height = data.height === undefined ? data.size : data.height;
      if (!Q.ALLOWED_SIZES.includes(width)) return null;
      if (!Q.ALLOWED_SIZES.includes(height)) return null;
      if (!Array.isArray(data.palette) || !data.palette.length) return null;
      const palette = data.palette.map((hex) => Q.normaliseHex(hex)).filter(Boolean);
      if (!palette.length) return null;
      const grid = Q.deserialiseGrid(String(data.grid || ""), width * height);
      return { width, height, palette, grid };
    } catch (error) {
      /* A corrupt autosave must never brick the tool. */
      return null;
    }
  };

  /* --- the palettes --------------------------------------------------------- */

  S.savePalettes = function savePalettes(list) {
    const payload = list.map((entry) => ({
      name: entry.name,
      colours: entry.colours.slice(),
    }));
    return writeRaw(KEYS.palettes, JSON.stringify(payload));
  };

  S.loadPalettes = function loadPalettes() {
    const raw = readRaw(KEYS.palettes);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .filter((entry) => entry && Array.isArray(entry.colours) && entry.colours.length)
        .map((entry) => ({
          name: String(entry.name || "Untitled"),
          colours: entry.colours.map((hex) => Q.normaliseHex(hex)).filter(Boolean),
        }))
        .filter((entry) => entry.colours.length);
    } catch (error) {
      return [];
    }
  };

  /* --- the preferences -------------------------------------------------------- */

  S.savePrefs = function savePrefs(prefs) {
    return writeRaw(KEYS.prefs, JSON.stringify(prefs));
  };

  S.loadPrefs = function loadPrefs() {
    const raw = readRaw(KEYS.prefs);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : null;
    } catch (error) {
      return null;
    }
  };

  /* --- the photo (IndexedDB) ---------------------------------------------------- */

  function openDb() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = root.indexedDB.open(DB_NAME, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /* The photo's original Blob, its file name and its type. Never uploaded. */
  S.savePhoto = function savePhoto(blob, name, type) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(DB_STORE, "readwrite");
          const objectStore = transaction.objectStore(DB_STORE);
          objectStore.put({ blob, name, type }, DB_KEY);
          transaction.oncomplete = () => {
            db.close();
            resolve(true);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
        })
    ).catch(() => false);
  };

  S.loadPhoto = function loadPhoto() {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(DB_STORE, "readonly");
          const request = transaction.objectStore(DB_STORE).get(DB_KEY);
          request.onsuccess = () => {
            db.close();
            resolve(request.result || null);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        })
    ).catch(() => null);
  };

  S.deletePhoto = function deletePhoto() {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(DB_STORE, "readwrite");
          transaction.objectStore(DB_STORE).delete(DB_KEY);
          transaction.oncomplete = () => {
            db.close();
            resolve(true);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
        })
    ).catch(() => false);
  };

  /* --- forgetting everything ------------------------------------------------------ */

  /* Removes all three localStorage keys and deletes the photo, then reloads
     the app into a clean first-run state. */
  S.forgetEverything = function forgetEverything() {
    removeRaw(KEYS.canvas);
    removeRaw(KEYS.palettes);
    removeRaw(KEYS.prefs);
    return S.deletePhoto();
  };
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : this
);
