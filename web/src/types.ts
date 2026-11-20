// FROZEN CONTRACT — do not edit. Workers: code against this exactly.
// Percentages are numbers: 20 === 20%. Tokens: /^[A-Z][A-Z_]*_\d+$/

export type EntityType =
  | 'PARTNER' | 'VENTURE' | 'SKU'
  | 'COST' | 'PRICE' | 'DISCOUNT_CAP' | 'MARGIN_FLOOR';

export interface DocChunk {
  docName: string;
  page: number;
  index: number;      // chunk index within doc
  text: string;
}

export interface DetectedSpan {
  text: string;       // original span (local only)
  token: string;      // e.g. "[COST_1]"
  type: EntityType;
}

export interface AnonymizedChunk {
  docName: string;
  page: number;
  index: number;
  text: string;       // blinded text safe for cloud
  detected: DetectedSpan[];
}

export interface AnonymizeResult {
  blinded: AnonymizedChunk[];
  tokenMap: TokenMap;
}

export type TokenMap = Record<string, string>; // "[COST_1]" -> "40"

export interface PayloadLogEntry {
  docName: string;
  page: number;
  localText: string;   // what stays on device
  cloudText: string;   // EXACT string sent to Firebase AI Logic cloud
  sentAt: number;      // when the entry was recorded, BEFORE the request (CV-SEC-2)
  receivedAt?: number; // when the response arrived; absent when none did
  status?: 'attempted' | 'responded'; // recorded pre-send; flipped after the call resolves
}

// FR-2 collections
export interface VentureNode {
  venture_id: string;
  venture_token: string;
  min_margin_pct_token: string;
}
export interface PartnerNode {
  partner_id: string;
  partner_token: string;
  venture_id: string;
  approval_rules: string;
}
export interface ProductNode {
  sku_id: string;
  sku_token: string;
  venture_id: string;
  cogs_token: string;
  list_price_token: string;
}
export interface DealRuleNode {
  rule_id: string;
  venture_id: string;
  max_discount_pct_token: string;
  min_qty_condition: string;
  requires_partner_approval: boolean;
  source_doc_name: string;
  page_or_section: string;
  verbatim_blinded_excerpt: string;
}
export interface KnowledgeGraph {
  ventures: VentureNode[];
  partners: PartnerNode[];
  products: ProductNode[];
  dealRules: DealRuleNode[];
}

export interface Workspace {
  id: string;
  name: string;
  graph: KnowledgeGraph;
  tokenMap: TokenMap;
  docs: { docName: string; page: number; index: number; blindedText: string }[];
  payloadLog: PayloadLogEntry[];
  updatedAt: number;
}

// FR-4 deterministic engine
export type Badge = 'APPROVED' | 'PARTNER SIGN-OFF NEEDED' | 'MARGIN BREACH';

export interface DealInput {
  listPrice: number;
  cogs: number;
  marginFloorPct: number;        // M_min, e.g. 55
  discountCapPct: number | null; // D_cap; null = solo venture, no cap
  requiresPartnerApproval: boolean;
  requestedDiscountPct: number;  // D_req, e.g. 20
  qty: number;
}

export interface Verdict {
  badge: Badge;
  requestedNetUnitPrice: number;
  requestedMarginPct: number;
  totalProfit: number;
  maxSafeDiscountPct: number;
  counterDiscountPct: number;
  counterRequiresApproval: boolean;
  partnerPendingDiscountPct: number | null;
  notes: string[];
}

export interface DraftContext {
  buyerName: string;
  skuName: string;          // re-hydrated locally
  ventureName: string;      // re-hydrated locally
  partnerName: string | null;
  citation: string;         // "Agreement.pdf p.3 §4.3"
}

export interface Drafts {
  buyerReply: string;
  partnerMessage: string | null;
}
