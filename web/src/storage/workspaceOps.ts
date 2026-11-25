import type {
  DealRuleNode,
  PartnerNode,
  ProductNode,
  TokenMap,
  VentureNode,
  Workspace,
} from '../types';
import { hydrate, parseNum, rehydrateText } from '../ui/util';

export interface VentureDocEntry {
  docName: string;
  pages: number;
  chunks: number;
  ruleCount: number;
}

export interface VentureDocGroup {
  ventureId: string | null;
  ventureName: string;
  docs: VentureDocEntry[];
}

export interface DedupeResult {
  workspace: Workspace;
  changed: boolean;
  ventureIdMap: Record<string, string>;
}

const LEADING_PREFIX_RE = /^(?:the|pt|cv)\s+(?=\S)/;
const TRAILING_SUFFIX_RE =
  /\s+(?:l l c|pte ltd|llc|incorporated|inc|limited|ltd|corporation|corp|company|co|gmbh|sa|bv|ab|pt|cv|llp|lp|plc|ag|nv|srl|sas|kk)$/;

const TOKEN_PARSE_RE = /^\[([A-Z][A-Z0-9_]*)_(\d+)(#\d+)?\]$/;
const TOKEN_SCAN_RE = /\[([A-Z][A-Z0-9_]*)_(\d+)(#\d+)?\]/g;

/**
 * Normalizes a venture legal name for deduplication matching:
 * lowercase, strip dots & punctuation, strip leading "the"/"pt"/"cv",
 * and strip trailing legal entity suffixes (including repeated forms).
 */
export function normalizeVentureName(raw: string): string {
  if (!raw) return '';
  let s = raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return '';

  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(LEADING_PREFIX_RE, '').trim();
  }

  prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(TRAILING_SUFFIX_RE, '').trim();
  }

  return s.replace(/\s+/g, ' ').trim();
}

function normalizeLabel(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveWorkspaceName(docs: Workspace['docs'], fallback: string): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const d of docs) {
    const lower = d.docName.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      names.push(d.docName);
    }
  }
  if (names.length > 0) {
    return names.join(' + ').slice(0, 80);
  }
  return fallback || 'Workspace';
}

function buildCanonicalDocNameMap(ws: Workspace): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const d of ws.docs) {
    const lower = d.docName.toLowerCase();
    if (!canonical.has(lower)) canonical.set(lower, d.docName);
  }
  for (const r of ws.graph.dealRules) {
    if (!r.source_doc_name) continue;
    const lower = r.source_doc_name.toLowerCase();
    if (!canonical.has(lower)) canonical.set(lower, r.source_doc_name);
  }
  return canonical;
}

/**
 * Determines which documents belong to each venture via:
 * (a) dealRules source_doc_name -> venture_id, and
 * (b) scanning blindedText chunks for each venture's venture_token,
 *     partner_token, or sku_token.
 */
export function docNamesByVenture(ws: Workspace): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const canonicalDocName = buildCanonicalDocNameMap(ws);
  const tokensByVenture = new Map<string, Set<string>>();

  // Precompute normalized venture names for all VENTURE_* tokens in tokenMap
  const ventureTokensByNorm = new Map<string, string[]>();
  for (const [tok, val] of Object.entries(ws.tokenMap)) {
    if (/^\[VENTURE_\d+(?:#\d+)?\]$/.test(tok)) {
      const norm = normalizeVentureName(val);
      if (norm) {
        const list = ventureTokensByNorm.get(norm) ?? [];
        list.push(tok);
        ventureTokensByNorm.set(norm, list);
      }
    }
  }

  for (const v of ws.graph.ventures) {
    result.set(v.venture_id, new Set<string>());
    const tokSet = new Set<string>();
    if (v.venture_token) tokSet.add(v.venture_token);
    const normName = normalizeVentureName(hydrate(ws.tokenMap, v.venture_token));
    if (normName) {
      for (const aliasTok of ventureTokensByNorm.get(normName) ?? []) {
        tokSet.add(aliasTok);
      }
    }
    tokensByVenture.set(v.venture_id, tokSet);
  }

  for (const p of ws.graph.partners) {
    const tokSet = tokensByVenture.get(p.venture_id);
    if (tokSet && p.partner_token) tokSet.add(p.partner_token);
  }

  for (const prod of ws.graph.products) {
    const tokSet = tokensByVenture.get(prod.venture_id);
    if (tokSet && prod.sku_token) tokSet.add(prod.sku_token);
  }

  // (a) dealRules matching source_doc_name -> venture_id
  for (const rule of ws.graph.dealRules) {
    if (!rule.source_doc_name) continue;
    const set = result.get(rule.venture_id);
    if (!set) continue;
    const canon = canonicalDocName.get(rule.source_doc_name.toLowerCase()) ?? rule.source_doc_name;
    set.add(canon);
  }

  // (b) scanning each doc's blindedText chunks for venture/partner/sku tokens
  for (const chunk of ws.docs) {
    const canon = canonicalDocName.get(chunk.docName.toLowerCase()) ?? chunk.docName;
    for (const [ventureId, tokSet] of tokensByVenture.entries()) {
      const docSet = result.get(ventureId)!;
      if (docSet.has(canon)) continue;
      for (const tok of tokSet) {
        if (tok && chunk.blindedText.includes(tok)) {
          docSet.add(canon);
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Groups unique documents under each venture's hydrated display name, plus an
 * "Unassigned documents" group (ventureId: null) only if unmatched docs exist.
 */
export function groupDocumentsByVenture(ws: Workspace): VentureDocGroup[] {
  const byVenture = docNamesByVenture(ws);

  const docStats = new Map<string, { docName: string; pages: Set<number>; chunks: number }>();
  for (const chunk of ws.docs) {
    const lower = chunk.docName.toLowerCase();
    let stat = docStats.get(lower);
    if (!stat) {
      stat = { docName: chunk.docName, pages: new Set<number>(), chunks: 0 };
      docStats.set(lower, stat);
    }
    stat.pages.add(chunk.page);
    stat.chunks += 1;
  }

  const assignedLower = new Set<string>();
  const groups: VentureDocGroup[] = [];

  for (const v of ws.graph.ventures) {
    const ventureDocs = byVenture.get(v.venture_id) ?? new Set<string>();
    const entries: VentureDocEntry[] = [];
    const seenInGroup = new Set<string>();

    for (const docName of ventureDocs) {
      const lower = docName.toLowerCase();
      if (seenInGroup.has(lower)) continue;
      const stat = docStats.get(lower);
      // Skip unresolved aliases / phantom rule citations when real loaded docs exist.
      if (docStats.size > 0 && !stat) continue;
      seenInGroup.add(lower);
      assignedLower.add(lower);
      let ruleCount = 0;
      for (const r of ws.graph.dealRules) {
        if (r.venture_id === v.venture_id && r.source_doc_name.toLowerCase() === lower) {
          ruleCount += 1;
        }
      }
      entries.push({
        docName: stat?.docName ?? docName,
        pages: stat?.pages.size ?? 0,
        chunks: stat?.chunks ?? 0,
        ruleCount,
      });
    }

    const ventureName =
      hydrate(ws.tokenMap, v.venture_token) ||
      rehydrateText(v.venture_token, ws.tokenMap) ||
      v.venture_id;

    groups.push({
      ventureId: v.venture_id,
      ventureName,
      docs: entries,
    });
  }

  const unassignedEntries: VentureDocEntry[] = [];
  for (const [lower, stat] of docStats.entries()) {
    if (assignedLower.has(lower)) continue;
    let ruleCount = 0;
    for (const r of ws.graph.dealRules) {
      if (r.source_doc_name.toLowerCase() === lower) {
        ruleCount += 1;
      }
    }
    unassignedEntries.push({
      docName: stat.docName,
      pages: stat.pages.size,
      chunks: stat.chunks,
      ruleCount,
    });
  }

  if (unassignedEntries.length > 0) {
    groups.push({
      ventureId: null,
      ventureName: 'Unassigned documents',
      docs: unassignedEntries,
    });
  }

  return groups;
}

function hasValidNumericToken(tokenMap: TokenMap, token: string): boolean {
  if (!token) return false;
  return parseNum(hydrate(tokenMap, token)) !== null;
}

/**
 * Merges duplicate ventures within a single Workspace and deduplicates
 * partners, products, dealRules, and doc chunks. Does not mutate ws.
 */
export function deduplicateWorkspace(ws: Workspace): DedupeResult {
  let changed = false;
  const ventureIdMap: Record<string, string> = {};

  // 1. Deduplicate ventures by normalized hydrated name (fallback to venture_id)
  const ventureByKey = new Map<string, VentureNode>();
  const ventures: VentureNode[] = [];

  for (const v of ws.graph.ventures) {
    const hydratedName = hydrate(ws.tokenMap, v.venture_token);
    const norm = normalizeVentureName(hydratedName);
    const key = norm ? `name:${norm}` : `id:${v.venture_id}`;

    const existing = ventureByKey.get(key);
    if (!existing) {
      const copy: VentureNode = { ...v };
      ventureByKey.set(key, copy);
      ventures.push(copy);
    } else {
      changed = true;
      if (v.venture_id !== existing.venture_id) {
        ventureIdMap[v.venture_id] = existing.venture_id;
      }
      if (
        !hasValidNumericToken(ws.tokenMap, existing.min_margin_pct_token) &&
        hasValidNumericToken(ws.tokenMap, v.min_margin_pct_token)
      ) {
        existing.min_margin_pct_token = v.min_margin_pct_token;
      } else if (!existing.min_margin_pct_token && v.min_margin_pct_token) {
        existing.min_margin_pct_token = v.min_margin_pct_token;
      }
    }
  }

  const remapVid = (vid: string): string => {
    const mapped = ventureIdMap[vid];
    if (mapped && mapped !== vid) {
      changed = true;
      return mapped;
    }
    return vid;
  };

  // 2. Deduplicate partners within same venture_id by normalized hydrated name
  const partnerByKey = new Map<string, PartnerNode>();
  const partners: PartnerNode[] = [];

  for (const p of ws.graph.partners) {
    const vid = remapVid(p.venture_id);
    const hydratedPartner = hydrate(ws.tokenMap, p.partner_token);
    const normPartner = normalizeLabel(hydratedPartner) || p.partner_token.trim().toLowerCase() || p.partner_id;
    const key = `${vid}\u0000${normPartner}`;

    const existing = partnerByKey.get(key);
    if (!existing) {
      const copy: PartnerNode = { ...p, venture_id: vid };
      partnerByKey.set(key, copy);
      partners.push(copy);
    } else {
      changed = true;
      if (p.approval_rules.trim().length > existing.approval_rules.trim().length) {
        existing.approval_rules = p.approval_rules;
      }
      if (!existing.partner_token && p.partner_token) {
        existing.partner_token = p.partner_token;
      }
    }
  }

  // 3. Deduplicate products within same venture_id by normalized hydrated sku_token (or sku_id fallback)
  const productByKey = new Map<string, ProductNode>();
  const products: ProductNode[] = [];

  const productScore = (prod: ProductNode): number => {
    const hasPrice = hasValidNumericToken(ws.tokenMap, prod.list_price_token);
    const hasCogs = hasValidNumericToken(ws.tokenMap, prod.cogs_token);
    if (hasPrice && hasCogs) return 2;
    if (hasPrice || hasCogs) return 1;
    return 0;
  };

  for (const prod of ws.graph.products) {
    const vid = remapVid(prod.venture_id);
    const hydratedSku = hydrate(ws.tokenMap, prod.sku_token);
    const normSku = normalizeLabel(hydratedSku) || prod.sku_id.trim().toLowerCase();
    const key = `${vid}\u0000${normSku}`;

    const existing = productByKey.get(key);
    if (!existing) {
      const copy: ProductNode = { ...prod, venture_id: vid };
      productByKey.set(key, copy);
      products.push(copy);
    } else {
      changed = true;
      const candScore = productScore(prod);
      const currScore = productScore(existing);
      if (candScore > currScore) {
        existing.list_price_token = prod.list_price_token;
        existing.cogs_token = prod.cogs_token;
        if (!hydrate(ws.tokenMap, existing.sku_token) && hydrate(ws.tokenMap, prod.sku_token)) {
          existing.sku_token = prod.sku_token;
        }
      } else {
        if (
          !hasValidNumericToken(ws.tokenMap, existing.list_price_token) &&
          hasValidNumericToken(ws.tokenMap, prod.list_price_token)
        ) {
          existing.list_price_token = prod.list_price_token;
        }
        if (
          !hasValidNumericToken(ws.tokenMap, existing.cogs_token) &&
          hasValidNumericToken(ws.tokenMap, prod.cogs_token)
        ) {
          existing.cogs_token = prod.cogs_token;
        }
      }
    }
  }

  // 4. Deduplicate dealRules within same venture_id
  const ruleByKey = new Map<string, DealRuleNode>();
  const dealRules: DealRuleNode[] = [];

  for (const r of ws.graph.dealRules) {
    const vid = remapVid(r.venture_id);
    const hydratedDisc = hydrate(ws.tokenMap, r.max_discount_pct_token).trim().toLowerCase();
    const discNum = parseNum(hydratedDisc);
    const discKey =
      discNum !== null
        ? String(discNum)
        : hydratedDisc || r.max_discount_pct_token.trim().toLowerCase();
    const key = [
      vid,
      r.source_doc_name.trim().toLowerCase(),
      r.page_or_section.trim().toLowerCase(),
      discKey,
      r.min_qty_condition.trim().toLowerCase(),
    ].join('\u0000');

    const existing = ruleByKey.get(key);
    if (!existing) {
      const copy: DealRuleNode = { ...r, venture_id: vid };
      ruleByKey.set(key, copy);
      dealRules.push(copy);
    } else {
      changed = true;
      if (!existing.verbatim_blinded_excerpt.trim() && r.verbatim_blinded_excerpt.trim()) {
        existing.verbatim_blinded_excerpt = r.verbatim_blinded_excerpt;
      }
    }
  }

  // 5. Deduplicate docs chunks by (docName.toLowerCase(), page, index) keeping latest occurrence
  const lastDocIdx = new Map<string, number>();
  for (let i = 0; i < ws.docs.length; i++) {
    const d = ws.docs[i];
    const key = `${d.docName.toLowerCase()}\u0000${d.page}\u0000${d.index}`;
    if (lastDocIdx.has(key)) changed = true;
    lastDocIdx.set(key, i);
  }
  const docs: Workspace['docs'] = [];
  for (let i = 0; i < ws.docs.length; i++) {
    const d = ws.docs[i];
    const key = `${d.docName.toLowerCase()}\u0000${d.page}\u0000${d.index}`;
    if (lastDocIdx.get(key) === i) {
      docs.push({ ...d });
    }
  }

  const workspace: Workspace = {
    ...ws,
    tokenMap: { ...ws.tokenMap },
    graph: {
      ventures,
      partners,
      products,
      dealRules,
    },
    docs,
    payloadLog: ws.payloadLog.map((p) => ({ ...p })),
  };

  return { workspace, changed, ventureIdMap };
}

function rewriteTokensInText(text: string, remap: Map<string, string>): string {
  if (!text || remap.size === 0) return text;
  return text.replace(TOKEN_SCAN_RE, (full, _type, _num, suffix) => {
    const direct = remap.get(full);
    if (direct) return direct;
    if (suffix) {
      const base = `${full.slice(0, full.length - suffix.length - 1)}]`;
      const mappedBase = remap.get(base);
      if (mappedBase && mappedBase.endsWith(']')) {
        return `${mappedBase.slice(0, -1)}${suffix}]`;
      }
    }
    return full;
  });
}

function rewriteTokenField(field: string, remap: Map<string, string>): string {
  if (!field || remap.size === 0) return field;
  const direct = remap.get(field);
  if (direct) return direct;
  return rewriteTokensInText(field, remap);
}

function allocateUniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}__${n}`)) {
    n += 1;
  }
  const candidate = `${base}__${n}`;
  used.add(candidate);
  return candidate;
}

/**
 * Merges incoming workspace into existing (preserving existing.id) with
 * token collision prevention, same-file replacement, and full venture dedupe.
 * Does not mutate existing or incoming in place.
 */
export function mergeWorkspaces(existing: Workspace | null, incoming: Workspace): DedupeResult {
  if (!existing) {
    return deduplicateWorkspace(incoming);
  }

  // 1. Build merged tokenMap and remap table for incoming tokens
  const mergedTokenMap: TokenMap = { ...existing.tokenMap };
  const existingByTypeAndVal = new Map<string, string>();
  const maxNumByType = new Map<string, number>();

  for (const [tok, val] of Object.entries(existing.tokenMap)) {
    const m = TOKEN_PARSE_RE.exec(tok);
    if (!m) continue;
    const [, type, numStr, suffix] = m;
    const num = Number.parseInt(numStr, 10);
    maxNumByType.set(type, Math.max(maxNumByType.get(type) ?? 0, num));
    if (!suffix) {
      const lookupKey = `${type}\u0000${val.trim().toLowerCase()}`;
      if (!existingByTypeAndVal.has(lookupKey)) {
        existingByTypeAndVal.set(lookupKey, tok);
      }
    }
  }

  const tokenRemap = new Map<string, string>();

  for (const [inTok, inVal] of Object.entries(incoming.tokenMap)) {
    const m = TOKEN_PARSE_RE.exec(inTok);
    if (!m) {
      if (mergedTokenMap[inTok] === undefined) {
        mergedTokenMap[inTok] = inVal;
      }
      continue;
    }

    const [, type, numStr, suffix] = m;
    const lookupKey = `${type}\u0000${inVal.trim().toLowerCase()}`;

    if (!suffix) {
      const reusable = existingByTypeAndVal.get(lookupKey);
      if (reusable) {
        if (reusable !== inTok) {
          tokenRemap.set(inTok, reusable);
        }
        continue;
      }
    }

    if (mergedTokenMap[inTok] === undefined) {
      mergedTokenMap[inTok] = inVal;
      const num = Number.parseInt(numStr, 10);
      maxNumByType.set(type, Math.max(maxNumByType.get(type) ?? 0, num));
      if (!suffix) {
        existingByTypeAndVal.set(lookupKey, inTok);
      }
    } else {
      let next = (maxNumByType.get(type) ?? 0) + 1;
      let candidate = `[${type}_${next}${suffix ?? ''}]`;
      while (mergedTokenMap[candidate] !== undefined) {
        next += 1;
        candidate = `[${type}_${next}${suffix ?? ''}]`;
      }
      maxNumByType.set(type, next);
      mergedTokenMap[candidate] = inVal;
      if (!suffix) {
        existingByTypeAndVal.set(lookupKey, candidate);
      }
      tokenRemap.set(inTok, candidate);
    }
  }

  // 2. Same-file replacement against existing docs, payloadLog, and dealRules
  const incomingDocNamesLower = new Set(incoming.docs.map((d) => d.docName.toLowerCase()));
  const keptExistingDocs = existing.docs
    .filter((d) => !incomingDocNamesLower.has(d.docName.toLowerCase()))
    .map((d) => ({ ...d }));
  const keptExistingPayloadLog = existing.payloadLog
    .filter((p) => !incomingDocNamesLower.has(p.docName.toLowerCase()))
    .map((p) => ({ ...p }));
  const keptExistingRules = existing.graph.dealRules
    .filter((r) => !incomingDocNamesLower.has(r.source_doc_name.toLowerCase()))
    .map((r) => ({ ...r }));

  // 3. Disambiguate colliding entity IDs in incoming so distinct ventures never share an ID
  const usedVentureIds = new Set(existing.graph.ventures.map((v) => v.venture_id));
  const usedPartnerIds = new Set(existing.graph.partners.map((p) => p.partner_id));
  const usedSkuIds = new Set(existing.graph.products.map((p) => p.sku_id));
  const usedRuleIds = new Set(keptExistingRules.map((r) => r.rule_id));

  const incomingVidRemap = new Map<string, string>();
  const remappedIncomingVentures: VentureNode[] = incoming.graph.ventures.map((v) => {
    const newVid = allocateUniqueId(v.venture_id, usedVentureIds);
    if (newVid !== v.venture_id) {
      incomingVidRemap.set(v.venture_id, newVid);
    }
    return {
      venture_id: newVid,
      venture_token: rewriteTokenField(v.venture_token, tokenRemap),
      min_margin_pct_token: rewriteTokenField(v.min_margin_pct_token, tokenRemap),
    };
  });

  const mapIncomingVid = (vid: string): string => incomingVidRemap.get(vid) ?? vid;

  const remappedIncomingPartners: PartnerNode[] = incoming.graph.partners.map((p) => ({
    partner_id: allocateUniqueId(p.partner_id, usedPartnerIds),
    partner_token: rewriteTokenField(p.partner_token, tokenRemap),
    venture_id: mapIncomingVid(p.venture_id),
    approval_rules: rewriteTokensInText(p.approval_rules, tokenRemap),
  }));

  const remappedIncomingProducts: ProductNode[] = incoming.graph.products.map((prod) => ({
    sku_id: allocateUniqueId(prod.sku_id, usedSkuIds),
    sku_token: rewriteTokenField(prod.sku_token, tokenRemap),
    venture_id: mapIncomingVid(prod.venture_id),
    cogs_token: rewriteTokenField(prod.cogs_token, tokenRemap),
    list_price_token: rewriteTokenField(prod.list_price_token, tokenRemap),
  }));

  const remappedIncomingRules: DealRuleNode[] = incoming.graph.dealRules.map((r) => ({
    rule_id: allocateUniqueId(r.rule_id, usedRuleIds),
    venture_id: mapIncomingVid(r.venture_id),
    max_discount_pct_token: rewriteTokenField(r.max_discount_pct_token, tokenRemap),
    min_qty_condition: r.min_qty_condition,
    requires_partner_approval: r.requires_partner_approval,
    source_doc_name: r.source_doc_name,
    page_or_section: r.page_or_section,
    verbatim_blinded_excerpt: rewriteTokensInText(r.verbatim_blinded_excerpt, tokenRemap),
  }));

  const remappedIncomingDocs: Workspace['docs'] = incoming.docs.map((d) => ({
    ...d,
    blindedText: rewriteTokensInText(d.blindedText, tokenRemap),
  }));

  // Exact verbatim cloudText in payloadLog must NOT be mutated
  const combinedPayloadLog = [
    ...keptExistingPayloadLog,
    ...incoming.payloadLog.map((p) => ({ ...p })),
  ];

  const combinedDocs = [...keptExistingDocs, ...remappedIncomingDocs];

  const combined: Workspace = {
    id: existing.id,
    name: deriveWorkspaceName(combinedDocs, existing.name || incoming.name || 'Workspace'),
    graph: {
      ventures: [...existing.graph.ventures.map((v) => ({ ...v })), ...remappedIncomingVentures],
      partners: [...existing.graph.partners.map((p) => ({ ...p })), ...remappedIncomingPartners],
      products: [...existing.graph.products.map((p) => ({ ...p })), ...remappedIncomingProducts],
      dealRules: [...keptExistingRules, ...remappedIncomingRules],
    },
    tokenMap: mergedTokenMap,
    docs: combinedDocs,
    payloadLog: combinedPayloadLog,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };

  return deduplicateWorkspace(combined);
}

function collectTokensFromString(text: string, out: Set<string>): void {
  if (!text) return;
  if (TOKEN_PARSE_RE.test(text)) {
    out.add(text);
  }
  TOKEN_SCAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_SCAN_RE.exec(text)) !== null) {
    out.add(m[0]);
    if (m[3]) {
      // Also preserve base token if a suffixed form like [PARTNER_1#2] is referenced
      out.add(`[${m[1]}_${m[2]}]`);
    }
  }
}

function pruneTokenMap(
  tokenMap: TokenMap,
  graph: Workspace['graph'],
  docs: Workspace['docs']
): TokenMap {
  const referenced = new Set<string>();

  for (const v of graph.ventures) {
    collectTokensFromString(v.venture_token, referenced);
    collectTokensFromString(v.min_margin_pct_token, referenced);
  }
  for (const p of graph.partners) {
    collectTokensFromString(p.partner_token, referenced);
    collectTokensFromString(p.approval_rules, referenced);
  }
  for (const prod of graph.products) {
    collectTokensFromString(prod.sku_token, referenced);
    collectTokensFromString(prod.cogs_token, referenced);
    collectTokensFromString(prod.list_price_token, referenced);
  }
  for (const r of graph.dealRules) {
    collectTokensFromString(r.max_discount_pct_token, referenced);
    collectTokensFromString(r.verbatim_blinded_excerpt, referenced);
  }
  for (const d of docs) {
    collectTokensFromString(d.blindedText, referenced);
  }

  const pruned: TokenMap = {};
  for (const [k, v] of Object.entries(tokenMap)) {
    if (referenced.has(k)) {
      pruned[k] = v;
    }
  }
  return pruned;
}

/**
 * Removes a venture, its partners, products, dealRules, and any docs/payloadLog
 * belonging exclusively to that venture. Prunes unreferenced tokens.
 * Returns workspace: null if no ventures and no docs remain.
 */
export function removeVentureFromWorkspace(
  ws: Workspace,
  ventureId: string
): {
  workspace: Workspace | null;
  removedDocs: string[];
  removedRuleCount: number;
  removedProductCount: number;
} {
  const byVenture = docNamesByVenture(ws);
  const targetDocs = byVenture.get(ventureId) ?? new Set<string>();

  const otherVentureDocsLower = new Set<string>();
  for (const [vid, docSet] of byVenture.entries()) {
    if (vid === ventureId) continue;
    for (const d of docSet) {
      otherVentureDocsLower.add(d.toLowerCase());
    }
  }

  const removedDocs: string[] = [];
  const removedDocsLower = new Set<string>();
  for (const d of targetDocs) {
    const lower = d.toLowerCase();
    if (!otherVentureDocsLower.has(lower) && !removedDocsLower.has(lower)) {
      removedDocsLower.add(lower);
      removedDocs.push(d);
    }
  }

  const ventures = ws.graph.ventures
    .filter((v) => v.venture_id !== ventureId)
    .map((v) => ({ ...v }));
  const partners = ws.graph.partners
    .filter((p) => p.venture_id !== ventureId)
    .map((p) => ({ ...p }));
  const products = ws.graph.products
    .filter((p) => p.venture_id !== ventureId)
    .map((p) => ({ ...p }));
  const dealRules = ws.graph.dealRules
    .filter((r) => r.venture_id !== ventureId)
    .map((r) => ({ ...r }));

  const removedProductCount = ws.graph.products.length - products.length;
  const removedRuleCount = ws.graph.dealRules.length - dealRules.length;

  const docs = ws.docs
    .filter((d) => !removedDocsLower.has(d.docName.toLowerCase()))
    .map((d) => ({ ...d }));
  const payloadLog = ws.payloadLog
    .filter((p) => !removedDocsLower.has(p.docName.toLowerCase()))
    .map((p) => ({ ...p }));

  if (ventures.length === 0 && docs.length === 0) {
    return { workspace: null, removedDocs, removedRuleCount, removedProductCount };
  }

  const graph = { ventures, partners, products, dealRules };
  const tokenMap = pruneTokenMap(ws.tokenMap, graph, docs);

  const workspace: Workspace = {
    ...ws,
    name: deriveWorkspaceName(docs, ws.name),
    graph,
    tokenMap,
    docs,
    payloadLog,
    updatedAt: Math.max(ws.updatedAt, Date.now()),
  };

  return { workspace, removedDocs, removedRuleCount, removedProductCount };
}

/**
 * Removes a document's chunks, payloadLog entries, and dealRules, cleans up
 * orphaned products and now-empty ventures, and prunes unused tokens.
 * Returns workspace: null if no ventures and no docs remain.
 */
export function removeDocumentFromWorkspace(
  ws: Workspace,
  docName: string
): {
  workspace: Workspace | null;
  removedRuleCount: number;
  removedVentureIds: string[];
} {
  const targetLower = docName.toLowerCase();
  const beforeByVenture = docNamesByVenture(ws);

  const removedChunks: Workspace['docs'] = [];
  const remainingDocs: Workspace['docs'] = [];
  for (const d of ws.docs) {
    if (d.docName.toLowerCase() === targetLower) {
      removedChunks.push(d);
    } else {
      remainingDocs.push({ ...d });
    }
  }

  const remainingPayloadLog = ws.payloadLog
    .filter((p) => p.docName.toLowerCase() !== targetLower)
    .map((p) => ({ ...p }));

  let remainingDealRules = ws.graph.dealRules
    .filter((r) => r.source_doc_name.toLowerCase() !== targetLower)
    .map((r) => ({ ...r }));
  let removedRuleCount = ws.graph.dealRules.length - remainingDealRules.length;

  // Check for products whose sku_token appeared ONLY in the removed doc
  const tokensInRemovedDoc = new Set<string>();
  for (const c of removedChunks) {
    collectTokensFromString(c.blindedText, tokensInRemovedDoc);
  }
  const tokensInRemainingDocs = new Set<string>();
  for (const c of remainingDocs) {
    collectTokensFromString(c.blindedText, tokensInRemainingDocs);
  }

  let remainingProducts = ws.graph.products
    .filter((prod) => {
      if (
        prod.sku_token &&
        tokensInRemovedDoc.has(prod.sku_token) &&
        !tokensInRemainingDocs.has(prod.sku_token)
      ) {
        return false;
      }
      return true;
    })
    .map((p) => ({ ...p }));

  // Check if any venture had documents before and now has NO remaining associated documents
  const intermediateWs: Workspace = {
    ...ws,
    graph: {
      ventures: ws.graph.ventures,
      partners: ws.graph.partners,
      products: remainingProducts,
      dealRules: remainingDealRules,
    },
    docs: remainingDocs,
    payloadLog: remainingPayloadLog,
  };
  const afterByVenture = docNamesByVenture(intermediateWs);

  const removedVentureIds: string[] = [];
  const removedVentureSet = new Set<string>();
  for (const v of ws.graph.ventures) {
    const hadBefore = (beforeByVenture.get(v.venture_id)?.size ?? 0) > 0;
    const hasAfter = (afterByVenture.get(v.venture_id)?.size ?? 0) > 0;
    if (hadBefore && !hasAfter) {
      removedVentureIds.push(v.venture_id);
      removedVentureSet.add(v.venture_id);
    }
  }

  const remainingVentures = ws.graph.ventures
    .filter((v) => !removedVentureSet.has(v.venture_id))
    .map((v) => ({ ...v }));
  const remainingPartners = ws.graph.partners
    .filter((p) => !removedVentureSet.has(p.venture_id))
    .map((p) => ({ ...p }));
  remainingProducts = remainingProducts.filter((p) => !removedVentureSet.has(p.venture_id));
  const rulesBeforeVenturePrune = remainingDealRules.length;
  remainingDealRules = remainingDealRules.filter((r) => !removedVentureSet.has(r.venture_id));
  removedRuleCount += rulesBeforeVenturePrune - remainingDealRules.length;

  if (remainingVentures.length === 0 && remainingDocs.length === 0) {
    return { workspace: null, removedRuleCount, removedVentureIds };
  }

  const graph = {
    ventures: remainingVentures,
    partners: remainingPartners,
    products: remainingProducts,
    dealRules: remainingDealRules,
  };
  const tokenMap = pruneTokenMap(ws.tokenMap, graph, remainingDocs);

  const workspace: Workspace = {
    ...ws,
    name: deriveWorkspaceName(remainingDocs, ws.name),
    graph,
    tokenMap,
    docs: remainingDocs,
    payloadLog: remainingPayloadLog,
    updatedAt: Math.max(ws.updatedAt, Date.now()),
  };

  return { workspace, removedRuleCount, removedVentureIds };
}
