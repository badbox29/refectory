/**
 * imageStore.js — IndexedDB wrapper for recipe images
 *
 * Images are stored separately from localStorage so large base64 blobs
 * never hit the ~5 MB localStorage quota. IndexedDB has no practical limit.
 *
 * API (all async):
 *   ImageStore.get(recipeId)          → dataUrl | null
 *   ImageStore.set(recipeId, dataUrl) → void
 *   ImageStore.delete(recipeId)       → void
 *   ImageStore.deleteMany(ids[])      → void
 *   ImageStore.clear()                → void
 */
const ImageStore = (() => {
  const DB_NAME    = 'refectory-images';
  const STORE_NAME = 'images';
  const DB_VERSION = 1;

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function store(mode) {
    const db = await openDB();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  function wrap(req) {
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = (e) => { console.warn('[ImageStore]', e.target.error); resolve(null); };
    });
  }

  async function get(id) {
    try { return await wrap((await store('readonly')).get(id)); }
    catch { return null; }
  }

  async function set(id, dataUrl) {
    if (!id || !dataUrl) return;
    try { await wrap((await store('readwrite')).put(dataUrl, id)); }
    catch (e) { console.warn('[ImageStore] set failed:', e); }
  }

  async function del(id) {
    try { await wrap((await store('readwrite')).delete(id)); }
    catch { /* ignore */ }
  }

  async function deleteMany(ids) {
    if (!ids?.length) return;
    try {
      const s = await store('readwrite');
      await Promise.all(ids.map(id => wrap(s.delete(id))));
    } catch { /* ignore */ }
  }

  async function clear() {
    try { await wrap((await store('readwrite')).clear()); }
    catch { /* ignore */ }
  }

  return { get, set, delete: del, deleteMany, clear };
})();
