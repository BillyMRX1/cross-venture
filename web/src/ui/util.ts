// WS-4 UI helpers — DOM building, toasts, clipboard, re-hydration utilities.
import type { TokenMap } from '../types';

export type NoteKind = 'note' | 'note--ok' | 'note--warn' | 'note--err';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return node;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  return String(e);
}

export function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function pct(v: number): string {
  return `${v.toFixed(2)}%`;
}

/* ---------- toasts ---------- */

export type ToastKind = 'ok' | 'warn' | 'error';

export function toast(msg: string, kind: ToastKind = 'ok'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = el('div', { class: `toast toast--${kind}` }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  window.setTimeout(() => {
    t.classList.remove('toast--in');
    t.classList.add('toast--out');
    window.setTimeout(() => t.remove(), 400);
  }, 4500);
}

/* ---------- clipboard with fallback ---------- */

export async function copyText(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied — paste it into WhatsApp`, 'ok');
      return;
    }
    throw new Error('Clipboard API unavailable');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) toast(`${label} copied — paste it into WhatsApp`, 'ok');
      else toast('Clipboard blocked — select the text and copy manually', 'warn');
    } catch {
      toast('Clipboard blocked — select the text and copy manually', 'warn');
    }
  }
}

/* ---------- token re-hydration (local only) ---------- */

const TOKEN_RE = /\[[A-Z][A-Z_]*_\d+\]/g;

export function hydrate(tokenMap: TokenMap, token: string | undefined | null): string {
  if (!token) return '';
  return tokenMap[token] ?? '';
}

/** Replace every [TOKEN_n] in a blinded string with its real local value. */
export function rehydrateText(text: string, tokenMap: TokenMap): string {
  if (!text) return text;
  return text.replace(TOKEN_RE, (t) => tokenMap[t] ?? t);
}

/** Parse a hydrated value like "$1,250.00", "55%", "40" into a number. */
export function parseNum(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const v = Number.parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

/* ---------- privacy self-check (Inspector) ---------- */

export interface LeakHit {
  token: string;
  value: string;
  where: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does any known real value from the token map appear verbatim in the exact
 * cloud payload? Numeric values are matched with digit boundaries so "40"
 * does not false-positive inside "1400"; name values are matched as whole
 * words, case-insensitively.
 */
export function findLeakedValues(tokenMap: TokenMap, cloudText: string, where: string): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const [token, raw] of Object.entries(tokenMap)) {
    const value = (raw ?? '').trim();
    if (value.length < 2) continue;
    const numeric = /^\$?[\d,]+(\.\d+)?$/.test(value);
    if (numeric) {
      const digits = value.replace(/[$,]/g, '');
      if (digits.replace(/\./g, '').length < 2) continue;
      const candidates = new Set<string>([digits]);
      if (/\.\d+$/.test(digits)) candidates.add(digits.replace(/\.0+$/, ''));
      let matched: string | null = null;
      for (const cand of candidates) {
        const re = new RegExp(`(?:^|[^0-9.,])${escapeRe(cand)}(?![0-9])`);
        if (re.test(cloudText)) {
          matched = cand;
          break;
        }
      }
      if (matched !== null) hits.push({ token, value: matched, where });
    } else {
      const re = new RegExp(`(?:^|[^A-Za-z])${escapeRe(value)}(?![A-Za-z])`, 'i');
      if (re.test(cloudText)) hits.push({ token, value, where });
    }
  }
  return hits;
}

/* ---------- ids ---------- */

export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
