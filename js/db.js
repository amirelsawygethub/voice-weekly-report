// Minimal promise wrapper around IndexedDB. All data stays on the device.
const DB_NAME = 'voice-weekly-report';
const DB_VERSION = 1;
const STORES = ['keys', 'settings', 'projects', 'notes', 'audio', 'reports'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            const keyed = ['projects', 'notes', 'audio', 'reports'].includes(name);
            const store = db.createObjectStore(name, keyed ? { keyPath: 'id' } : undefined);
            if (name === 'notes') store.createIndex('createdAt', 'createdAt');
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const getAll = (store) => run(store, 'readonly', s => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));

export async function wipeAll() {
  const db = await open();
  db.close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = resolve;
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
