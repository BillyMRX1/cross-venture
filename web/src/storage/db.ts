import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { decryptJson, encryptJson, importVaultKey } from '../crypto/vault';
import { ensureSignedIn, getDb } from '../firebase';
import type { KnowledgeGraph, TokenMap, Workspace } from '../types';
import { deduplicateWorkspace } from './workspaceOps';

/** Thrown when this device may read but not write a cloud workspace (foreign-owned or unowned legacy). */
export class ReadOnlyWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyWorkspaceError';
  }
}

const DB_NAME = 'cross-venture-workspaces';
const DB_VERSION = 1;
const STORE_NAME = 'workspaces';

function openWorkspaceDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function decodeBase64UrlJson<T>(encoded: string): T {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);

  let jsonStr: string;
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    jsonStr = new TextDecoder().decode(bytes);
  } else {
    const Buf = (
      globalThis as unknown as {
        Buffer?: { from(input: string, encoding: string): Uint8Array };
      }
    ).Buffer;
    if (!Buf) {
      throw new Error('No base64 decoder available');
    }
    jsonStr = new TextDecoder().decode(Buf.from(padded, 'base64'));
  }

  return JSON.parse(jsonStr) as T;
}

/**
 * Persists a Workspace locally in IndexedDB.
 * No-ops gracefully when IndexedDB is unavailable (e.g. Node).
 */
export async function saveWorkspaceLocal(ws: Workspace): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const db = await openWorkspaceDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const putReq = store.put(ws);
    await new Promise<void>((resolve, reject) => {
      putReq.onerror = () => reject(putReq.error ?? new Error('IndexedDB put failed'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * Clears all saved Workspaces from IndexedDB.
 * No-ops gracefully when IndexedDB is unavailable (e.g. Node).
 */
export async function clearWorkspacesLocal(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const db = await openWorkspaceDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const clearReq = store.clear();
    await new Promise<void>((resolve, reject) => {
      clearReq.onerror = () => reject(clearReq.error ?? new Error('IndexedDB clear failed'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * Loads the most recently updated Workspace from IndexedDB and runs
 * startup deduplication migration. If duplicates are merged, persists
 * the deduplicated Workspace back to IndexedDB.
 */
export async function loadAndMigrateWorkspaceLocal(): Promise<{
  workspace: Workspace | null;
  migrated: boolean;
  ventureIdMap: Record<string, string>;
}> {
  if (typeof indexedDB === 'undefined') {
    return { workspace: null, migrated: false, ventureIdMap: {} };
  }
  let latest: Workspace | null = null;
  const db = await openWorkspaceDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const all = (await promisifyRequest(store.getAll())) as Workspace[];
    if (Array.isArray(all) && all.length > 0) {
      all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      latest = all[0] ?? null;
    }
  } finally {
    db.close();
  }

  if (!latest) {
    return { workspace: null, migrated: false, ventureIdMap: {} };
  }

  const { workspace, changed, ventureIdMap } = deduplicateWorkspace(latest);
  if (changed) {
    await saveWorkspaceLocal(workspace);
    return { workspace, migrated: true, ventureIdMap };
  }

  return { workspace, migrated: false, ventureIdMap: {} };
}

/**
 * Loads the most recently updated Workspace from IndexedDB,
 * applying startup deduplication migration automatically.
 * Returns null if none saved or if IndexedDB is unavailable.
 */
export async function loadWorkspaceLocal(): Promise<Workspace | null> {
  const { workspace } = await loadAndMigrateWorkspaceLocal();
  return workspace;
}

/**
 * Encrypts { graph, tokenMap } locally with AES-256-GCM and writes ONLY
 * { wsId, ownerUid, iv, cipher, updatedAt } to Firestore at workspaces/{wsId}.
 * ownerUid is the non-sensitive anonymous auth uid of the creator; it is immutable.
 * Throws ReadOnlyWorkspaceError for docs owned by someone else or unowned legacy docs.
 */
export async function pushEncrypted(
  wsId: string,
  payload: { graph: KnowledgeGraph; tokenMap: TokenMap },
  key: CryptoKey
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error('Firestore is not configured or unavailable');
  }
  const signedIn = await ensureSignedIn();
  if (!signedIn) {
    throw new Error('Firebase anonymous sign-in failed; cannot push encrypted workspace');
  }

  // ensureSignedIn() only returns a boolean; the uid comes from the Auth instance of this app.
  const uid = getAuth(db.app).currentUser?.uid;
  if (!uid) {
    throw new Error('No authenticated Firebase user; cannot determine workspace owner');
  }

  const ref = doc(db, 'workspaces', wsId);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const owner = (existing.data() as { ownerUid?: unknown } | undefined)?.ownerUid;
    if (owner !== uid) {
      // Foreign-owned or unowned legacy doc: never overwrite, never claim.
      throw new ReadOnlyWorkspaceError(
        typeof owner === 'string'
          ? 'This workspace is owned by another device. This device is read-only; push from the original device.'
          : 'This legacy workspace has no owner and cannot be modified from here. It stays readable via pairing.'
      );
    }
  }

  const { iv, cipher } = await encryptJson(key, payload);
  await setDoc(ref, {
    wsId,
    ownerUid: uid,
    iv,
    cipher,
    updatedAt: Date.now(),
  });
}

/**
 * Decodes a base64url({ wsId, key }) pairing string, fetches workspaces/{wsId}
 * from Firestore, and decrypts { graph, tokenMap } locally. Returns null if missing.
 */
export async function pullAndDecrypt(
  pairString: string
): Promise<{ graph: KnowledgeGraph; tokenMap: TokenMap } | null> {
  let parsed: { wsId?: unknown; key?: unknown };
  try {
    parsed = decodeBase64UrlJson<{ wsId?: unknown; key?: unknown }>(pairString.trim());
  } catch (err) {
    throw new Error(
      `Invalid pairing string: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof parsed.wsId !== 'string' || !parsed.wsId || typeof parsed.key !== 'string' || !parsed.key) {
    throw new Error('Invalid pairing payload: missing wsId or key');
  }

  const cryptoKey = await importVaultKey(parsed.key);
  const db = await getDb();
  if (!db) {
    throw new Error('Firestore is not configured or unavailable');
  }
  const signedIn = await ensureSignedIn();
  if (!signedIn) {
    throw new Error('Firebase anonymous sign-in failed; cannot pull encrypted workspace');
  }

  const snap = await getDoc(doc(db, 'workspaces', parsed.wsId));
  if (!snap.exists()) {
    return null;
  }

  const data = snap.data() as { iv?: unknown; cipher?: unknown };
  if (typeof data.iv !== 'string' || typeof data.cipher !== 'string') {
    throw new Error('Malformed encrypted workspace document in Firestore');
  }

  return decryptJson<{ graph: KnowledgeGraph; tokenMap: TokenMap }>(cryptoKey, {
    iv: data.iv,
    cipher: data.cipher,
  });
}
