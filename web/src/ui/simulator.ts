// WS-4 Deal Simulator: graph-driven pickers (re-hydrated locally via tokenMap),
// FR-4 deterministic verdict card with citation + re-hydrated rule excerpt,
// natural-language query parsing (on-device model or local regex fallback),
// and FR-5 WhatsApp drafts with copy buttons.
import { evaluateDeal } from '../calc/marginEngine';
import { buildDrafts } from '../drafts/whatsapp';
import type { Badge, DealInput, DealRuleNode, DraftContext, Drafts, KnowledgeGraph, TokenMap, Verdict, Workspace } from '../types';
import { fuzzyMatch, parseQuery, skuLabels, ventureLabels } from './query';
import { goTab, store } from './state';
import { copyText, el, errText, hydrate, money, parseNum, pct, rehydrateText, toast } from './util';

interface RunResult {
  input: DealInput;
  verdict: Verdict;
  ctx: DraftContext;
  drafts: Drafts | null;
  draftsError: string | null;
  rule: DealRuleNode | null;
  skuName: string;
  ventureName: string;
}

interface SimState {
  ventureId: string;
  skuId: string;
  disc: number;
  qty: number;
  buyer: string;
  nlText: string;
  queryNote: string | null;
  errors: string[];
  result: RunResult | null;
}

const st: SimState = {
  ventureId: '',
  skuId: '',
  disc: 20,
  qty: 30,
  buyer: 'there',
  nlText: '20% off 30 units on the linen dress',
  queryNote: null,
  errors: [],
  result: null,
};

const BADGE_CLASS: Record<Badge, string> = {
  APPROVED: 'badge--approved',
  'PARTNER SIGN-OFF NEEDED': 'badge--signoff',
  'MARGIN BREACH': 'badge--breach',
};

export function mountSimulator(root: HTMLElement): void {
  const render = (): void => renderSim(root);
  store.subscribe(() => {
    // A new workspace invalidates the previous verdict (its tokens may differ).
    st.result = null;
    st.errors = [];
    render();
  });
  render();
}

/* ---------- helpers over the graph ---------- */

function qtyOf(rule: DealRuleNode): number {
  const m = /(\d+(?:\.\d+)?)/.exec(rule.min_qty_condition ?? '');
  return m ? Number.parseFloat(m[1]) : 0;
}

function bestRule(graph: KnowledgeGraph, ventureId: string, qty: number): DealRuleNode | null {
  const rules = graph.dealRules.filter((r) => r.venture_id === ventureId);
  if (rules.length === 0) return null;
  const satisfied = rules.filter((r) => qty >= qtyOf(r)).sort((a, b) => qtyOf(b) - qtyOf(a));
  if (satisfied.length > 0) return satisfied[0] ?? null;
  return [...rules].sort((a, b) => qtyOf(a) - qtyOf(b))[0] ?? null;
}

function citationOf(rule: DealRuleNode | null): string {
  if (!rule) return 'no contractual rule found for this venture';
  const page = rule.page_or_section?.trim() ? ` ${rule.page_or_section.trim()}` : '';
  return `${rule.source_doc_name}${page}`;
}

/* ---------- main render ---------- */

function renderSim(root: HTMLElement): void {
  const ws = store.workspace;
  if (!ws) {
    root.replaceChildren(emptyBox('No workspace yet', 'Ingest documents (or load the sample workspace) — the simulator reads ventures, SKUs and rules from the synced graph.'));
    return;
  }
  if (ws.graph.ventures.length === 0) {
    root.replaceChildren(
      emptyBox(
        'Workspace has no graph yet',
        'The cloud graph synthesis stage has not produced ventures/products/rules. Open Privacy Inspector to diagnose, fix the pipeline, and re-run Ingest.',
      ),
    );
    return;
  }

  // Keep selections valid against the current graph.
  if (!ws.graph.ventures.some((v) => v.venture_id === st.ventureId)) st.ventureId = ws.graph.ventures[0].venture_id;
  const ventureProducts = ws.graph.products.filter((p) => p.venture_id === st.ventureId);
  if (!ventureProducts.some((p) => p.sku_id === st.skuId)) st.skuId = ventureProducts[0]?.sku_id ?? '';

  const venture = ws.graph.ventures.find((v) => v.venture_id === st.ventureId) ?? ws.graph.ventures[0];
  const ventureName = hydrate(ws.tokenMap, venture.venture_token) || venture.venture_id;
  const product = ws.graph.products.find((p) => p.sku_id === st.skuId) ?? null;
  const skuName = product ? hydrate(ws.tokenMap, product.sku_token) || product.sku_id : '(no SKU)';
  const rule = bestRule(ws.graph, st.ventureId, st.qty);
  const floor = parseNum(hydrate(ws.tokenMap, venture.min_margin_pct_token));
  const cap = rule ? parseNum(hydrate(ws.tokenMap, rule.max_discount_pct_token)) : null;
  const price = product ? parseNum(hydrate(ws.tokenMap, product.list_price_token)) : null;
  const cogs = product ? parseNum(hydrate(ws.tokenMap, product.cogs_token)) : null;

  const nodes: Node[] = [];

  /* header + pickers */
  const ventureSel = el('select', { id: 'simVenture', 'aria-label': 'Venture' }, ...ws.graph.ventures.map((v) => {
    const label = hydrate(ws.tokenMap, v.venture_token) || v.venture_id;
    return el('option', { value: v.venture_id, ...(v.venture_id === st.ventureId ? { selected: '' } : {}) }, label);
  }));
  ventureSel.addEventListener('change', () => {
    st.ventureId = ventureSel.value;
    st.skuId = '';
    st.result = null;
    renderSim(root);
  });

  const skuSel = el('select', { id: 'simSku', 'aria-label': 'SKU / product', ...(ventureProducts.length === 0 ? { disabled: '' } : {}) }, ...ventureProducts.map((p) => {
    const name = hydrate(ws.tokenMap, p.sku_token) || p.sku_id;
    const lp = parseNum(hydrate(ws.tokenMap, p.list_price_token));
    const cg = parseNum(hydrate(ws.tokenMap, p.cogs_token));
    const label = lp !== null && cg !== null ? `${name} — list ${money(lp)}, COGS ${money(cg)}` : name;
    return el('option', { value: p.sku_id, ...(p.sku_id === st.skuId ? { selected: '' } : {}) }, label);
  }));
  skuSel.addEventListener('change', () => {
    st.skuId = skuSel.value;
    st.result = null;
    renderSim(root);
  });

  nodes.push(
    el(
      'div',
      { class: 'card' },
      el('h2', {}, `Deal Simulator — ${ws.name}`),
      el('p', {}, 'Ventures, SKUs and rules come from the encrypted graph and are re-hydrated locally from the Secret Key Map before anything is displayed or computed.'),
      el(
        'div',
        { class: 'field-row' },
        el('div', { class: 'field' }, el('label', { for: 'simVenture' }, 'Venture'), ventureSel),
        el('div', { class: 'field' }, el('label', { for: 'simSku' }, 'SKU'), skuSel),
      ),
    ),
  );

  /* rule strip: derived from the matched DealRuleNode + venture */
  nodes.push(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `Rules in force for “${ventureName}”`),
      el(
        'div',
        { class: 'rule-strip' },
        tile('Margin floor', floor !== null ? pct(floor) : '— not found'),
        tile('Discount cap (D_cap)', cap !== null ? pct(cap) : 'none — solo venture'),
        tile('Partner approval', rule ? (rule.requires_partner_approval ? 'REQUIRED above cap' : 'not required') : 'no rule'),
        tile('Min qty condition', rule?.min_qty_condition?.trim() ? rule.min_qty_condition.trim() : '—'),
        tile('List price', price !== null ? money(price) : '— missing'),
        tile('Unit COGS', cogs !== null ? money(cogs) : '— missing'),
      ),
      rule
        ? el('p', { class: 'hint', style: 'margin-top:10px' }, `Best-matching rule: ${rule.rule_id} · source ${citationOf(rule)}`)
        : el('p', { class: 'hint', style: 'margin-top:10px' }, 'No DealRuleNode for this venture — treated as a solo venture with no cap.'),
    ),
  );

  /* natural-language query */
  const nlInput = el('input', { type: 'text', id: 'simQuery', value: st.nlText, 'aria-label': 'Natural-language deal query' });
  const parseBtn = el('button', { class: 'btn', id: 'simParse' }, 'Parse query');
  parseBtn.addEventListener('click', () => {
    st.nlText = nlInput.value;
    void handleParse(root, ws);
  });
  nlInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      st.nlText = nlInput.value;
      void handleParse(root, ws);
    }
  });
  nodes.push(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Ask in plain words'),
      el('p', {}, 'Try “20% off 30 units on the linen dress”. Parsed on-device via generate(\'query\') when the model is available; always falls back to a local regex + fuzzy-name parser.'),
      el('div', { class: 'field-row' }, el('div', { class: 'field', style: 'flex:3 1 260px' }, el('label', { for: 'simQuery' }, 'Buyer message'), nlInput), el('div', { class: 'field', style: 'flex:0 1 140px; justify-content:flex-end' }, parseBtn)),
      ...(st.queryNote ? [el('div', { class: 'query-chip' }, `Query parsed via ${st.queryNote}`)] : []),
    ),
  );

  /* manual inputs + run */
  const discInput = el('input', { type: 'number', id: 'simDisc', min: '0', max: '99.99', step: '0.5', value: String(st.disc) });
  const qtyInput = el('input', { type: 'number', id: 'simQty', min: '1', step: '1', value: String(st.qty) });
  const buyerInput = el('input', { type: 'text', id: 'simBuyer', value: st.buyer, 'aria-label': 'Buyer name used in the draft' });
  discInput.addEventListener('input', () => {
    st.disc = Number.parseFloat(discInput.value);
  });
  qtyInput.addEventListener('input', () => {
    st.qty = Number.parseFloat(qtyInput.value);
  });
  buyerInput.addEventListener('input', () => {
    st.buyer = buyerInput.value;
  });
  const runBtn = el('button', { class: 'btn btn-primary btn-run', id: 'simRun' }, 'RUN MARGIN CHECK');
  runBtn.addEventListener('click', () => runCheck(root, ws));
  nodes.push(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Requested deal'),
      el(
        'div',
        { class: 'field-row' },
        el('div', { class: 'field' }, el('label', { for: 'simDisc' }, 'Requested discount D_req (%)'), discInput),
        el('div', { class: 'field' }, el('label', { for: 'simQty' }, 'Quantity Q (units)'), qtyInput),
        el('div', { class: 'field' }, el('label', { for: 'simBuyer' }, 'Buyer name (for drafts)'), buyerInput),
      ),
      runBtn,
    ),
  );

  /* errors */
  if (st.errors.length > 0) {
    nodes.push(
      el(
        'div',
        { class: 'note note--err' },
        el('strong', {}, 'Cannot run this check:'),
        el('ul', {}, ...st.errors.map((e) => el('li', {}, e))),
      ),
    );
  }

  /* verdict */
  if (st.result) nodes.push(verdictCard(st.result, ws));

  root.replaceChildren(...nodes);
}

function tile(k: string, v: string): HTMLElement {
  return el('div', { class: 'rule-tile' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

function emptyBox(title: string, body: string): HTMLElement {
  const box = el('div', { class: 'empty' }, el('h2', {}, title), el('p', {}, body), el('button', { class: 'btn btn-primary' }, 'Go to Ingest'));
  box.querySelector('button')?.addEventListener('click', () => goTab('ingest'));
  return box;
}

/* ---------- query parsing ---------- */

async function handleParse(root: HTMLElement, ws: Workspace): Promise<void> {
  const text = st.nlText.trim();
  if (!text) {
    st.errors = ['Type a buyer message first.'];
    renderSim(root);
    return;
  }
  try {
    const parsed = await parseQuery(text, ws.graph, ws.tokenMap);
    st.queryNote = parsed.source === 'model' ? `model — ${parsed.note}` : `regex fallback — ${parsed.note}`;
    if (parsed.discountPct !== null) st.disc = parsed.discountPct;
    if (parsed.qty !== null) st.qty = parsed.qty;

    const vLabels = ventureLabels(ws.graph, ws.tokenMap);
    const sLabels = skuLabels(ws.graph, ws.tokenMap);
    const vHit = fuzzyMatch(parsed.ventureHint ?? text, vLabels);
    if (vHit) {
      const node = ws.graph.ventures.find((v) => (hydrate(ws.tokenMap, v.venture_token) || v.venture_id) === vHit);
      if (node && node.venture_id !== st.ventureId) {
        st.ventureId = node.venture_id;
        st.skuId = '';
      }
    }
    const sHit = fuzzyMatch(parsed.skuHint ?? text, sLabels);
    if (sHit) {
      const node = ws.graph.products.find((p) => (hydrate(ws.tokenMap, p.sku_token) || p.sku_id) === sHit);
      if (node) st.skuId = node.sku_id;
    }
    renderSim(root);
    runCheck(root, ws);
  } catch (e) {
    st.errors = [`Query parsing failed completely: ${errText(e)}`];
    renderSim(root);
  }
}

/* ---------- the deterministic run ---------- */

function runCheck(root: HTMLElement, ws: Workspace): void {
  const errors: string[] = [];
  const venture = ws.graph.ventures.find((v) => v.venture_id === st.ventureId) ?? ws.graph.ventures[0];
  const ventureName = hydrate(ws.tokenMap, venture.venture_token) || venture.venture_id;
  const product = ws.graph.products.find((p) => p.sku_id === st.skuId && p.venture_id === venture.venture_id) ?? ws.graph.products.find((p) => p.venture_id === venture.venture_id) ?? null;
  if (!product) errors.push('Select an SKU — this venture has no products in the graph.');

  const skuName = product ? hydrate(ws.tokenMap, product.sku_token) || product.sku_id : '';
  const price = product ? parseNum(hydrate(ws.tokenMap, product.list_price_token)) : null;
  const cogs = product ? parseNum(hydrate(ws.tokenMap, product.cogs_token)) : null;
  const floor = parseNum(hydrate(ws.tokenMap, venture.min_margin_pct_token));
  const rule = bestRule(ws.graph, venture.venture_id, Number.isFinite(st.qty) ? st.qty : 0);
  const cap = rule ? parseNum(hydrate(ws.tokenMap, rule.max_discount_pct_token)) : null;

  if (price === null && product) errors.push(`List price missing — token “${product.list_price_token}” has no local value.`);
  if (cogs === null && product) errors.push(`COGS missing — token “${product.cogs_token}” has no local value.`);
  if (floor === null) errors.push(`Margin floor missing — token “${venture.min_margin_pct_token}” has no local value.`);
  if (!Number.isFinite(st.disc) || st.disc < 0 || st.disc >= 100) errors.push('D_req must be between 0 and 100 (%).');
  if (!Number.isFinite(st.qty) || st.qty < 1) errors.push('Quantity must be at least 1 unit.');

  if (errors.length > 0) {
    st.errors = errors;
    st.result = null;
    renderSim(root);
    return;
  }
  st.errors = [];

  const input: DealInput = {
    listPrice: price ?? 0,
    cogs: cogs ?? 0,
    marginFloorPct: floor ?? 0,
    discountCapPct: cap,
    requiresPartnerApproval: rule ? rule.requires_partner_approval : false,
    requestedDiscountPct: st.disc,
    qty: st.qty,
  };

  const partner = ws.graph.partners.find((p) => p.venture_id === venture.venture_id) ?? null;
  const ctx: DraftContext = {
    buyerName: st.buyer.trim() || 'there',
    skuName,
    ventureName,
    partnerName: partner ? hydrate(ws.tokenMap, partner.partner_token) || null : null,
    citation: citationOf(rule),
  };

  try {
    const verdict = evaluateDeal(input);
    let drafts: Drafts | null = null;
    let draftsError: string | null = null;
    try {
      drafts = buildDrafts(input, verdict, ctx);
    } catch (e) {
      draftsError = errText(e);
    }
    st.result = { input, verdict, ctx, drafts, draftsError, rule, skuName, ventureName };
  } catch (e) {
    st.result = null;
    st.errors = [`Deterministic engine returned an error: ${errText(e)}`];
  }
  renderSim(root);
}

/* ---------- verdict card ---------- */

function verdictCard(res: RunResult, ws: Workspace): HTMLElement {
  const { verdict: v, input, ctx } = res;
  const rows: Array<[string, string, 'ok' | 'bad' | 'warn' | '']> = [];
  rows.push(['P_req — requested net unit price', money(v.requestedNetUnitPrice), '']);
  rows.push(['P (list price)', money(input.listPrice), '']);
  rows.push(['C (unit COGS)', money(input.cogs), '']);
  const marginCls = v.requestedMarginPct < input.marginFloorPct ? 'bad' : 'ok';
  rows.push([`M_req — resulting margin vs floor ${pct(input.marginFloorPct)}`, `${pct(v.requestedMarginPct)} ${v.requestedMarginPct < input.marginFloorPct ? 'BELOW FLOOR' : 'OK'}`, marginCls]);
  rows.push(['Π_total — total deal profit', money(v.totalProfit), v.totalProfit < 0 ? 'bad' : '']);
  rows.push(['D_safe — maximum margin-safe discount', pct(v.maxSafeDiscountPct), '']);
  rows.push([
    'D_counter — recommended counter-offer',
    `${pct(v.counterDiscountPct)}${v.counterRequiresApproval ? ' · needs partner sign-off' : ''}`,
    v.counterRequiresApproval ? 'warn' : '',
  ]);
  if (v.partnerPendingDiscountPct !== null && v.partnerPendingDiscountPct !== undefined) {
    rows.push(['Partner-pending option (D_req held for approval)', pct(v.partnerPendingDiscountPct), 'warn']);
  }

  const card = el(
    'div',
    { class: 'verdict' },
    el(
      'div',
      { class: 'verdict-head' },
      el('div', {}, el('div', { class: 'badge ' + BADGE_CLASS[v.badge], role: 'status' }, v.badge), el('div', { class: 'verdict-sub' }, `${res.skuName} @ ${res.ventureName} — ${pct(input.requestedDiscountPct)} off × ${input.qty} units`)),
    ),
    ...rows.map(([k, val, cls]) => el('div', { class: 'vrow' }, el('div', { class: 'k' }, k), el('div', { class: `v ${cls}` }, val))),
  );

  if (v.notes && v.notes.length > 0) {
    card.append(el('ul', { class: 'hint', style: 'margin:10px 0 0; padding-left:20px' }, ...v.notes.map((n) => el('li', {}, n))));
  }

  if (res.rule) {
    const excerpt = rehydrateText(res.rule.verbatim_blinded_excerpt ?? '', ws.tokenMap);
    card.append(
      el(
        'div',
        { class: 'cite' },
        el('div', {}, 'Citation: ', el('span', { class: 'cite-src' }, citationOf(res.rule)), ...(res.rule.min_qty_condition ? [` — applies when ${res.rule.min_qty_condition.trim()}`] : [])),
        ...(excerpt ? [el('div', { class: 'cite-excerpt' }, `“${excerpt}”`)] : []),
        el('div', { class: 'cite-note' }, 'Excerpt stored blinded in the graph, re-hydrated locally from the Secret Key Map'),
      ),
    );
  }

  /* FR-5 drafts */
  if (res.draftsError) {
    card.append(el('div', { class: 'note note--warn', style: 'margin-top:12px' }, `WhatsApp drafts unavailable: ${res.draftsError}`));
  }
  if (res.drafts) {
    card.append(draftBlock('Buyer counter-offer reply', res.drafts.buyerReply, 'Buyer reply'));
    if (res.drafts.partnerMessage) {
      card.append(draftBlock(`Partner sign-off — ${ctx.partnerName ?? 'business partner'}`, res.drafts.partnerMessage, 'Partner message'));
    }
  }
  return card;
}

function draftBlock(title: string, text: string, copyLabel: string): HTMLElement {
  const copyBtn = el('button', { class: 'btn btn-sm btn-primary' }, 'Copy for WhatsApp');
  copyBtn.addEventListener('click', () => {
    void copyText(text, copyLabel);
  });
  return el(
    'div',
    { class: 'draft' },
    el('div', { class: 'draft-head' }, el('h3', {}, title), copyBtn),
    el('pre', {}, text),
  );
}
