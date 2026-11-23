// WS-4 Privacy Inspector (FR-3): side-by-side LOCAL device memory vs the
// EXACT cloud payload, plus a live leak self-check and the token table.
import { el, findLeakedValues, type LeakHit } from './util';
import { goTab, store } from './state';
import type { PayloadLogEntry, Workspace } from '../types';

export function mountInspector(root: HTMLElement): void {
  const render = (): void => renderInspector(root);
  store.subscribe(render);
  render();
}

function renderInspector(root: HTMLElement): void {
  const ws = store.workspace;
  if (!ws) {
    root.replaceChildren(emptyState());
    return;
  }

  const nodes: Node[] = [header(ws)];

  const entries = ws.payloadLog;
  nodes.push(selfCheckBanner(entries, ws));

  if (entries.length > 0) {
    const localCol = el('div', {}, colHead('local', 'LOCAL DEVICE MEMORY', 'never leaves this device'));
    const cloudCol = el('div', {}, colHead('cloud', 'EXACT CLOUD PAYLOAD', 'verbatim bytes sent'));
    for (const e of entries) {
      const label = `${e.docName} · p.${e.page} · ${new Date(e.sentAt).toLocaleTimeString()}${e.status === 'attempted' ? ' · NO CLOUD RESPONSE' : ''}`;
      localCol.append(
        el(
          'div',
          { class: 'payload-block' },
          el('div', { class: 'ph' }, label),
          el('pre', { class: 'payload' }, e.localText),
        ),
      );
      cloudCol.append(
        el(
          'div',
          { class: 'payload-block' },
          el('div', { class: 'ph' }, label),
          el('pre', { class: 'payload payload--cloud' }, e.cloudText),
        ),
      );
    }
    nodes.push(el('div', { class: 'insp-cols' }, localCol, cloudCol));
  } else if (ws.docs.length > 0) {
    // Anonymizer worked, cloud never ran (e.g. WS-3 stub): still show what the
    // cloud WOULD receive — the blinded chunks held locally.
    nodes.push(
      el(
        'div',
        { class: 'note note--warn' },
        'No cloud payload logged yet (graph synthesis did not complete). Blinded chunk previews below show exactly what WOULD be sent.',
      ),
    );
    nodes.push(blindedPreview(ws));
  }

  nodes.push(tokenTableCard(ws));
  root.replaceChildren(...nodes);
}

function header(ws: Workspace): HTMLElement {
  return el(
    'div',
    { class: 'card' },
    el('h2', {}, 'Privacy Firewall Inspector'),
    el(
      'p',
      {},
      `Workspace “${ws.name}” · updated ${new Date(ws.updatedAt).toLocaleString()} — left: real text and values held in local memory only; right: the exact string Firebase AI Logic received.`,
    ),
  );
}

function selfCheckBanner(entries: PayloadLogEntry[], ws: Workspace): HTMLElement {
  if (entries.length === 0) {
    return el(
      'div',
      { class: 'banner banner--muted' },
      el('strong', {}, 'LEAK SELF-CHECK: NOT RUN'),
      ' No cloud payloads captured — run a full pipeline to capture and scan them.',
    );
  }
  const hits: LeakHit[] = [];
  let checked = 0;
  const seenHit = new Set<string>(); // chunk entries share one cloudText — one hit per token+value
  for (const e of entries) {
    const scan = findLeakedValues(ws.tokenMap, e.cloudText, `${e.docName} p.${e.page}`);
    for (const h of scan.hits) {
      const key = `${h.token}\u0000${h.value}`;
      if (!seenHit.has(key)) {
        seenHit.add(key);
        hits.push(h);
      }
    }
    checked = scan.checked; // same token map per payload; last scan is representative
  }
  if (hits.length === 0) {
    return el(
      'div',
      { class: 'banner banner--pass' },
      el('strong', {}, `SELF-CHECK PASS — known-value check: 0 of ${checked} redacted value(s) found in ${entries.length} cloud payload(s)`),
      ' Best-effort scan of the verbatim outbound text: numbers in plain, comma- and dot-grouped forms (currency/percent affixes stripped, digit-boundary guards), names as whole words, partner names also by first/last word. A pass means no known value matched — it is not a proof that no sensitive data was sent.',
    );
  }
  const list = el('ul');
  for (const h of hits.slice(0, 12)) list.append(el('li', {}, `${h.value} (${h.token}) found in ${h.where}`));
  if (hits.length > 12) list.append(el('li', {}, `…and ${hits.length - 12} more`));
  return el(
    'div',
    { class: 'banner banner--fail' },
    el('strong', {}, `SELF-CHECK FAIL — known-value check: ${hits.length} leaked value(s) of ${checked} redacted value(s) in cloud payloads`),
    ' Stop using this pipeline and report the anonymizer bug:',
    list,
  );
}

function colHead(kind: 'local' | 'cloud', label: string, tag: string): HTMLElement {
  return el('div', { class: `col-head col-head--${kind}` }, el('span', {}, label), el('span', { class: 'tag' }, tag));
}

function blindedPreview(ws: Workspace): HTMLElement {
  const localCol = el('div', {}, colHead('local', 'LOCAL DEVICE MEMORY', 'original chunk text'));
  const cloudCol = el('div', {}, colHead('cloud', 'WOULD-BE CLOUD TEXT', 'blinded chunk, held locally'));
  for (const d of ws.docs.slice(0, 6)) {
    const label = `${d.docName} · p.${d.page} · chunk ${d.index}`;
    localCol.append(el('div', { class: 'payload-block' }, el('div', { class: 'ph' }, label), el('pre', { class: 'payload' }, '(original text not retained after ingestion — see payload log when cloud runs)')));
    cloudCol.append(el('div', { class: 'payload-block' }, el('div', { class: 'ph' }, label), el('pre', { class: 'payload payload--cloud' }, d.blindedText)));
  }
  return el('div', { class: 'insp-cols' }, localCol, cloudCol);
}

function tokenTableCard(ws: Workspace): HTMLElement {
  const rows = Object.entries(ws.tokenMap);
  const table = el('table', { class: 'token-table' });
  table.append(
    el(
      'thead',
      {},
      el('tr', {}, el('th', {}, 'Symbolic token (cloud sees this)'), el('th', {}, 'Real local value (device only)'), el('th', {}, 'Re-hydrates in')),
    ),
    el(
      'tbody',
      {},
      ...rows.map(([tok, val]) =>
        el(
          'tr',
          {},
          el('td', { class: 'tok' }, tok),
          el('td', { class: 'val' }, val),
          el('td', {}, 'Simulator names, numbers, citations'),
        ),
      ),
    ),
  );
  return el(
    'div',
    { class: 'card' },
    el('h2', {}, `Secret key map — ${rows.length} token(s)`),
    el('p', {}, 'Stored exclusively on this device. The Deal Simulator maps these back into the graph before rendering or computing anything.'),
    rows.length === 0 ? el('div', { class: 'note note--warn' }, 'Token map is empty — run ingestion.') : table,
  );
}

function emptyState(): HTMLElement {
  const box = el(
    'div',
    { class: 'empty' },
    el('h2', { class: 'hero-head' }, 'No workspace yet'),
    el('p', { class: 'hero-sub' }, 'Ingest documents first — the Inspector needs the local chunks and the exact payloads the cloud call produced.'),
    el('div', { class: 'cta-row' }, el('button', { class: 'btn btn-primary' }, 'Go to Ingest')),
  );
  box.querySelector('button')?.addEventListener('click', () => goTab('ingest'));
  return box;
}
