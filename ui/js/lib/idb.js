/** Minimal IndexedDB helper. Stores the config FILE HANDLE, query history and UI settings.
 *  It never stores credentials — the YAML file on disk stays the only place they live. */

const DB_NAME = 'elasticvue-pro';
const DB_VERSION = 1;
const STORES = { handles: 'handles', queries: 'queries', kv: 'kv' };

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.handles)) db.createObjectStore(STORES.handles);
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv);
      if (!db.objectStoreNames.contains(STORES.queries)) {
        const s = db.createObjectStore(STORES.queries, { keyPath: 'id' });
        s.createIndex('ts', 'ts');
        s.createIndex('fav', 'fav');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const idb = {
  getHandle: (k = 'config') => tx(STORES.handles, 'readonly', (os) => os.get(k)),
  setHandle: (h, k = 'config') => tx(STORES.handles, 'readwrite', (os) => os.put(h, k)),
  delHandle: (k = 'config') => tx(STORES.handles, 'readwrite', (os) => os.delete(k)),

  getKV: (k) => tx(STORES.kv, 'readonly', (os) => os.get(k)),
  setKV: (k, v) => tx(STORES.kv, 'readwrite', (os) => os.put(v, k)),

  putQuery: (q) => tx(STORES.queries, 'readwrite', (os) => os.put(q)),
  delQuery: (id) => tx(STORES.queries, 'readwrite', (os) => os.delete(id)),
  allQueries: () => tx(STORES.queries, 'readonly', (os) => os.getAll()),
  clearQueries: () => tx(STORES.queries, 'readwrite', (os) => os.clear()),
};
