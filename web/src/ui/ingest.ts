// WS-4 Ingest (Documents page): file upload / paste / sample seed → chunker →
// anonymizer → blinded cloud graph synthesis → local save. Stages degrade with
// visible messages when upstream modules throw (expected while stubs are in
// place). Restyle 2026-11-24 (Stripe Dashboard shell): the pipeline renders as
// the ledger with the PRIVACY BOUNDARY band, an event log, measured durations
// and engine tags. Pipeline logic is untouched; tags are honest (no NER claim
// unless on-device NER is actually available, model names only ever come from
// usedModels).
import { PayloadBlockedError, synthesizeGraph } from '../cloud/graphExtractor';
import { onDeviceStatus } from '../hybrid';
import { anonymizeChunks } from '../ingest/anonymizer';
import { chunkDocument } from '../ingest/chunker';
import { extractTextFromFile } from '../ingest/textextract';
import { saveWorkspaceLocal } from '../storage/db';
import type { AnonymizeResult, DocChunk, KnowledgeGraph, PayloadLogEntry, Workspace } from '../types';
import { store } from './state';
import { el, errText, newId, toast } from './util';
import { isSpaFallback } from '../ingest/spaFallback';

/**
 * Sample docs. Each entry lists candidate paths under /sample-docs/:
 * the canonical names first, then the A1/A2/A3/B1 variants that actually
 * shipped, so the seed button works against either layout.
 */
const SAMPLE_DOCS: Array<{ title: string; paths: string[] }> = [
  { title: 'Atelier Emily partnership agreement', paths: ['atelier-emily-partnership-agreement.md', 'A1-atelier-emily-partnership-agreement.md'] },
  { title: 'Atelier Emily October meeting notes', paths: ['atelier-emily-october-meeting-notes.md', 'A2-october-meeting-notes.md'] },
  { title: 'Atelier Emily cost sheet', paths: ['atelier-emily-cost-sheet.md', 'A3-atelier-emily-cost-sheet.md'] },
  { title: 'Nomad Studio solo terms', paths: ['nomad-studio-solo-terms.md', 'B1-nomad-studio-solo-terms.md'] },
];

// Ledger rows. `engine` stays honest: LOCAL RULES until on-device NER is
// proven available (then LOCAL NER); the cloud tag never names a model —
// the model chip (from usedModels) is the only place model names appear.
const STAGES = [
  { id: 'extract', idx: '01', label: 'Extract text', engine: 'LOCAL REGEX', blurb: '.txt / .md / text-layer PDF — local' },
  { id: 'chunk', idx: '02', label: 'Chunk documents', engine: 'LOCAL HEUR', blurb: '~600 words, page-tagged — local' },
  { id: 'redact', idx: '03', label: 'Symbolic redaction', engine: 'LOCAL RULES', blurb: 'local rules — raw text never leaves' },
  { id: 'synthesize', idx: '04', label: 'Cloud graph synthesis', engine: 'CLOUD', blurb: 'IN_CLOUD — blinded tokens only' },
  { id: 'save', idx: '05', label: 'Save (IndexedDB)', engine: 'LOCAL CACHE', blurb: 'local cache — never leaves the device' },
] as const;

type StageId = (typeof STAGES)[number]['id'];
type StageState = 'idle' | 'run' | 'ok' | 'err' | 'skip';

const STATE_CLASS: Record<StageState, string> = {
  idle: 'lrow--queued',
  run: 'lrow--active',
  ok: 'lrow--done',
  err: 'lrow--err',
  skip: 'lrow--skip',
};

const EMPTY_GRAPH: KnowledgeGraph = { ventures: [], partners: [], products: [], dealRules: [] };

function clockNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function mountIngest(root: HTMLElement): void {
  let running = false;
  const rowEls = new Map<StageId, { row: HTMLDivElement; note: HTMLElement; metric: HTMLElement; dur: HTMLElement }>();
  const stageStartedAt = new Map<StageId, number>();

  // Result-summary elements declared before resetStages so no forward reference.
  const modelChip = el('span', { class: 'model-chip', 'aria-live': 'polite' });
  const wsStats = el('div', { class: 'stats' });
  const wsSummary = el(
    'div',
    { class: 'ws-summary' },
    el('div', { class: 'summary-head' }, el('h2', {}, 'Workspace result')),
    wsStats,
  );
  wsSummary.hidden = true;

  // Screen-2 ledger: three local rows, the privacy boundary, two rows below.
  const ledger = el('div', { class: 'ledger', role: 'table', 'aria-label': 'Pipeline stages' });
  function addRow(s: (typeof STAGES)[number]): void {
    const note = el('span', { class: 'lnote', id: `note-${s.id}` }, s.blurb);
    const row = el(
      'div',
      { class: 'lrow lrow--queued', id: `stage-${s.id}`, role: 'row' },
      el('span', { class: 'lidx' }, s.idx),
      el('span', { class: 'llabel' }, el('span', {}, s.label), note),
      el('span', { class: s.id === 'synthesize' ? 'engine-tag engine-tag--cloud' : 'engine-tag' }, s.engine),
      el('span', { class: 'metric' }, '—'),
      el('span', { class: 'dur' }, '—'),
    );
    rowEls.set(s.id, { row, note, metric: row.children[3] as HTMLElement, dur: row.children[4] as HTMLElement });
    ledger.append(row);
  }
  addRow(STAGES[0]);
  addRow(STAGES[1]);
  addRow(STAGES[2]);
  ledger.append(el('div', { class: 'boundary-band' }, 'PRIVACY BOUNDARY — MASKED PAYLOAD ONLY'));
  addRow(STAGES[3]);
  addRow(STAGES[4]);

  // Event log strip (ops-tool proof): every stage transition, timestamped.
  const evlog = el('div', { class: 'evlog' }, el('div', { class: 'evlog-head' }, 'EVENT LOG — THIS RUN'));
  const evBody = evlog;
  function logEvent(kind: 'ok' | 'err' | 'info', msg: string): void {
    const row = el('div', { class: `evrow${kind === 'info' ? '' : ` evrow--${kind}`}` }, el('span', { class: 'evtime' }, clockNow()), el('span', { class: 'evmsg' }, msg));
    evBody.append(row);
    while (evBody.querySelectorAll('.evrow').length > 12) evBody.querySelector('.evrow')?.remove();
  }

  function setStage(id: StageId, state: StageState, text?: string, metric?: string): void {
    const s = rowEls.get(id);
    if (!s) return;
    if (state === 'run' && !stageStartedAt.has(id)) stageStartedAt.set(id, Date.now());
    const stage = STAGES.find((x) => x.id === id);
    s.row.className = `lrow ${STATE_CLASS[state]}`;
    if (text !== undefined) s.note.textContent = text;
    if (metric !== undefined) s.metric.textContent = metric;
    if (state !== 'run') {
      const started = stageStartedAt.get(id);
      if (started !== undefined && (state === 'ok' || state === 'skip')) {
        s.dur.textContent = `${((Date.now() - started) / 1000).toFixed(2)}s`;
      } else if (state === 'err') {
        s.dur.textContent = '—';
      }
    }
    if (stage) logEvent(state === 'err' ? 'err' : state === 'ok' ? 'ok' : 'info', `${stage.idx} ${stage.label}: ${text ?? state}`);
  }

  function resetStages(): void {
    stageStartedAt.clear();
    for (const s of STAGES) {
      const entry = rowEls.get(s.id);
      if (entry) {
        entry.row.className = 'lrow lrow--queued';
        entry.note.textContent = s.blurb;
        entry.metric.textContent = '—';
        entry.dur.textContent = '—';
      }
    }
    evlog.replaceChildren(el('div', { class: 'evlog-head' }, 'EVENT LOG — THIS RUN'));
    modelChip.textContent = '';
    wsStats.replaceChildren();
    wsSummary.hidden = true;
  }

  // Honest engine tag for stage 3: NER only when the on-device model is up.
  void onDeviceStatus()
    .then((st) => {
      if (!st.available) return;
      const entry = rowEls.get('redact');
      const tag = entry?.row.querySelector('.engine-tag');
      if (tag) tag.textContent = 'LOCAL NER';
    })
    .catch(() => {
      /* status probe failed — the honest default (LOCAL RULES) stays */
    });

  /* ---------- pipeline ---------- */

  type Source = { docName: string; text?: string; file?: File };

  async function runPipeline(sources: Source[]): Promise<void> {
    if (running) {
      toast('Pipeline already running — wait for it to finish', 'warn');
      return;
    }
    running = true;
    resetStages();
    try {
      // Stage 1 — extract
      setStage('extract', 'run');
      const texts: { docName: string; text: string }[] = [];
      for (const s of sources) {
        if (typeof s.text === 'string') {
          texts.push({ docName: s.docName, text: s.text });
        } else if (s.file) {
          try {
            texts.push({ docName: s.file.name, text: await extractTextFromFile(s.file) });
          } catch (e) {
            setStage('extract', 'err', `${s.file.name}: ${errText(e)}`);
          }
        }
      }
      if (texts.length === 0) {
        if (rowEls.get('extract')!.row.className === 'lrow lrow--active') setStage('extract', 'err', 'No text extracted.');
        return;
      }
      const chars = texts.reduce((a, t) => a + t.text.length, 0);
      setStage('extract', 'ok', `${texts.length} document(s) · ${chars.toLocaleString()} chars`, `${chars.toLocaleString()} ch`);

      // Stage 2 — chunk
      setStage('chunk', 'run');
      let chunks: DocChunk[] = [];
      try {
        for (const t of texts) chunks = chunks.concat(chunkDocument(t.docName, t.text, 600));
        setStage('chunk', 'ok', `${chunks.length} chunk(s) across ${texts.length} doc(s)`, `${chunks.length} chunks`);
      } catch (e) {
        setStage('chunk', 'err', errText(e));
        return;
      }

      // Stage 3 — redact (local)
      setStage('redact', 'run');
      let anon: AnonymizeResult;
      try {
        anon = await anonymizeChunks(chunks);
        setStage('redact', 'ok', `${Object.keys(anon.tokenMap).length} typed token(s) · ${anon.blinded.length} blinded chunk(s)`, `${Object.keys(anon.tokenMap).length} masked`);
      } catch (e) {
        setStage('redact', 'err', errText(e));
        return;
      }

      // Stage 4 — cloud synthesis over BLINDED text only. Entries stream into
      // `log` as they are recorded (before each request), so an attempted-but-
      // failed cloud call still leaves an honest payload record (CV-SEC-2).
      let graph = EMPTY_GRAPH;
      let log: PayloadLogEntry[] = [];
      setStage('synthesize', 'run');
      try {
        const synth = await synthesizeGraph(anon.blinded, buildLegend(anon), (entry) => log.push(entry),
          (attempt, waitMs) => setStage('synthesize', 'run',
            `Gemini is busy, retrying… (attempt ${attempt} of 3 failed, waiting ~${Math.max(1, Math.round(waitMs / 1000))}s)`));
        graph = synth.graph;
        setStage('synthesize', 'ok', `${graph.ventures.length} venture(s) · ${graph.products.length} SKU(s) · ${graph.dealRules.length} rule(s) · ${log.length} payload(s) logged${synth.usedModels.length ? ` · model(s): ${synth.usedModels.join(' + ')}` : ''}`, `${log.length} payloads`);
        // Honest attribution stays visible in the card header, not just the line.
        modelChip.textContent = synth.usedModels.length ? `model: ${synth.usedModels.join(' + ')}` : '';
      } catch (e) {
        const blocked = e instanceof PayloadBlockedError;
        setStage('synthesize', 'err', blocked
          ? `${errText(e)} — workspace kept WITHOUT the cloud graph`
          : `${errText(e)} — workspace kept WITHOUT the cloud graph (${log.length} attempted payload(s) recorded)`);
      }

      const ws: Workspace = {
        id: newId(),
        name: texts.map((t) => t.docName).join(' + ').slice(0, 80) || 'Workspace',
        graph,
        tokenMap: anon.tokenMap,
        docs: anon.blinded.map((b) => ({ docName: b.docName, page: b.page, index: b.index, blindedText: b.text })),
        payloadLog: log,
        updatedAt: Date.now(),
      };

      // Stage 5 — local persistence
      setStage('save', 'run');
      try {
        await saveWorkspaceLocal(ws);
        setStage('save', 'ok', 'Saved to local cache (IndexedDB)', 'cached');
      } catch (e) {
        setStage('save', 'skip', `Not persisted: ${errText(e)}`, '—');
      }

      const graphCount = graph.ventures.length + graph.products.length + graph.dealRules.length;

      // Result summary: numbers the pipeline already proved on screen.
      wsStats.replaceChildren(
        statCell('Documents', texts.length),
        statCell('Chunks', chunks.length),
        statCell('Typed tokens', Object.keys(anon.tokenMap).length),
        statCell('Graph entries', graphCount),
      );
      wsSummary.hidden = false;

      store.setWorkspace(ws);
      const full = graph.ventures.length > 0;
      toast(
        full
          ? `Workspace ready — open Settings → Privacy to see the exact cloud payload`
          : 'Partial workspace (no cloud graph yet) — check the stage errors and re-run',
        full ? 'ok' : 'warn',
      );
    } finally {
      running = false;
    }
  }

  /**
   * Legend sent alongside blinded text. Deliberately maps token → TYPE only;
   * real values never leave the device (privacy invariant #1).
   */
  function buildLegend(res: AnonymizeResult): string {
    const types = new Map<string, string>();
    for (const c of res.blinded) for (const d of c.detected) if (!types.has(d.token)) types.set(d.token, d.type);
    return Object.keys(res.tokenMap)
      .map((t) => `${t} (type: ${types.get(t) ?? 'UNKNOWN'})`)
      .join('\n');
  }

  /* ---------- sources UI ---------- */

  const fileInput = el('input', { type: 'file', id: 'fileInput', accept: '.txt,.md,.pdf', multiple: '' });
  const pasteArea = el('textarea', {
    id: 'pasteText',
    placeholder: 'Paste contract / meeting-note text here…',
    'aria-label': 'Pasted document text',
    spellcheck: 'false',
  });
  const pasteName = el('input', { type: 'text', id: 'pasteName', value: 'pasted-note.md', 'aria-label': 'Pasted document name' });
  const statusLine = el('div', { class: 'note', text: 'Idle. Pick a source and the five stages will light up below.' });

  function setStatus(kind: string, text: string): void {
    statusLine.className = `note ${kind}`;
    statusLine.textContent = text;
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length === 0) return;
    setStatus('note', `Reading ${files.length} file(s)…`);
    void runPipeline(files.map((f) => ({ docName: f.name, file: f })));
    fileInput.value = '';
  });

  const pasteBtn = el('button', { class: 'btn btn-primary' }, 'Add pasted text');
  pasteBtn.addEventListener('click', () => {
    const text = pasteArea.value.trim();
    if (!text) {
      setStatus('note--warn', 'Paste some text first.');
      return;
    }
    const name = pasteName.value.trim() || 'pasted-note.md';
    void runPipeline([{ docName: name, text }]);
  });

  const sampleBtn = el('button', { class: 'btn btn-primary' }, 'Load sample workspace');
  sampleBtn.addEventListener('click', () => {
    void (async () => {
      sampleBtn.disabled = true;
      setStatus('note', 'Fetching /sample-docs/…');
      const sources: Source[] = [];
      const missing: string[] = [];
      for (const doc of SAMPLE_DOCS) {
        let fetched: Source | null = null;
        const tried: string[] = [];
        for (const name of doc.paths) {
          try {
            const r = await fetch(`/sample-docs/${name}`);
            if (r.ok) {
              const body = await r.text();
              if (isSpaFallback(r.headers.get('content-type'), body)) {
                tried.push(`${name} (SPA fallback, not found)`);
                continue;
              }
              fetched = { docName: name, text: body };
              break;
            }
            tried.push(`${name} (HTTP ${r.status})`);
          } catch (e) {
            tried.push(`${name} (${errText(e)})`);
          }
        }
        if (fetched) sources.push(fetched);
        else missing.push(`${doc.title}: ${tried.join(', ')}`);
      }
      if (missing.length > 0) {
        setStatus('note--warn', `Sample fetch problems: ${missing.join(' · ')}`);
      }
      if (sources.length === 0) {
        setStatus('note--err', 'No sample docs available — upload your own files instead.');
        sampleBtn.disabled = false;
        return;
      }
      if (missing.length > 0) toast(`${sources.length} of ${SAMPLE_DOCS.length} sample docs loaded`, 'warn');
      await runPipeline(sources);
      sampleBtn.disabled = false;
    })();
  });

  /* ---------- layout ---------- */

  function statCell(k: string, v: number): HTMLElement {
    return el('div', { class: 'stat' }, el('span', { class: 'stat-k' }, k), el('span', { class: 'stat-v' }, v.toLocaleString()));
  }

  const filesCard = el(
    'div',
    { class: 'section' },
    el('h2', { class: 'section-title' }, 'Upload files'),
    el('p', {}, 'Upload contracts, meeting notes or cost sheets (.txt, .md, text PDFs). Files are read on this device.'),
    el('div', { class: 'field' }, el('label', { for: 'fileInput' }, 'Documents'), fileInput),
  );

  const pasteCard = el(
    'div',
    { class: 'section' },
    el('h2', { class: 'section-title' }, 'Paste text'),
    el('p', {}, 'Paste any agreement or note; it joins the same pipeline.'),
    el('div', { class: 'field' }, el('label', { for: 'pasteText' }, 'Text'), pasteArea),
    el('div', { class: 'field' }, el('label', { for: 'pasteName' }, 'Document name'), pasteName),
    pasteBtn,
  );

  const sampleCard = el(
    'div',
    { class: 'section' },
    el('h2', { class: 'section-title' }, 'Sample workspace'),
    el('p', {}, 'Two demo ventures — one co-owned with capped discounts, one solo. Nothing is uploaded; everything is read on this device.'),
    sampleBtn,
  );

  const progressCard = el(
    'div',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'section-title' }, 'Pipeline Runner'), modelChip),
    el('p', {}, 'Local stages run first; only blinded tokens cross the boundary to the cloud stage. Errors degrade visibly instead of crashing.'),
    ledger,
    evlog,
    wsSummary,
    statusLine,
  );

  root.replaceChildren(
    el('div', { class: 'grid-2' }, filesCard, pasteCard),
    sampleCard,
    progressCard,
  );
}
