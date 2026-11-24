// Rules page (phase 1): lists the DealRuleNodes of the loaded knowledge graph
// with locally re-hydrated values. Empty state points at the Documents page.
import type { DealRuleNode, Workspace } from '../types';
import { goTab, store } from './state';
import { el, hydrate, parseNum, pct } from './util';

export function mountRules(root: HTMLElement): void {
  const render = (): void => renderRules(root);
  store.subscribe(render);
  render();
}

function citationOf(rule: DealRuleNode): string {
  const page = rule.page_or_section?.trim() ? ` ${rule.page_or_section.trim()}` : '';
  return `${rule.source_doc_name}${page}`;
}

function renderRules(root: HTMLElement): void {
  const ws = store.workspace;
  if (!ws || ws.graph.dealRules.length === 0) {
    root.replaceChildren(emptyState());
    return;
  }
  root.replaceChildren(rulesSection(ws));
}

function rulesSection(ws: Workspace): HTMLElement {
  const rules = ws.graph.dealRules;
  const rows = rules.map((r) => {
    const cap = parseNum(hydrate(ws.tokenMap, r.max_discount_pct_token));
    const venture = ws.graph.ventures.find((v) => v.venture_id === r.venture_id) ?? null;
    const ventureName = venture ? hydrate(ws.tokenMap, venture.venture_token) || venture.venture_id : r.venture_id;
    return el(
      'tr',
      {},
      el('td', {}, r.rule_id),
      el('td', {}, ventureName),
      el('td', {}, cap !== null ? pct(cap) : 'no cap — solo venture'),
      el('td', {}, r.min_qty_condition?.trim() ? r.min_qty_condition.trim() : '—'),
      el('td', {}, r.requires_partner_approval ? el('span', { class: 'badge badge--signoff' }, 'Approval required') : 'Not required'),
      el('td', { class: 'cite-src' }, citationOf(r)),
    );
  });
  const table = el(
    'table',
    { class: 'data-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col' }, 'Rule'),
        el('th', { scope: 'col' }, 'Venture'),
        el('th', { scope: 'col' }, 'Discount cap'),
        el('th', { scope: 'col' }, 'Min qty'),
        el('th', { scope: 'col' }, 'Partner approval'),
        el('th', { scope: 'col' }, 'Source'),
      ),
    ),
    el('tbody', {}, ...rows),
  );
  return el(
    'div',
    { class: 'section' },
    el('h2', { class: 'section-title' }, `Extracted rules — ${rules.length}`),
    el('p', { class: 'hint' }, 'Deal rules the ingestion pipeline extracted from your documents. Discount caps are re-hydrated locally from the Secret Key Map — the cloud never sees the values.'),
    table,
  );
}

function emptyState(): HTMLElement {
  const box = el(
    'div',
    { class: 'empty' },
    el('h2', { class: 'empty-title' }, 'Load documents to extract rules'),
    el('p', { class: 'empty-sub' }, 'Rules are extracted by the ingestion pipeline from your contracts, notes and cost sheets. Nothing is loaded on this device yet.'),
    el('div', { class: 'cta-row' }, el('button', { class: 'btn btn-primary' }, 'Open Documents')),
  );
  box.querySelector('button')?.addEventListener('click', () => goTab('documents'));
  return box;
}
