import type { Workspace } from '../types';
import { lsGet, lsSet } from './state';
import { el, hydrate } from './util';

export const MULTI_VENTURE_HINT_TEXT = 'Each company keeps its own rules and requests.';
export const MULTI_VENTURE_HINT_KEY = 'cv.multiVentureHintSeen';

export interface SwitcherOption {
  ventureId: string;
  label: string;
}

const LEADING_ENTITY_RE = /^(?:pt)\s+(?=\S)/;
const TRAILING_ENTITY_RE =
  /\s+(?:pte\s+ltd|co\s+ltd|llc|llp|lp|inc|incorporated|ltd|limited|corp|corporation|co|company|gmbh|pt|pte|plc|bv|nv|sa|sarl|tbk)$/;

function normalizeVentureName(raw: string): string {
  // Collapse dotted initialisms ("L.L.C." -> "llc", "Inc." -> "inc", "Pte. Ltd." -> "pte ltd"),
  // replace remaining punctuation with spaces, and normalize whitespace.
  let s = raw
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  s = s.replace(LEADING_ENTITY_RE, '').trim();

  let prev = '';
  while (s !== prev) {
    prev = s;
    const next = s.replace(TRAILING_ENTITY_RE, '').trim();
    if (!next) break;
    s = next;
  }

  return s;
}

export function uniqueVentureOptions(ws: Workspace | null): SwitcherOption[] {
  if (!ws || ws.graph.ventures.length === 0) return [];

  const seen = new Set<string>();
  const options: SwitcherOption[] = [];

  for (const v of ws.graph.ventures) {
    const hydrated = hydrate(ws.tokenMap, v.venture_token).trim();
    const label = hydrated || v.venture_id;
    const key = normalizeVentureName(label) || label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ ventureId: v.venture_id, label });
  }

  return options;
}

export function shouldShowMultiVentureHint(
  ventureCount: number,
  storage: { get: (k: string) => string | null },
): boolean {
  return ventureCount > 1 && !storage.get(MULTI_VENTURE_HINT_KEY);
}

export function markMultiVentureHintSeen(
  storage: { set: (k: string, v: string) => void },
): void {
  storage.set(MULTI_VENTURE_HINT_KEY, '1');
}

export function mountVentureSwitcherCue(
  sel: HTMLSelectElement,
  options: {
    getWorkspace: () => Workspace | null;
    getCurrentVentureId: () => string;
    onSelectVenture: (ventureId: string) => void;
    storage?: { get: (k: string) => string | null; set: (k: string, v: string) => void };
  },
): { refresh: () => void } {
  const storage = options.storage ?? { get: lsGet, set: lsSet };

  if (sel.parentElement && !sel.parentElement.querySelector('label.venture-label')) {
    const label = el('label', { for: sel.id || 'ventureSwitch', class: 'venture-label' }, 'Venture');
    sel.parentElement.insertBefore(label, sel);
  }

  const existingHint = document.getElementById('ventureHint');
  if (existingHint) existingHint.remove();

  const dismissBtn = el('button', { type: 'button', class: 'link venture-hint-dismiss' }, 'Got it');
  const hint = el(
    'div',
    { class: 'venture-hint', id: 'ventureHint', role: 'status' },
    el('span', {}, MULTI_VENTURE_HINT_TEXT),
    dismissBtn,
  );
  hint.hidden = true;

  dismissBtn.addEventListener('click', () => {
    markMultiVentureHintSeen(storage);
    hint.hidden = true;
  });

  const topbar = document.querySelector('.topbar');
  const anchor = topbar ?? sel.parentElement;
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(hint, anchor.nextSibling);
  }

  const refresh = (): void => {
    const opts = uniqueVentureOptions(options.getWorkspace());
    sel.replaceChildren();
    if (opts.length === 0) {
      const emptyOpt = el('option', { value: '' }, 'No workspace loaded');
      emptyOpt.disabled = true;
      sel.append(emptyOpt);
      sel.disabled = true;
      hint.hidden = true;
      return;
    }
    sel.disabled = false;
    const current = options.getCurrentVentureId();
    for (const item of opts) {
      const opt = el('option', { value: item.ventureId }, item.label);
      if (item.ventureId === current) opt.selected = true;
      sel.append(opt);
    }
    if (current && opts.some((item) => item.ventureId === current)) {
      sel.value = current;
    }
    hint.hidden = !shouldShowMultiVentureHint(opts.length, storage);
  };

  sel.addEventListener('change', () => {
    options.onSelectVenture(sel.value);
    if (!hint.hidden) {
      markMultiVentureHintSeen(storage);
      hint.hidden = true;
    }
  });

  refresh();
  return { refresh };
}
