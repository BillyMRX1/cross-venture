// Clean product list & SKU label resolution for Buyer requests and tables.
// Pure TypeScript (no DOM): filters out raw placeholder ids, unresolved tokens,
// contract headings, and price-field labels, and labels unnamed document codes.
import type { ProductNode, Workspace } from '../types';
import { hydrate, parseNum, rehydrateText } from './util';

export interface ProductOption {
  skuId: string;
  label: string;
  rawName: string;
  isUnnamedCode: boolean;
}

const WHOLE_TOKEN_RE = /^\[?[A-Z][A-Z0-9_]*_\d+(?:#\d+)?\]?$/;
const EMBEDDED_BRACKET_TOKEN_RE = /\[[A-Z][A-Z0-9_]*_\d+(?:#\d+)?\]/;
const WHOLE_BRACKET_TOKEN_RE = /^\[[A-Z][A-Z0-9_]*_\d+(?:#\d+)?\]$/;
const RAW_PLACEHOLDER_ID_RE = /^(?:sku|prod|product|item|p)[_-]?\d+$/i;

function isPureNumericOrCurrency(value: string): boolean {
  const stripped = value
    .replace(/^(?:rp\.?|rs\.?|usd|idr|eur|gbp|jpy|sgd|aud|cad|chf)\s*/i, '')
    .replace(/^[$€£¥₹]\s*/, '')
    .replace(/\s*(?:usd|idr|eur|gbp|jpy|sgd|aud|cad|chf|rupiah|dolar|dollars?)$/i, '')
    .replace(/\s*(?:%|percent|pct|persen)$/i, '')
    .trim();
  return /^[+-]?(?:\d[\d.,]*|\.\d+)$/.test(stripped);
}

/**
 * True for empty strings, unresolved placeholder tokens ([SKU_1], SKU_1, etc.),
 * raw placeholder-style ids (sku_1, prod_1, p1), or pure numeric/currency/percent values.
 */
export function isRawPlaceholderId(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  if (WHOLE_TOKEN_RE.test(t) || EMBEDDED_BRACKET_TOKEN_RE.test(t)) return true;
  if (RAW_PLACEHOLDER_ID_RE.test(t)) return true;
  if (isPureNumericOrCurrency(t)) return true;
  return false;
}

const STRUCTURAL_HEADING_RE =
  /^(?:schedule|appendix|exhibit|annex|attachment|article|section|subsection|clause|part|item|table|figure|form|page|paragraph|chapter)\s+[a-z0-9ivxlc]+(?:\.[a-z0-9]+)*$/i;

const EXACT_CONTRACT_LABELS: ReadonlySet<string> = new Set([
  'recitals',
  'definitions',
  'core collection',
  'notes',
  'summary',
  'terms and conditions',
  'general terms',
  'standard terms',
  'commercial terms',
  'pricing terms',
  'payment terms',
  'delivery terms',
  'order terms',
  'rate card',
  'price sheet',
  'rate sheet',
  'table of contents',
  'overview',
  'preamble',
  'signatures',
  'signature block',
  'msrp',
  'srp',
  'rrp',
  'cogs',
  'sku',
  'skus',
  'product',
  'products',
  'product name',
  'item',
  'items',
  'item name',
  'description',
  'sku code',
  'sku id',
  'sku name',
]);

const CORE_PRICE_HEADING_WORDS: ReadonlySet<string> = new Set([
  'price',
  'prices',
  'pricing',
  'cost',
  'costs',
  'cogs',
  'margin',
  'margins',
  'floor',
  'cap',
  'caps',
  'discount',
  'discounts',
  'rebate',
  'rebates',
  'fee',
  'fees',
  'revenue',
  'revenues',
  'profit',
  'profits',
  'msrp',
  'srp',
  'rrp',
  'schedule',
  'appendix',
  'exhibit',
  'annex',
  'attachment',
  'section',
  'subsection',
  'clause',
  'article',
  'table',
  'header',
  'headers',
  'column',
  'columns',
  'subtotal',
  'total',
  'totals',
]);

const CONTRACT_PRICE_VOCAB: ReadonlySet<string> = new Set([
  ...CORE_PRICE_HEADING_WORDS,
  'net',
  'gross',
  'realized',
  'unit',
  'units',
  'wholesale',
  'retail',
  'standard',
  'list',
  'selling',
  'sale',
  'sales',
  'direct',
  'indirect',
  'published',
  'suggested',
  'recommended',
  'manufacturer',
  'manufacturers',
  'of',
  'goods',
  'sold',
  'per',
  'for',
  'and',
  'or',
  'the',
  'to',
  'in',
  'by',
  'on',
  'at',
  'as',
  'min',
  'minimum',
  'max',
  'maximum',
  'avg',
  'average',
  'base',
  'baseline',
  'target',
  'effective',
  'actual',
  'contract',
  'contracted',
  'invoice',
  'invoiced',
  'dealer',
  'distributor',
  'trade',
  'bulk',
  'volume',
  'tier',
  'tiered',
  'order',
  'purchase',
  'purchasing',
  'landed',
  'manufacturing',
  'production',
  'variable',
  'fixed',
  'shipping',
  'handling',
  'service',
  'management',
  'licensing',
  'royalty',
  'admin',
  'administrative',
  'rate',
  'rates',
  'card',
  'sheet',
  'summary',
  'grand',
  'line',
  'item',
  'sku',
  'product',
  'pct',
  'percent',
  'percentage',
  'ratio',
  'amount',
  'value',
  'threshold',
  'limit',
  'ceiling',
  'approval',
  'partner',
  'cash',
  'early',
  'payment',
  'delivery',
  'commercial',
  'financial',
  'usd',
  'eur',
  'gbp',
  'idr',
  'sgd',
  'aud',
  'cad',
  'jpy',
  'chf',
]);

/**
 * True for structural document headings (Schedule A, Section 4.3, Recitals) and
 * price-field / financial / contract header labels (Net Realized Unit Price,
 * Wholesale List Price, COGS, Gross Margin, Rate Card, etc.).
 */
export function isContractOrPriceLabel(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  if (STRUCTURAL_HEADING_RE.test(t)) return true;

  const collapsed = t.toLowerCase().replace(/\s+/g, ' ');
  if (EXACT_CONTRACT_LABELS.has(collapsed)) return true;

  const rawTokens = t.split(/[\s/—–:]+/).filter(Boolean);
  const words: string[] = [];
  for (const tok of rawTokens) {
    // Skip purely symbolic tokens like "($)", "(%)", "$", "%", "-".
    if (!/[A-Za-z0-9]/.test(tok)) continue;
    // Any token containing digits (e.g. "CAP-01", "250g") is not a pure label word.
    if (/\d/.test(tok)) return false;
    const w = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) continue;
    words.push(w);
  }
  if (words.length === 0) return false;

  let hasCore = false;
  for (const w of words) {
    if (!CONTRACT_PRICE_VOCAB.has(w)) return false;
    if (CORE_PRICE_HEADING_WORDS.has(w)) hasCore = true;
  }
  return hasCore;
}

const HYPHEN_OR_SLASH_CODE_RE = /^[A-Z0-9]+(?:[-/][A-Z0-9]+)+$/;
const PREFIX_DIGITS_CODE_RE = /^[A-Z]+[0-9]+[A-Z0-9]*$/;

/**
 * True for real document SKU codes that have no human product name (e.g.
 * SKU-RL01, RL-01, AE-DR01, PRD-104A, ITEM-A01, RL01), and false for raw
 * placeholder ids (sku_1, SKU_1) or multi-word product names.
 */
export function isUnnamedSkuCode(value: string): boolean {
  const t = value.trim();
  if (isRawPlaceholderId(t)) return false;
  if (t.length < 3 || t.length > 24) return false;
  if (/\s/.test(t)) return false;
  if (!/[A-Z]/.test(t) || !/\d/.test(t)) return false;
  return HYPHEN_OR_SLASH_CODE_RE.test(t) || PREFIX_DIGITS_CODE_RE.test(t);
}

function formatOptionLabel(rawName: string, isUnnamedCode: boolean): string {
  return isUnnamedCode ? `${rawName} (no name in documents)` : rawName;
}

/**
 * Resolve a ProductNode's display name locally from ws.tokenMap ONLY.
 * Returns null if unresolvable, a raw placeholder id, or a contract/price label.
 */
export function resolveProductName(ws: Workspace, product: ProductNode): string | null {
  const skuToken = (product.sku_token ?? '').trim();
  const skuId = (product.sku_id ?? '').trim();

  let candidate = '';
  if (skuToken) {
    if (WHOLE_BRACKET_TOKEN_RE.test(skuToken)) {
      const hydrated = hydrate(ws.tokenMap, skuToken);
      if (!hydrated) return null;
      candidate = hydrated;
    } else if (EMBEDDED_BRACKET_TOKEN_RE.test(skuToken)) {
      candidate = rehydrateText(skuToken, ws.tokenMap);
    } else {
      candidate = hydrate(ws.tokenMap, skuToken) || skuToken;
    }
  } else if (isUnnamedSkuCode(skuId)) {
    candidate = skuId;
  } else {
    return null;
  }

  candidate = candidate.trim();
  if (!candidate) return null;
  if (isRawPlaceholderId(candidate)) return null;
  if (isContractOrPriceLabel(candidate)) return null;
  return candidate;
}

function hasValidNumericToken(ws: Workspace, token: string): boolean {
  const t = (token ?? '').trim();
  if (!t) return false;
  const hydrated = hydrate(ws.tokenMap, t);
  if (hydrated) return parseNum(hydrated) !== null;
  if (!WHOLE_BRACKET_TOKEN_RE.test(t)) return parseNum(t) !== null;
  return false;
}

function pricingScore(ws: Workspace, product: ProductNode): number {
  let score = 0;
  if (hasValidNumericToken(ws, product.list_price_token)) score += 1;
  if (hasValidNumericToken(ws, product.cogs_token)) score += 1;
  return score;
}

function normalizeLabelKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a clean, deduplicated, sorted list of product options for a venture.
 * Named products appear first alphabetically; unnamed document codes appear
 * at the bottom in natural numeric order.
 */
export function cleanProductOptions(ws: Workspace, ventureId: string): ProductOption[] {
  const byKey = new Map<string, { option: ProductOption; score: number }>();

  for (const product of ws.graph.products) {
    if (product.venture_id !== ventureId) continue;
    const rawName = resolveProductName(ws, product);
    if (!rawName) continue;

    const isUnnamedCode = isUnnamedSkuCode(rawName);
    const label = formatOptionLabel(rawName, isUnnamedCode);
    const key = normalizeLabelKey(label);
    const score = pricingScore(ws, product);

    const existing = byKey.get(key);
    if (!existing || score > existing.score) {
      byKey.set(key, {
        option: { skuId: product.sku_id, label, rawName, isUnnamedCode },
        score,
      });
    }
  }

  const options = [...byKey.values()].map((entry) => entry.option);
  options.sort((a, b) => {
    if (a.isUnnamedCode !== b.isUnnamedCode) {
      return a.isUnnamedCode ? 1 : -1;
    }
    if (a.isUnnamedCode) {
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });

  return options;
}

/**
 * Clean display label for a specific skuId (for tables and drafts).
 * Returns '' if the SKU is missing, junk, or unresolvable.
 */
export function cleanSkuLabel(ws: Workspace, skuId: string): string {
  const product = ws.graph.products.find((p) => p.sku_id === skuId);
  if (!product) return '';
  const rawName = resolveProductName(ws, product);
  if (!rawName) return '';
  return formatOptionLabel(rawName, isUnnamedSkuCode(rawName));
}
