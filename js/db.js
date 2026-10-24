// Minimal promise wrapper around IndexedDB. All data stays on the device.
//
// iOS can close a backgrounded web app's IndexedDB connection ("Connection to
// Indexed Database server lost", WebKit bugs 197050 / 277615). A cached dead
// connection made every later write fail silently, so data entered after
// returning to the app (for example a pasted API key) was never saved.
// Each operation therefore reopens the connection when it has been closed and
// retries once.
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
      req.onsuccess = () => {
        const db = req.result;
        // Forget the connection if the browser closes it, so the next call reopens.
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('Database is blocked by another open copy of the app.')); };
    });
  }
  return dbPromise;
}

function isConnectionError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || '');
  return name === 'InvalidStateError' || name === 'UnknownError' || name === 'TransactionInactiveError' ||
    /connection|closing|closed/i.test(msg);
}

function runOnce(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  }));
}

async function run(storeName, mode, fn) {
  try {
    return await runOnce(storeName, mode, fn);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    dbPromise = null; // reconnect and retry once
    return runOnce(storeName, mode, fn);
  }
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const getAll = (store) => run(store, 'readonly', s => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));

export async function wipeAll() {
  try { (await open()).close(); } catch { /* already closed */ }
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = resolve;
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
