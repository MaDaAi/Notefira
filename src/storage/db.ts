// Minimal promise wrapper around IndexedDB. IndexedDB is available in every
// target: browsers, installed PWAs, and the Tauri webview (where it is
// persisted inside the app's data directory).

export const STORES = [
  "docs",
  "pages",
  "folders",
  "assets",
  "recordings",
  "decks",
  "kv",
  "revisions",
  "stickers",
  "texts",
] as const;
export type StoreName = (typeof STORES)[number];

const DB_VERSION = 1;
let dbName = "notefira";
let dbPromise: Promise<IDBDatabase> | null = null;

export function setDbName(name: string) {
  dbName = name;
  dbPromise = null;
}

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support offline storage (IndexedDB)."));
      return;
    }
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name: StoreName, keyPath: string, indexes: string[] = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const s = db.createObjectStore(name, { keyPath });
        for (const ix of indexes) s.createIndex(ix, ix, { unique: false });
      };
      mk("docs", "id", ["folderId"]);
      mk("pages", "id", ["docId"]);
      mk("folders", "id", ["parentId"]);
      mk("assets", "id", ["docId"]);
      mk("recordings", "id", ["docId"]);
      mk("decks", "id");
      mk("kv", "key");
      mk("revisions", "id", ["docId"]);
      mk("stickers", "id");
      mk("texts", "pageId", ["docId"]);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("Could not open local storage"));
    req.onblocked = () => reject(new Error("Local storage is blocked by another Notefira window. Close other windows and retry."));
  });
  return dbPromise;
}

export async function closeDB() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  db?.close();
  dbPromise = null;
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).index(index).getAll(key)) as Promise<T[]>;
}

export async function getMany<T>(store: StoreName, keys: IDBValidKey[]): Promise<(T | undefined)[]> {
  const db = await openDB();
  const s = db.transaction(store, "readonly").objectStore(store);
  return Promise.all(keys.map((k) => reqP(s.get(k)) as Promise<T | undefined>));
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export interface TxWriter {
  put(store: StoreName, value: unknown): void;
  del(store: StoreName, key: IDBValidKey): void;
}

/** Atomic multi-store write: either everything is stored or nothing is. */
export async function writeTx(stores: StoreName[], fn: (w: TxWriter) => void): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(stores, "readwrite");
  const w: TxWriter = {
    put: (s, v) => void tx.objectStore(s).put(v),
    del: (s, k) => void tx.objectStore(s).delete(k),
  };
  try {
    fn(w);
  } catch (e) {
    tx.abort();
    throw e;
  }
  await txDone(tx);
}

export async function keysByIndex(store: StoreName, index: string, key: IDBValidKey): Promise<IDBValidKey[]> {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).index(index).getAllKeys(key));
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const r = await get<{ key: string; value: T }>("kv", key);
  return r ? r.value : fallback;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await put("kv", { key, value });
}

export async function kvDelete(key: string): Promise<void> {
  await writeTx(["kv"], (w) => w.del("kv", key));
}
