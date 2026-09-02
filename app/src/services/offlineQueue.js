// services/offlineQueue.js — Cola offline con IndexedDB para trip_positions
const DB_NAME = 'td-offline';
const STORE = 'queue';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(rows) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    for (const r of rows) tx.objectStore(STORE).add({ ...r, enqueuedAt: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) {
    console.warn('Queue enqueue failed, fallback to localStorage', e);
    try {
      const key = 'td-queue-fallback';
      const cur = JSON.parse(localStorage.getItem(key) || '[]');
      cur.push(...rows.map(r => ({ ...r, enqueuedAt: Date.now() })));
      localStorage.setItem(key, JSON.stringify(cur.slice(-100)));
    } catch {}
  }
}

export async function dequeueAll() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    const rows = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    store.clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    // Fallback localStorage
    try {
      const key = 'td-queue-fallback';
      const fb = JSON.parse(localStorage.getItem(key) || '[]');
      if (fb.length) { localStorage.removeItem(key); return [...rows, ...fb]; }
    } catch {}
    return rows;
  } catch (e) {
    try {
      const key = 'td-queue-fallback';
      const cur = JSON.parse(localStorage.getItem(key) || '[]');
      localStorage.removeItem(key);
      return cur;
    } catch { return []; }
  }
}

export async function getQueueCount() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    const c = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    db.close();
    return c;
  } catch { return 0; }
}
