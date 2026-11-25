// Requests page — the buyer request RECORD page (Stripe detail composition:
// breadcrumb + titled header, main column of unboxed sections, 324px right
// rail). Records live in localStorage (via requestModel/state helpers); the
// pricing table, policy checks, drafts and approval copy all recompute live
// from the deterministic margin engine as fields change.
import type { Badge, Workspace } from '../types';
import { fuzzyMatch, parseQuery } from './query';
import {
  approvalInfo,
  citationOf,
  computeRecordDeal,
  fmtPct,
  fmtPct1,
  loadRequests,
  newRecord,
  nextRequestId,
  policyChecks,
  pricingRows,
  pushActivity,
  saveRequests,
  skuNameOf,
  statusLabel,
  ventureNameOf,
  type PriceRow,
  type RecordDeal,
  type RequestRecord,
} from './requestModel';
import { goRule, goTab, store } from './state';
import { copyText, el, money, toast } from './util';

type View = { kind: 'list' } | { kind: 'record'; id: string };

const BADGE_CLASS: Record<Badge, string> = {
  APPROVED: 'badge--approved',
  'PARTNER SIGN-OFF NEEDED': 'badge--signoff',
  'MARGIN BREACH': 'badge--breach',
};

let records: RequestRecord[] = [];
const st: { ventureId: string; view: View } = { ventureId: '', view: { kind: 'list' } };
let mountedRoot: HTMLElement | null = null;
let switcherSync: (() => void) | null = null;

/** Top-bar venture switcher hook: pick the venture the Requests page runs against. */
export function selectVenture(ventureId: string): void {
  st.ventureId = ventureId;
  // The switcher is the venture context: leaving its venture closes the record.
  const view = st.view;
  if (view.kind === 'record') {
    const rec = records.find((r) => r.id === view.id);
    if (rec && rec.ventureId !== ventureId) st.view = { kind: 'list' };
  }
  if (mountedRoot) render();
}

/** Currently selected venture id (empty string until a graph is loaded). */
export function currentVentureId(): string {
  return st.ventureId;
}

/** main.ts registers the top-bar select refresh so both sides stay in sync. */
export function registerVentureSwitcherSync(fn: () => void): void {
  switcherSync = fn;
}

export function mountRequests(root: HTMLElement): void {
  mountedRoot = root;
  records = loadRequests();
  store.subscribe(() => render());
  render();
}

/* ---------- helpers ---------- */

function persist(): void {
  saveRequests(records);
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function backToList(): void {
  st.view = { kind: 'list' };
  render();
}

function openRecord(id: string): void {
  st.view = { kind: 'record', id };
  const rec = records.find((r) => r.id === id);
  if (rec && rec.ventureId && rec.ventureId !== st.ventureId) {
    st.ventureId = rec.ventureId; // the top-bar switcher follows the record
    if (switcherSync) switcherSync();
  }
  render();
}

function newRequest(): void {
  const rec = newRecord(st.ventureId);
  rec.id = nextRequestId(records);
  records.push(rec);
  persist();
  openRecord(rec.id);
}

function duplicateRecord(rec: RequestRecord): void {
  const copy: RequestRecord = {
    ...rec,
    id: nextRequestId(records),
    createdAt: Date.now(),
    activity: [{ at: Date.now(), kind: 'created', note: `Created from ${rec.id}` }],
  };
  records.push(copy);
  persist();
  openRecord(copy.id);
  toast(`Duplicated as ${copy.id}`, 'ok');
}

function badgeSpan(deal: RecordDeal | null): HTMLElement {
  const v = deal ? deal.verdict : null;
  if (!v) return el('span', { class: 'badge', role: 'status' }, 'Not checked yet');
  return el('span', { class: `badge ${BADGE_CLASS[v.badge]}`, role: 'status' }, statusLabel(v.badge));
}

/** Small inline SVG status icons (the comp's check / cross / dash circles). */
function iconSvg(kind: 'pass' | 'fail' | 'na' | 'lock'): Element {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', kind === 'lock' ? 'check-icon icon-muted' : `check-icon check-icon--${kind}`);

  const stroke = (name: string, attrs: Record<string, string>): void => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.4');
    svg.append(node);
  };

  if (kind === 'lock') {
    stroke('rect', { x: '3.25', y: '7', width: '9.5', height: '6.75', rx: '1.5' });
    stroke('path', { d: 'M5.5 7V5.25C5.5 3.87 6.62 2.75 8 2.75C9.38 2.75 10.5 3.87 10.5 5.25V7', 'stroke-linecap': 'round' });
    return svg;
  }
  stroke('circle', { cx: '8', cy: '8', r: '6.5' });
  if (kind === 'pass') stroke('path', { d: 'M5.25 8.2L7.1 10.05L10.9 6.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  if (kind === 'fail') stroke('path', { d: 'M5.75 5.75L10.25 10.25M10.25 5.75L5.75 10.25', 'stroke-linecap': 'round' });
  if (kind === 'na') stroke('path', { d: 'M5.5 8H10.5', 'stroke-linecap': 'round' });
  return svg;
}

/* ---------- main render dispatch ---------- */

function render(): void {
  const root = mountedRoot;
  if (!root) return;
  const ws = store.workspace;
  if (ws && ws.graph.ventures.length > 0 && !ws.graph.ventures.some((v) => v.venture_id === st.ventureId)) {
    st.ventureId = ws.graph.ventures[0].venture_id;
    if (switcherSync) switcherSync();
  }
  const view = st.view;
  if (view.kind === 'record') {
    const rec = records.find((r) => r.id === view.id);
    if (rec) {
      renderRecord(root, rec);
      return;
    }
    st.view = { kind: 'list' };
  }
  renderList(root);
}

/* ---------- list view ---------- */

function renderList(root: HTMLElement): void {
  const ws = store.workspace;
  const newBtn = el('button', { class: 'btn btn-primary' }, 'New request');
  newBtn.addEventListener('click', newRequest);
  const emptyBtn = el('button', { class: 'btn btn-primary' }, 'New request');
  emptyBtn.addEventListener('click', newRequest);

  const header = el(
    'header',
    { class: 'page-header' },
    el(
      'div',
      { class: 'header-row' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title' }, 'Requests'),
        el('p', { class: 'page-sub' }, 'Buyer price requests, checked against your rules as you type.'),
      ),
      el('div', { class: 'actions-group' }, newBtn),
    ),
  );

  if (records.length === 0) {
    const box = el(
      'div',
      { class: 'empty' },
      el('h2', { class: 'empty-title' }, 'No requests yet'),
      el('p', { class: 'empty-sub' }, 'Create a request to check a buyer discount against your rules.'),
      el('div', { class: 'cta-row' }, emptyBtn),
    );
    if (!ws || ws.graph.ventures.length === 0) {
      const sample = el('button', { class: 'btn btn-secondary' }, 'Load sample workspace');
      sample.addEventListener('click', () => goTab('documents'));
      box.querySelector('.cta-row')?.append(sample);
    }
    root.replaceChildren(header, box);
    return;
  }

  const rows = records.map((rec) => {
    const deal = ws ? computeRecordDeal(ws, rec) : null;
    const open = (): void => openRecord(rec.id);
    const tr = el(
      'tr',
      { class: 'is-clickable' },
      el('td', {}, el('button', { class: 'link' }, rec.id)),
      el('td', {}, fmtDateTime(rec.createdAt)),
      el('td', {}, ws ? ventureNameOf(ws, rec.ventureId) || rec.ventureId : rec.ventureId),
      el('td', {}, ws ? skuNameOf(ws, rec.skuId) || '—' : '—'),
      el('td', {}, fmtPct(rec.discountPct)),
      el('td', {}, String(rec.qty)),
      el('td', {}, badgeSpan(deal)),
    );
    tr.addEventListener('click', open);
    return tr;
  });

  const table = el(
    'table',
    { class: 'data-table' },
    el(
      'thead',
      {},
      el('tr', {}, ...['Request', 'Created', 'Venture', 'Product', 'Discount', 'Qty', 'Status'].map((h) => el('th', { scope: 'col' }, h))),
    ),
    el('tbody', {}, ...rows),
  );

  root.replaceChildren(header, el('div', { class: 'section' }, el('div', { class: 'table-scroll' }, table)));
}

/* ---------- record view ---------- */

function emptyDeal(errors: string[]): RecordDeal {
  return {
    errors,
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
}

function renderRecord(root: HTMLElement, rec: RequestRecord): void {
  const ws = store.workspace;
  let deal: RecordDeal = ws ? computeRecordDeal(ws, rec) : emptyDeal(['No workspace loaded — open Documents to load one. This request keeps its values.']);
  const ventureProducts = ws ? ws.graph.products.filter((p) => p.venture_id === rec.ventureId) : [];

  /* header */
  const breadcrumb = el('button', { class: 'breadcrumb', type: 'button' }, '‹ Requests');
  breadcrumb.addEventListener('click', backToList);
  const badgeBox = el('span', {});
  badgeBox.append(badgeSpan(deal));
  const applyBtn = el('button', { class: 'btn btn-primary' }, 'Apply suggested and save');
  applyBtn.addEventListener('click', () => {
    if (!deal.verdict) return;
    rec.discountPct = deal.verdict.counterDiscountPct;
    pushActivity(rec, 'applied', `Applied suggested ${fmtPct(deal.verdict.counterDiscountPct)} and saved`);
    persist();
    toast('Suggested offer applied — request saved', 'ok');
    render();
  });
  const dupBtn = el('button', { class: 'btn btn-secondary' }, 'Duplicate');
  dupBtn.addEventListener('click', () => duplicateRecord(rec));
  const header = el(
    'header',
    { class: 'page-header' },
    breadcrumb,
    el(
      'div',
      { class: 'header-row' },
      el('div', { class: 'title-group' }, el('h1', { class: 'page-title' }, `${rec.id} · Buyer request`), badgeBox),
      el('div', { class: 'actions-group' }, dupBtn, applyBtn),
    ),
  );

  /* Request section — editable fields */
  const customerInput = el('input', { type: 'text', id: 'reqCustomer', value: rec.customer, placeholder: 'Buyer name' });
  customerInput.addEventListener('input', () => {
    rec.customer = customerInput.value;
    persist();
    refresh();
  });

  const productSel = el(
    'select',
    { id: 'reqProduct', ...(ventureProducts.length === 0 ? { disabled: '' } : {}) },
    el('option', { value: '', ...(rec.skuId === '' ? { selected: '' } : {}) }, ventureProducts.length === 0 ? 'No products yet' : 'Pick a product'),
    ...(ws
      ? ventureProducts.map((p) => {
          const label = skuNameOf(ws, p.sku_id) || p.sku_id;
          return el('option', { value: p.sku_id, ...(p.sku_id === rec.skuId ? { selected: '' } : {}) }, label);
        })
      : []),
  );
  productSel.addEventListener('change', () => {
    rec.skuId = productSel.value;
    persist();
    refresh();
  });

  const qtyInput = el('input', { type: 'number', id: 'reqQty', min: '1', step: '1', value: String(rec.qty) });
  const discInput = el('input', { type: 'number', id: 'reqDisc', min: '0', max: '99.99', step: '0.5', value: String(rec.discountPct) });
  qtyInput.addEventListener('input', () => {
    const v = Number.parseFloat(qtyInput.value);
    if (Number.isFinite(v)) rec.qty = v;
    persist();
    refresh();
  });
  discInput.addEventListener('input', () => {
    const v = Number.parseFloat(discInput.value);
    if (Number.isFinite(v)) rec.discountPct = v;
    persist();
    refresh();
  });

  const qtyHelp = el('span', { class: 'field-help' });
  const discHelp = el('span', { class: 'field-help' });

  const msgArea = el('textarea', { id: 'reqPaste', placeholder: 'Paste the buyer message here…', 'aria-label': 'Paste buyer message' });
  const parseBtn = el('button', { class: 'btn btn-secondary' }, 'Parse message');
  const parseNote = el('span', { class: 'query-chip' });
  parseBtn.addEventListener('click', () => {
    void parseBuyerMessage(msgArea.value, ws, rec, productSel, qtyInput, discInput, parseNote);
  });

  const requestSection = el(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-request' },
    el('h2', { id: 'sec-request', class: 'section-title' }, 'Request'),
    el(
      'div',
      { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', { for: 'reqCustomer' }, 'Customer'), customerInput),
      el('div', { class: 'field' }, el('label', { for: 'reqProduct' }, 'Product'), productSel),
      el('div', { class: 'field' }, el('label', { for: 'reqQty' }, 'Quantity'), qtyInput, qtyHelp),
      el('div', { class: 'field' }, el('label', { for: 'reqDisc' }, 'Discount %'), discInput, discHelp),
    ),
    el('div', { class: 'field' }, el('label', { for: 'reqPaste' }, 'Paste buyer message'), msgArea),
    el('div', { class: 'btn-row' }, parseBtn, parseNote),
    el('div', { class: 'provenance-line' }, `Received ${fmtDateTime(rec.createdAt)}`),
  );

  const errorsNote = el('div', { class: 'note note--err', hidden: '' });

  /* Pricing section */
  const pricingBody = el('tbody', {});
  const pricingFoot = el('div', { class: 'table-footnote' });
  const pricingSection = el(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-pricing' },
    el('h2', { id: 'sec-pricing', class: 'section-title' }, 'Pricing'),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['', 'Retail', 'Discount', 'Unit price', 'Unit cost', 'Margin'].map((h) => el('th', { scope: 'col' }, h)))),
        pricingBody,
      ),
    ),
    pricingFoot,
  );

  /* Reply section */
  const replyArea = el('textarea', { id: 'reqReply', class: 'reply-textarea', readonly: '', 'aria-label': 'Reply to buyer draft' });
  const copyReplyBtn = el('button', { class: 'btn btn-secondary' }, 'Copy');
  copyReplyBtn.addEventListener('click', () => void copyText(replyArea.value, 'Buyer reply'));
  const waLink = el('a', { class: 'btn btn-secondary', target: '_blank', rel: 'noopener' }, 'Open WhatsApp');
  const replySection = el(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-reply' },
    el('h2', { id: 'sec-reply', class: 'section-title' }, 'Reply to buyer'),
    replyArea,
    el('div', { class: 'reply-actions' }, copyReplyBtn, waLink),
  );

  /* right rail */
  const checksList = el('ul', { class: 'checks-list' });
  const approvalBox = el('div', {});
  const activityList = el('ol', { class: 'timeline' });
  const privacySettingsBtn = el('button', { class: 'link' }, 'Settings → Privacy');
  privacySettingsBtn.addEventListener('click', () => goTab('settings'));

  const aside = el(
    'aside',
    { class: 'right-column', 'aria-label': 'Request details' },
    el(
      'section',
      { class: 'rail-section', 'aria-labelledby': 'rail-policy' },
      el('h2', { id: 'rail-policy', class: 'rail-title' }, 'Policy checks'),
      checksList,
    ),
    el(
      'section',
      { class: 'rail-section', 'aria-labelledby': 'rail-approval' },
      el('h2', { id: 'rail-approval', class: 'rail-title' }, 'Approval'),
      approvalBox,
    ),
    el(
      'section',
      { class: 'rail-section', 'aria-labelledby': 'rail-privacy' },
      el('h2', { id: 'rail-privacy', class: 'rail-title' }, 'Privacy'),
      el('div', { class: 'status-note' }, iconSvg('lock'), el('span', {}, 'Sent to cloud: anonymized text only')),
      el('div', { class: 'rail-action' }, privacySettingsBtn),
    ),
    el(
      'section',
      { class: 'rail-section', 'aria-labelledby': 'rail-activity' },
      el('h2', { id: 'rail-activity', class: 'rail-title' }, 'Activity'),
      activityList,
    ),
  );

  root.replaceChildren(
    header,
    el('div', { class: 'detail-grid' }, el('div', { class: 'main-column' }, requestSection, errorsNote, pricingSection, replySection), aside),
  );

  /* ---------- live refresh: sections recompute, fields keep focus ---------- */
  function refresh(): void {
    if (ws) deal = computeRecordDeal(ws, rec);
    if (deal.verdict) {
      pushActivity(rec, 'checked', `Checked — suggested ${fmtPct(deal.verdict.counterDiscountPct)}`);
      persist();
    }

    badgeBox.replaceChildren(badgeSpan(deal));
    const canApply = deal.verdict !== null && deal.input !== null && deal.verdict.counterDiscountPct !== deal.input.requestedDiscountPct;
    applyBtn.disabled = !canApply;

    errorsNote.hidden = deal.errors.length === 0;
    if (deal.errors.length > 0) {
      errorsNote.replaceChildren(el('strong', {}, 'Fix before checking:'), el('ul', {}, ...deal.errors.map((e) => el('li', {}, e))));
    }

    // field help / invalid marks
    discHelp.textContent = '';
    discHelp.className = 'field-help';
    discInput.classList.remove('is-invalid');
    if (deal.input && deal.verdict) {
      const parts: string[] = [];
      if (deal.cap !== null && deal.input.requestedDiscountPct > deal.cap + 1e-9) parts.push(`Exceeds the ${fmtPct(deal.cap)} cap`);
      if (deal.floor !== null && deal.verdict.requestedMarginPct < deal.floor - 1e-9) parts.push(`falls below the ${fmtPct(deal.floor)} margin floor`);
      if (parts.length > 0) {
        const line = parts.join(' and ');
        discHelp.textContent = `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
        discHelp.className = 'field-help is-error';
        discInput.classList.add('is-invalid');
      }
    }
    qtyHelp.textContent = deal.rule && (deal.rule.min_qty_condition ?? '').trim() ? `Bulk tier: ${deal.rule.min_qty_condition.trim()}.` : '';

    // pricing table: Requested + Suggested rows
    const rows = pricingRows(deal);
    const rowNode = (label: string, r: PriceRow | null): HTMLElement => {
      if (!r) return el('tr', {}, el('td', {}, label), el('td', {}, '—'), el('td', {}, '—'), el('td', {}, '—'), el('td', {}, '—'), el('td', {}, '—'));
      return el(
        'tr',
        {},
        el('td', {}, label),
        el('td', {}, money(r.retail)),
        el('td', { class: 'num-strong' }, fmtPct(r.discountPct)),
        el('td', {}, money(r.unitPrice)),
        el('td', {}, money(r.unitCost)),
        el(
          'td',
          {},
          el(
            'span',
            { class: 'margin-cell' },
            el('span', { class: r.belowFloor ? 'margin-fail' : 'margin-pass' }, fmtPct1(r.marginPct)),
            el('span', { class: `badge ${r.belowFloor ? 'badge--breach' : 'badge--approved'}` }, r.belowFloor ? 'Below floor' : 'Meets floor'),
          ),
        ),
      );
    };
    pricingBody.replaceChildren(rowNode('Requested', rows ? rows.requested : null), rowNode('Suggested', rows ? rows.suggested : null));
    pricingFoot.replaceChildren();
    if (deal.floor !== null) {
      pricingFoot.append(`Margin floor ${fmtPct(deal.floor)} · `);
      if (deal.rule) {
        const ruleId = deal.rule.rule_id;
        const link = el('button', { class: 'link' }, citationOf(deal.rule));
        link.addEventListener('click', () => goRule(ruleId));
        pricingFoot.append(link);
      } else {
        pricingFoot.append('no rule found for this venture');
      }
    }

    // policy checks rail
    const checks = policyChecks(deal, deal.verdict ? deal.verdict.requestedMarginPct : null);
    checksList.replaceChildren(
      ...checks.map((c) => {
        const link = c.ruleId
          ? (() => {
              const b = el('button', { class: 'clause-link' }, c.linkLabel);
              const ruleId = c.ruleId as string;
              b.addEventListener('click', () => goRule(ruleId));
              return b;
            })()
          : el('span', { class: 'clause-link' }, 'no source');
        return el(
          'li',
          { class: 'check-row' },
          el(
            'div',
            { class: 'check-left' },
            iconSvg(c.state),
            el('div', { class: 'check-body' }, el('span', { class: 'check-label' }, c.label), el('span', { class: `check-status${c.state === 'fail' ? ' is-fail' : ''}` }, c.status)),
          ),
          link,
        );
      }),
    );

    // approval rail — partner name comes from the graph, never invented
    const approval = approvalInfo(deal);
    approvalBox.replaceChildren(el('div', { class: 'status-note' }, iconSvg(approval.needed ? 'na' : 'pass'), el('span', {}, approval.note)));
    if (approval.message) {
      approvalBox.append(el('div', { class: 'draft' }, el('pre', {}, approval.message)));
      if (approval.buttonLabel) {
        const btn = el('button', { class: 'btn btn-secondary' }, approval.buttonLabel);
        const message = approval.message;
        btn.addEventListener('click', () => void copyText(message, 'Partner message'));
        approvalBox.append(el('div', { class: 'rail-action' }, btn));
      }
    }

    // reply draft + WhatsApp link (wa.me, no phone number — the user picks the chat)
    const reply = deal.drafts ? deal.drafts.buyerReply : '';
    replyArea.value = reply;
    if (reply) {
      waLink.href = `https://wa.me/?text=${encodeURIComponent(reply)}`;
      waLink.removeAttribute('aria-disabled');
    } else {
      waLink.removeAttribute('href');
      waLink.setAttribute('aria-disabled', 'true');
    }

    // activity timeline
    activityList.replaceChildren(
      ...rec.activity.map((a) =>
        el(
          'li',
          { class: 'timeline-item' },
          el('span', { class: 'timeline-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'timeline-text' }, a.note),
          el('span', { class: 'timeline-time' }, fmtTime(a.at)),
        ),
      ),
    );
  }

  refresh();
}

/* ---------- buyer-message parsing (parseQuery fills the fields) ---------- */

async function parseBuyerMessage(
  raw: string,
  ws: Workspace | null,
  rec: RequestRecord,
  productSel: HTMLSelectElement,
  qtyInput: HTMLInputElement,
  discInput: HTMLInputElement,
  note: HTMLElement,
): Promise<void> {
  const text = raw.trim();
  if (!text) {
    note.textContent = 'Paste a buyer message first.';
    return;
  }
  if (!ws) {
    note.textContent = 'Load a workspace first — parsing matches names against your documents.';
    return;
  }
  const g = ws; // const copy: keeps narrowing valid inside the callbacks below
  try {
    const p = await parseQuery(text, g.graph, g.tokenMap);
    note.textContent = `Parsed locally — ${p.source === 'model' ? 'on-device model' : 'offline parser'}`;
    if (p.discountPct !== null) {
      rec.discountPct = p.discountPct;
      discInput.value = String(p.discountPct);
    }
    if (p.qty !== null) {
      rec.qty = p.qty;
      qtyInput.value = String(p.qty);
    }
    const products = g.graph.products.filter((x) => x.venture_id === rec.ventureId);
    const labels = products.map((x) => skuNameOf(g, x.sku_id) || x.sku_id);
    const hit = fuzzyMatch(p.skuHint ?? text, labels);
    if (hit) {
      const node = products.find((x) => (skuNameOf(g, x.sku_id) || x.sku_id) === hit);
      if (node) {
        rec.skuId = node.sku_id;
        productSel.value = node.sku_id;
      }
    }
    persist();
    render();
  } catch {
    note.textContent = 'Could not parse that message — set the fields by hand.';
  }
}
