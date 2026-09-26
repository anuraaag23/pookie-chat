/**
 * Local persistence for the things that must never touch the server in
 * plaintext, or at all: the device's private key material, and the
 * hidden-chat/app-lock verifiers (docs/02-DATABASE-SCHEMA.md).
 *
 * Uses IndexedDB rather than localStorage: localStorage is synchronous,
 * string-only, and trivially readable in bulk by any script running on
 * the page (`Object.entries(localStorage)`); IndexedDB at least requires
 * structured, asynchronous access per key, which is a marginal but real
 * improvement, and is required for storing non-string values (CryptoKey
 * objects, Uint8Arrays) without manual serialization.
 *
 * HONEST LIMITATION (see docs/03-ENCRYPTION-PROTOCOL.md §14): this does
 * not achieve hardware-backed key isolation the way Android Keystore
 * does. A script running on this origin (e.g. via a successful XSS
 * attack) could read this database. The mitigations that actually matter
 * are outside this file: a strict Content-Security-Policy and not
 * introducing XSS in the first place.
 */

const DB_NAME = 'pookie-chat';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipes every locally stored key — used by "Burn Conversation" (for that conversation's session state) and account deletion/logout (for everything). */
export async function idbClear(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Wipes auth and session keys (tokens, session info, device keys, conversation ratchets)
 * while preserving local device-level configurations such as App Lock (`appLock:*`).
 * Used on logout and session revocation to cleanly separate auth session state
 * from local device security configurations.
 */
export async function idbClearAuthSession(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        const key = String(cursor.key);
        if (
          !key.startsWith('appLock:') &&
          !key.startsWith('chatLock:') &&
          !key.startsWith('hiddenChats:')
        ) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

