// WS-4 natural-language deal query → DealInput fields.
// Tries on-device intent parsing via generate('query', …) (stage routing + the
// no-raw-text-to-cloud invariant is owned by WS-3); ALWAYS falls back to a
// local regex + fuzzy-name parser. Never sends raw text anywhere else.
import { generate } from '../hybrid';
import type { KnowledgeGraph, TokenMap } from '../types';
import { hydrate, parseNum } from './util';

export interface ParsedQuery {
  source: 'model' | 'regex';
  note: string;
  discountPct: number | null;
  qty: number | null;
  /** Free-text hint for the SKU the buyer mentioned (null = fuzzy-match whole message). */
  skuHint: string | null;
  /** Free-text hint for the venture mentioned (null = fuzzy-match whole message). */
  ventureHint: string | null;
}

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    venture: { type: 'string' },
    sku: { type: 'string' },
    discountPct: { type: 'number' },
    qty: { type: 'number' },
  },
} as const;

export function ventureLabels(graph: KnowledgeGraph, tokenMap: TokenMap): string[] {
  return graph.ventures.map((v) => hydrate(tokenMap, v.venture_token) || v.venture_id);
}

export function skuLabels(graph: KnowledgeGraph, tokenMap: TokenMap): string[] {
  return graph.products.map((p) => hydrate(tokenMap, p.sku_token) || p.sku_id);
}

export async function parseQuery(text: string, graph: KnowledgeGraph, tokenMap: TokenMap): Promise<ParsedQuery> {
  try {
    const res = await generate('query', buildPrompt(text, graph, tokenMap), QUERY_SCHEMA);
    const parsed = extractJson(res.text);
    if (parsed) {
      return {
        source: 'model',
        note: `${res.model || 'model'}${res.usedOnDevice ? ' · on-device' : ' · (reported non-local)'}`,
        discountPct: numField(parsed.discountPct),
        qty: numField(parsed.qty),
        skuHint: strField(parsed.sku),
        ventureHint: strField(parsed.venture),
      };
    }
    // Model answered but not with usable JSON — degrade quietly to regex.
  } catch {
    /* expected with WS-3 stubs / no on-device model: regex fallback below */
  }
  return regexParse(text);
}

function buildPrompt(text: string, graph: KnowledgeGraph, tokenMap: TokenMap): string {
  return [
    'You are a local offline intent parser for a deal-margin app. Parse the buyer message below into JSON only.',
    `Buyer message: """${text}"""`,
    `Known ventures: ${JSON.stringify(ventureLabels(graph, tokenMap))}`,
    `Known products/SKUs: ${JSON.stringify(skuLabels(graph, tokenMap))}`,
    'Return ONLY this JSON object (omit fields you cannot determine): ' +
      '{"venture": string, "sku": string, "discountPct": number, "qty": number}. ' +
      'discountPct is a plain percent number (20 means 20% off).',
  ].join('\n');
}

/* ---------- model-output JSON extraction (tolerates markdown fences) ---------- */

function extractJson(s: string): Record<string, unknown> | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fence && fence[1] ? fence[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(body.slice(start, i + 1)) as unknown;
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function numField(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseNum(v);
  return null;
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/* ---------- local regex fallback ---------- */

export function regexParse(text: string): ParsedQuery {
  const pctMatch = /(\d+(?:\.\d+)?)\s*(?:%|percent)/i.exec(text);
  const qtyMatch = /(\d+)\s*(?:units?|pcs?|pieces?|items?|orders?)/i.exec(text);
  return {
    source: 'regex',
    note: 'local regex fallback',
    discountPct: pctMatch ? Number.parseFloat(pctMatch[1]) : null,
    qty: qtyMatch ? Number.parseFloat(qtyMatch[1]) : null,
    skuHint: null,
    ventureHint: null,
  };
}

/* ---------- fuzzy name matching against graph labels ---------- */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

/**
 * Best match of `query` (may be the whole buyer message) against candidate
 * display labels. Containment is strong, shared content words medium,
 * near-exact spelling weak-but-accepted. Returns null when nothing is close.
 */
export function fuzzyMatch(query: string, candidates: string[]): string | null {
  const q = norm(query);
  if (!q) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const cand of candidates) {
    const cn = norm(cand);
    if (!cn) continue;
    let score = 0;
    if (cn === q) score = 1000;
    else if (q.includes(cn)) score = 500 + cn.length;
    else if (cn.includes(q) && q.length >= 4) score = 300 + q.length;
    else {
      const words = cn.split(' ').filter((w) => w.length >= 3);
      const overlap = words.filter((w) => q.includes(w)).length;
      if (overlap > 0) score = overlap * 40;
      if (score === 0 && Math.abs(cn.length - q.length) <= 4 && levenshtein(cn, q) <= 2) score = 20;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return bestScore >= 20 ? best : null;
}
