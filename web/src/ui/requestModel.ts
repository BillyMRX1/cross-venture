// Request records (Requests page) — local persistence (localStorage via the
// state.ts helpers) plus the deterministic views a record needs. All margin
// math stays in calc/marginEngine; this module only assembles inputs from a
// record + the loaded graph and formats the engine's output. No DOM here, so
// the pure parts run in Node tests.
import { evaluateDeal } from '../calc/marginEngine';
import { buildDrafts } from '../drafts/whatsapp';
import type { Badge, DealInput, DealRuleNode, Drafts, Verdict, Workspace } from '../types';
import { cleanSkuLabel } from './productPicker';
import { lsGet, lsRemove, lsSet } from './state';
import { hydrate, parseNum } from './util';

/* ---------- the record ---------- */

export interface RequestActivity {
  at: number;
  kind: 'created' | 'checked' | 'applied';
  note: string;
}

export interface RequestRecord {
  id: string; // DR-0001 …
  ventureId: string;
  createdAt: number;
  customer: string;
  skuId: string;
  discountPct: number;
  qty: number;
  activity: RequestActivity[];
}

const RECORDS_KEY = 'cv.requests';

function isRecord(v: unknown): v is RequestRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.ventureId === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.customer === 'string' &&
    typeof r.skuId === 'string' &&
    typeof r.discountPct === 'number' &&
    typeof r.qty === 'number' &&
    Array.isArray(r.activity)
  );
}

export function loadRequests(): RequestRecord[] {
  const raw = lsGet(RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

export function saveRequests(records: RequestRecord[]): void {
  lsSet(RECORDS_KEY, JSON.stringify(records));
}

export function clearAllRequests(): void {
  lsRemove(RECORDS_KEY);
}

export function removeRequestsForVenture(ventureId: string): number {
  const existing = loadRequests();
  const kept = existing.filter((r) => r.ventureId !== ventureId);
  const removed = existing.length - kept.length;
  if (removed > 0) saveRequests(kept);
  return removed;
}

export function remapRequestVentureIds(ventureIdMap: Record<string, string>): boolean {
  if (Object.keys(ventureIdMap).length === 0) return false;
  const existing = loadRequests();
  let changed = false;
  const updated = existing.map((r) => {
    const mapped = ventureIdMap[r.ventureId];
    if (mapped && mapped !== r.ventureId) {
      changed = true;
      return { ...r, ventureId: mapped };
    }
    return r;
  });
  if (changed) saveRequests(updated);
  return changed;
}

export function nextRequestId(records: RequestRecord[]): string {
  let max = 0;
  for (const r of records) {
    const m = /^DR-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `DR-${String(max + 1).padStart(4, '0')}`;
}

export function newRecord(ventureId: string): RequestRecord {
  return {
    id: '',
    ventureId,
    createdAt: Date.now(),
    customer: '',
    skuId: '',
    discountPct: 10,
    qty: 1,
    activity: [{ at: Date.now(), kind: 'created', note: 'Request created' }],
  };
}

/** Append an activity event; consecutive identical events are not repeated. */
export function pushActivity(rec: RequestRecord, kind: RequestActivity['kind'], note: string): void {
  const last = rec.activity[rec.activity.length - 1];
  if (last && last.kind === kind && last.note === note) return;
  rec.activity.push({ at: Date.now(), kind, note });
  if (rec.activity.length > 40) rec.activity.splice(0, rec.activity.length - 40);
}

/* ---------- graph lookups (hydrated locally, never from the cloud) ---------- */

export function ventureNameOf(ws: Workspace, ventureId: string): string {
  const v = ws.graph.ventures.find((x) => x.venture_id === ventureId) ?? null;
  return v ? hydrate(ws.tokenMap, v.venture_token) || v.venture_id : '';
}

export function skuNameOf(ws: Workspace, skuId: string): string {
  return cleanSkuLabel(ws, skuId);
}

/**
 * The partner who must approve above-cap discounts: a PartnerNode of this
 * venture, preferring the one whose approval_rules describe signing off.
 * The name is the graph value, re-hydrated locally — never invented.
 */
export function partnerNameOf(ws: Workspace, ventureId: string): string | null {
  const partners = ws.graph.partners.filter((p) => p.venture_id === ventureId);
  if (partners.length === 0) return null;
  const signer = partners.find((p) => /approv|sign(ing)?s?[- ]?off/i.test(p.approval_rules ?? '')) ?? partners[0];
  return hydrate(ws.tokenMap, signer.partner_token) || null;
}

export function qtyOf(rule: DealRuleNode): number {
  const m = /(\d+(?:\.\d+)?)/.exec(rule.min_qty_condition ?? '');
  return m ? Number.parseFloat(m[1]) : 0;
}

export function bestRule(ws: Workspace, ventureId: string, qty: number): DealRuleNode | null {
  const rules = ws.graph.dealRules.filter((r) => r.venture_id === ventureId);
  if (rules.length === 0) return null;
  const satisfied = rules.filter((r) => qty >= qtyOf(r)).sort((a, b) => qtyOf(b) - qtyOf(a));
  if (satisfied.length > 0) return satisfied[0] ?? null;
  return [...rules].sort((a, b) => qtyOf(a) - qtyOf(b))[0] ?? null;
}

export function citationOf(rule: DealRuleNode | null): string {
  if (!rule) return 'no contractual rule found for this venture';
  const page = rule.page_or_section?.trim() ? ` ${rule.page_or_section.trim()}` : '';
  return `${rule.source_doc_name}${page}`;
}

/* ---------- the deterministic per-record computation ---------- */

export interface RecordDeal {
  errors: string[];
  input: DealInput | null;
  verdict: Verdict | null;
  drafts: Drafts | null;
  rule: DealRuleNode | null;
  ventureName: string;
  skuName: string;
  partnerName: string | null;
  listPrice: number | null;
  cogs: number | null;
  floor: number | null;
  cap: number | null;
}

/** Assemble DealInput from the record + graph and run the margin engine. */
export function computeRecordDeal(ws: Workspace, rec: RequestRecord): RecordDeal {
  const deal: RecordDeal = {
    errors: [],
    input: null,
    verdict: null,
    drafts: null,
    rule: null,
    ventureName: '',
    skuName: '',
    partnerName: null,
    listPrice: null,
    cogs: null,
    floor: null,
    cap: null,
  };

  const venture = ws.graph.ventures.find((v) => v.venture_id === rec.ventureId) ?? null;
  if (!venture) {
    deal.errors.push('This request belongs to a venture that is not in the loaded workspace.');
    return deal;
  }
  deal.ventureName = ventureNameOf(ws, rec.ventureId);

  const product = ws.graph.products.find((p) => p.sku_id === rec.skuId && p.venture_id === rec.ventureId) ?? null;
  if (!product) deal.errors.push('Pick a product — this request has no product from the loaded workspace.');
  deal.skuName = product ? skuNameOf(ws, rec.skuId) : '';

  deal.listPrice = product ? parseNum(hydrate(ws.tokenMap, product.list_price_token)) : null;
  deal.cogs = product ? parseNum(hydrate(ws.tokenMap, product.cogs_token)) : null;
  deal.floor = parseNum(hydrate(ws.tokenMap, venture.min_margin_pct_token));
  deal.rule = bestRule(ws, rec.ventureId, Number.isFinite(rec.qty) ? rec.qty : 0);
  deal.cap = deal.rule ? parseNum(hydrate(ws.tokenMap, deal.rule.max_discount_pct_token)) : null;
  deal.partnerName = partnerNameOf(ws, rec.ventureId);

  if (product && deal.listPrice === null) deal.errors.push('List price is missing for this product in your documents.');
  if (product && deal.cogs === null) deal.errors.push('Unit cost is missing for this product in your documents.');
  if (deal.floor === null) deal.errors.push('The margin floor is missing for this venture in your documents.');
  if (!Number.isFinite(rec.discountPct) || rec.discountPct < 0 || rec.discountPct >= 100) {
    deal.errors.push('Discount must be between 0 and 100 (%).');
  }
  if (!Number.isFinite(rec.qty) || rec.qty < 1) deal.errors.push('Quantity must be at least 1 unit.');
  if (deal.errors.length > 0) return deal;

  deal.input = {
    listPrice: deal.listPrice ?? 0,
    cogs: deal.cogs ?? 0,
    marginFloorPct: deal.floor ?? 0,
    discountCapPct: deal.cap,
    requiresPartnerApproval: deal.rule ? deal.rule.requires_partner_approval : false,
    requestedDiscountPct: rec.discountPct,
    qty: rec.qty,
  };
  deal.verdict = evaluateDeal(deal.input);
  try {
    deal.drafts = buildDrafts(deal.input, deal.verdict, {
      buyerName: rec.customer.trim() || 'there',
      skuName: deal.skuName,
      ventureName: deal.ventureName,
      partnerName: deal.partnerName,
      citation: citationOf(deal.rule),
    });
  } catch {
    deal.drafts = null; // drafts are generated text; the numbers stay valid
  }
  return deal;
}

/* ---------- pricing table rows (numbers straight from the engine result) ---------- */

export interface PriceRow {
  retail: number;
  discountPct: number;
  unitPrice: number;
  unitCost: number;
  marginPct: number;
  belowFloor: boolean;
}

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export function pricingRows(deal: RecordDeal): { requested: PriceRow; suggested: PriceRow } | null {
  const { listPrice, cogs, floor, input, verdict } = deal;
  if (listPrice === null || cogs === null || !input || !verdict) return null;
  const row = (discountPct: number): PriceRow => {
    const d = Math.min(Math.max(discountPct, 0), 99.99) / 100;
    const unitPrice = round2(listPrice * (1 - d));
    const marginPct = unitPrice > 0 ? round2(((unitPrice - cogs) / unitPrice) * 100) : 0;
    return {
      retail: listPrice,
      discountPct,
      unitPrice,
      unitCost: cogs,
      marginPct,
      belowFloor: floor !== null && marginPct < floor - 1e-9,
    };
  };
  return { requested: row(input.requestedDiscountPct), suggested: row(verdict.counterDiscountPct) };
}

/* ---------- one row per relevant rule for the policy-check rail ---------- */

export type CheckState = 'pass' | 'fail' | 'na';

export interface PolicyCheck {
  label: string;
  status: string;
  state: CheckState;
  ruleId: string | null;
  linkLabel: string;
}

export function policyChecks(deal: RecordDeal, requestedMarginPct: number | null): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  const disc = deal.input ? deal.input.requestedDiscountPct : null;

  if (deal.floor !== null) {
    const passes = requestedMarginPct !== null && requestedMarginPct >= deal.floor - 1e-9;
    checks.push({
      label: `Margin floor ${fmtPct(deal.floor)}`,
      status: requestedMarginPct === null ? '—' : `${passes ? 'Passes' : 'Fails'} at ${disc === null ? '—' : fmtPct(disc)}`,
      state: requestedMarginPct === null ? 'na' : passes ? 'pass' : 'fail',
      ruleId: deal.rule ? deal.rule.rule_id : null,
      linkLabel: deal.rule ? deal.rule.page_or_section.trim() || citationOf(deal.rule) : 'no source',
    });
  }

  if (deal.cap !== null) {
    const passes = disc !== null && disc <= deal.cap + 1e-9;
    checks.push({
      label: `Discount cap ${fmtPct(deal.cap)} without partner approval`,
      status: disc === null ? '—' : `${passes ? 'Passes' : 'Fails'} at ${fmtPct(disc)}`,
      state: disc === null ? 'na' : passes ? 'pass' : 'fail',
      ruleId: deal.rule ? deal.rule.rule_id : null,
      linkLabel: deal.rule ? deal.rule.page_or_section.trim() || citationOf(deal.rule) : 'no source',
    });
  }

  const qtyRules = (deal.rule ? [deal.rule] : []).filter((r) => (r.min_qty_condition ?? '').trim());
  for (const r of qtyRules) {
    const min = qtyOf(r);
    const qty = deal.input ? deal.input.qty : null;
    const applies = qty !== null && qty >= min;
    checks.push({
      label: `Bulk tier ${r.min_qty_condition.trim()}`,
      status: qty === null ? '—' : `${applies ? 'Applies' : 'Not applicable'} (${qty} units)`,
      state: applies ? 'pass' : 'na',
      ruleId: r.rule_id,
      linkLabel: r.page_or_section.trim() || citationOf(r),
    });
  }
  return checks;
}

/* ---------- approval rail copy (partner name always from the graph) ---------- */

export interface ApprovalInfo {
  needed: boolean;
  note: string;
  message: string | null;
  buttonLabel: string | null;
}

export function approvalInfo(deal: RecordDeal): ApprovalInfo {
  const v = deal.verdict;
  if (!v || !deal.drafts) return { needed: false, note: 'Suggested offer needs no partner approval', message: null, buttonLabel: null };
  const pendingAboveCap = v.partnerPendingDiscountPct !== null || v.counterRequiresApproval;
  if (deal.drafts.partnerMessage && deal.partnerName && pendingAboveCap) {
    return {
      needed: true,
      note: `Above the cap — ${deal.partnerName} must sign off`,
      message: deal.drafts.partnerMessage,
      buttonLabel: `Copy message to ${deal.partnerName}`,
    };
  }
  if (v.badge === 'PARTNER SIGN-OFF NEEDED' && !deal.partnerName) {
    return { needed: true, note: 'Partner sign-off needed, but no partner is named in your documents.', message: null, buttonLabel: null };
  }
  return { needed: false, note: 'Suggested offer needs no partner approval', message: null, buttonLabel: null };
}

/* ---------- formatting ---------- */

export function fmtPct(v: number): string {
  return `${+v.toFixed(2)}%`;
}

export function fmtPct1(v: number): string {
  return `${v.toFixed(1)}%`;
}

export function statusLabel(badge: Badge): string {
  return badge === 'APPROVED' ? 'Approved' : badge === 'MARGIN BREACH' ? 'Margin breach' : 'Partner sign-off needed';
}
