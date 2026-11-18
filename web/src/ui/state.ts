// WS-4 shared app store + safe localStorage + cross-tab navigation hook.
import type { Workspace } from '../types';

type Listener = () => void;

let workspace: Workspace | null = null;
let vaultKey: CryptoKey | null = null;
let vaultKeyString: string | null = null;

const listeners = new Set<Listener>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a broken tab must not break the others
    }
  }
}

export const store = {
  get workspace(): Workspace | null {
    return workspace;
  },
  setWorkspace(ws: Workspace | null): void {
    workspace = ws;
    emit();
  },
  get vaultKey(): CryptoKey | null {
    return vaultKey;
  },
  get vaultKeyString(): string | null {
    return vaultKeyString;
  },
  setVault(key: CryptoKey | null, exported: string | null): void {
    vaultKey = key;
    vaultKeyString = exported;
    emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/* ---------- localStorage (never throws) ---------- */

export function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — tab simply won't persist */
  }
}

/* ---------- tab navigation (registered by main.ts, used by empty states) ---------- */

let tabSetter: ((tab: string) => void) | null = null;

export function registerTabSetter(fn: (tab: string) => void): void {
  tabSetter = fn;
}

export function goTab(tab: string): void {
  if (tabSetter) tabSetter(tab);
}
