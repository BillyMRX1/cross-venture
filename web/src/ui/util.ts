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

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does any known real value appear verbatim in the exact cloud payload?
 * CV-SEC-3 (2026-11-20, security Patch 4) — numeric values are matched in
 * several forms: plain digits (`1250`, `1250.00`), en grouping (`1,250.00`)
 * and id grouping (`1.250,00`), after stripping currency affixes
 * (`Rp $ € £ ¥ ₹ USD IDR EUR % percent pct persen …`); all numeric forms
 * keep digit-boundary guards so "40" never matches inside "1400". Names are
 * matched as whole words, case-insensitively; multi-word PARTNER values are
 * additionally checked by first and last word (mirrors anonymizer sweep
 * pass B — this can false-positive on common words like "Jakarta" or "Bank",
 * which fails closed: the pre-send gate blocks rather than leaks).
 * Best-effort by design: the return counts how many values were
 * actually scanned so the UI can be honest about scope.
 */
export interface LeakScan {
  hits: LeakHit[];
  checked: number; // values actually scanned (skipped values are not counted)
}

export function splitNumber(value: string): { int: string; dec: string | null } | null {
  const t = value.trim()
    .replace(/^(?:rp\.?|rs\.?|usd|idr|eur|gbp|jpy|sgd|aud|chf)\s*/i, '')
    .replace(/^(?:[$€£¥₹])\s*/i, '')
    .replace(/\s*(?:usd|idr|eur|gbp|jpy|sgd|aud|chf|rupiah|dolar|dollars?)$/i, '')
    .replace(/\s*(?:%|percent|pct|persen)$/i, '')
    .trim();
  if (!/^\d[\d.,]*$|^\d$/.test(t)) return null;
  const groups = t.split(/[.,]/).filter((g) => g.length > 0);
  if (groups.length === 0 || groups.some((g) => !/^\d+$/.test(g))) return null;
  let intGroups = groups;
  let dec: string | null = null;
  const last = groups[groups.length - 1];
  if (groups.length >= 2 && last.length <= 2) {
    dec = last;
    intGroups = groups.slice(0, -1);
  }
  const int = intGroups.join('');
  if (!/^\d+$/.test(int)) return null;
  return { int, dec };
}

export function numericForms(int: string, dec: string | null): string[] {
  const group = (sep: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const forms = new Set<string>();
  if (dec !== null) {
    forms.add(`${int}.${dec}`);
    forms.add(int);
    forms.add(`${group(',')}.${dec}`);
    forms.add(`${group('.')},${dec}`);
  } else {
    forms.add(int);
    forms.add(group(','));
    forms.add(group('.'));
  }
  return [...forms];
}

// Placeholder tokens appear in the outbound prompt as chunk-body tokens
// ([COST_15]), legend lines ([DISCOUNT_CAP_10] (type: ...)) and suffixed
// forms ([PARTNER_2#3]). Their INDEX DIGITS are not real values: a known
// short number like "15" used to match the "15" inside "[COST_15]" and
// blocked every send once a doc produced 10+ tokens of a type. Mask every
// token to a same-length run of '~' before scanning, so no digit inside a
// token can match while every boundary around the token stays exactly as
// it was ('[COST_1] 15' -> '~~~~~~~~ 15' still hits "15"). Values can never
// themselves contain '[', so masking can only remove token-internal
// matches — real verbatim values are never masked away.
const PLACEHOLDER_TOKEN_RE = /\[[A-Z][A-Z0-9_]*_\d+(?:#\d+)?\]/g;
// Chunk headers ("[DOC_1 p.10 #9]", built by graphExtractor.formatChunkLine
// from chunk metadata) carry page/index numbers, not document text. A known
// value "10" matched the "10" in "p.10" and blocked real multi-page PDFs.
const CHUNK_HEADER_RE = /\[DOC_\d+ p\.\d+ #\d+\]/g;

function maskPlaceholderTokens(text: string): string {
  return text
    .replace(CHUNK_HEADER_RE, (header) => '~'.repeat(header.length))
    .replace(PLACEHOLDER_TOKEN_RE, (token) => '~'.repeat(token.length));
}

export function findLeakedValues(tokenMap: TokenMap, cloudText: string, where: string): LeakScan {
  const hits: LeakHit[] = [];
  let checked = 0;
  const scanned = maskPlaceholderTokens(cloudText);
  for (const [token, raw] of Object.entries(tokenMap)) {
    const value = (raw ?? '').trim();
    if (value.length < 2) continue;
    const num = splitNumber(value);
    if (num !== null) {
      if (num.int.length < 2) continue;
      checked += 1;
      let matched: string | null = null;
      for (const form of numericForms(num.int, num.dec)) {
        // reject only a preceding digit or a separator glued to a digit, so
        // 'Rp.1250' / 'a,1250' still hit while '1400' never matches '40'.
        const re = new RegExp(`(?<![0-9])(?<![0-9][.,])${escapeRe(form)}(?![0-9])`);
        if (re.test(scanned)) {
          matched = form;
          break;
        }
      }
      if (matched !== null) hits.push({ token, value: matched, where });
      continue;
    }
    checked += 1;
    const re = new RegExp(`(?:^|[^A-Za-z])${escapeRe(value)}(?![A-Za-z])`, 'i');
    if (re.test(scanned)) {
      hits.push({ token, value, where });
      continue;
    }
    if (/^\[PARTNER_\d+(?:#\d+)?\]$/.test(token)) {
      const words = value.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
      if (words.length >= 2) {
        for (const part of [words[0], words[words.length - 1]]) {
          const w = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
          if (w.length < 3) continue;
          const partRe = new RegExp(`(?:^|[^A-Za-z])${escapeRe(w)}(?![A-Za-z])`, 'i');
          if (partRe.test(scanned)) {
            hits.push({ token, value: w, where });
            break;
          }
        }
      }
    }
  }
  return { hits, checked };
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
