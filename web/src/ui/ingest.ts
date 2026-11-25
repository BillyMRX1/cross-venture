// WS-4 Ingest (Documents page): file upload / paste / sample seed → chunker →
// anonymizer → blinded cloud graph synthesis → local save. Stages degrade with
// visible messages when upstream modules throw (expected while stubs are in
// place). Restyle 2026-11-24 (Stripe Dashboard shell): the pipeline renders as
// the ledger with the PRIVACY BOUNDARY band, an event log, measured durations
// and engine tags. Pipeline logic is untouched; tags are honest (no NER claim
// unless on-device NER is actually available, model names only ever come from
// usedModels).
import {
  PayloadBlockedError,
  mergeKnowledgeGraphs,
  retrySynthesizeDocument,
  synthesizeGraph,
  type SynthesizePoolProgress,
} from '../cloud/graphExtractor';
import { SYNTHESIZE_MAX_ATTEMPTS, onDeviceStatus } from '../hybrid';
import { anonymizeChunks } from '../ingest/anonymizer';
import { chunkDocument } from '../ingest/chunker';
import { extractTextFromFile } from '../ingest/textextract';
import { clearWorkspacesLocal, saveWorkspaceLocal } from '../storage/db';
import {
  groupDocumentsByVenture,
  mergeWorkspaces,
  removeDocumentFromWorkspace,
} from '../storage/workspaceOps';
import type { AnonymizeResult, AnonymizedChunk, DocChunk, KnowledgeGraph, PayloadLogEntry, Workspace } from '../types';
import { openConfirmDialog } from './confirmDialog';
import { buildRemoveDocumentDialog } from './dataSettings';
import { remapRequestVentureIds, removeRequestsForVenture } from './requestModel';
import { syncRequestsFromStorage } from './requests';
import { goSync, hasSyncedCopy, store } from './state';
import { el, errText, hydrate, newId, toast } from './util';
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

/** Formats live concurrent pool progress for stage 04 (done + in-flight counts). */
export function formatSynthesizeProgress(p: SynthesizePoolProgress): { text: string; metric: string } {
  const failSuffix = p.failed > 0 ? ` (${p.failed} failed)` : '';
  const donePart = `${p.done} of ${p.totalCalls} done${failSuffix}`;
  const inFlightPart =
    p.inFlight > 0
      ? ` · ${p.inFlight} in flight${p.activeDocNames.length ? ` — ${p.activeDocNames.join(', ')}` : ''}`
      : '';
  return {
    text: `${donePart}${inFlightPart}`,
    metric: `${p.done}/${p.totalCalls} done`,
  };
}

/** Merges succeeded per-slot graphs back in original document order. */
export function mergeOrderedGraphSlots(slots: Map<number, KnowledgeGraph>, totalSlots: number): KnowledgeGraph {
  const ordered: KnowledgeGraph[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const g = slots.get(i);
    if (g) ordered.push(g);
  }
  return mergeKnowledgeGraphs(ordered);
}

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

  // Failed-document retry banner (shown only when one or more cloud calls fail).
  const failedBox = el('div', { class: 'banner banner--fail', 'aria-live': 'polite' });
  failedBox.hidden = true;

  interface FailedDocItem {
    docName: string;
    slotIndex: number;
    chunks: AnonymizedChunk[];
    message: string;
  }
  interface LastRunState {
    anon: AnonymizeResult;
    legend: string;
    docCount: number;
    chunkCount: number;
    ws: Workspace;
    orderedSlots: Map<number, KnowledgeGraph>;
    totalSlots: number;
    usedModels: Set<string>;
    failedDocs: Map<string, FailedDocItem>;
  }
  let lastRun: LastRunState | null = null;

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
    failedBox.replaceChildren();
    failedBox.hidden = true;
    lastRun = null;
  }

  function updateSummary(docCount: number, chunkCount: number, tokenCount: number, graph: KnowledgeGraph): void {
    const graphCount = graph.ventures.length + graph.products.length + graph.dealRules.length;
    wsStats.replaceChildren(
      statCell('Documents', docCount),
      statCell('Chunks', chunkCount),
      statCell('Typed tokens', tokenCount),
      statCell('Graph entries', graphCount),
    );
    wsSummary.hidden = false;
  }

  function renderFailedDocs(): void {
    if (!lastRun || lastRun.failedDocs.size === 0) {
      failedBox.replaceChildren();
      failedBox.hidden = true;
      return;
    }
    const items = [...lastRun.failedDocs.values()];
    const rows = items.map((item) => {
      const retryBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, 'Retry this document');
      retryBtn.addEventListener('click', () => {
        void retryOneDocument(item.docName, retryBtn);
      });
      return el(
        'div',
        { class: 'btn-row' },
        el('span', {}, `${item.docName} — ${item.message}`),
        retryBtn,
      );
    });
    failedBox.replaceChildren(
      el('strong', {}, `${items.length} document(s) failed cloud synthesis — retry individually without re-running the rest:`),
      ...rows,
    );
    failedBox.hidden = false;
  }

  async function persistMergedWorkspace(
    ws: Workspace,
    ventureIdMap: Record<string, string>,
    fallbackDocCount: number,
    fallbackChunkCount: number,
  ): Promise<void> {
    setStage('save', 'run');
    try {
      await saveWorkspaceLocal(ws);
      setStage('save', 'ok', 'Saved to local cache (IndexedDB)', 'cached');
    } catch (e) {
      setStage('save', 'skip', `Not persisted: ${errText(e)}`, '—');
    }

    if (Object.keys(ventureIdMap).length > 0 && remapRequestVentureIds(ventureIdMap)) {
      syncRequestsFromStorage();
    }

    const uniqueDocCount = new Set(ws.docs.map((d) => d.docName.toLowerCase())).size || fallbackDocCount;
    updateSummary(uniqueDocCount, ws.docs.length || fallbackChunkCount, Object.keys(ws.tokenMap).length, ws.graph);

    store.setWorkspace(ws);
  }

  async function retryOneDocument(docName: string, btn: HTMLButtonElement): Promise<void> {
    if (running) {
      toast('Pipeline already running — wait for it to finish', 'warn');
      return;
    }
    if (!lastRun) return;
    const item = lastRun.failedDocs.get(docName);
    if (!item) return;

    running = true;
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    setStage('synthesize', 'run', `Retrying ${docName}…`);
    const retryLog: PayloadLogEntry[] = [];
    try {
      const retried = await retrySynthesizeDocument(
        item.chunks,
        lastRun.legend,
        (entry) => retryLog.push(entry),
        (attempt, waitMs) =>
          setStage(
            'synthesize',
            'run',
            `Gemini is busy on ${docName}, retrying… (attempt ${attempt} of ${SYNTHESIZE_MAX_ATTEMPTS} failed, waiting ~${Math.max(1, Math.round(waitMs / 1000))}s)`,
          ),
        undefined,
        { extraKnownValues: lastRun.anon.tokenMap },
      );

      lastRun.orderedSlots.set(item.slotIndex, retried.graph);
      for (const m of retried.usedModels) lastRun.usedModels.add(m);
      lastRun.failedDocs.delete(docName);

      const baseWs = store.workspace ?? lastRun.ws;
      const incomingRetryWs: Workspace = {
        id: baseWs.id,
        name: baseWs.name,
        graph: retried.graph,
        tokenMap: lastRun.anon.tokenMap,
        docs: item.chunks.map((b) => ({ docName: b.docName, page: b.page, index: b.index, blindedText: b.text })),
        payloadLog: retryLog,
        updatedAt: Date.now(),
      };
      const { workspace: mergedWs, ventureIdMap } = mergeWorkspaces(store.workspace, incomingRetryWs);
      lastRun.ws = mergedWs;

      const models = [...lastRun.usedModels];
      modelChip.textContent = models.length ? `model: ${models.join(' + ')}` : '';

      const remaining = lastRun.failedDocs.size;
      const summaryLine = `${mergedWs.graph.ventures.length} venture(s) · ${mergedWs.graph.products.length} SKU(s) · ${mergedWs.graph.dealRules.length} rule(s) · ${mergedWs.payloadLog.length} payload(s) logged${models.length ? ` · model(s): ${models.join(' + ')}` : ''}`;
      if (remaining === 0) {
        setStage('synthesize', 'ok', summaryLine, `${mergedWs.payloadLog.length} payloads`);
      } else {
        setStage('synthesize', 'err', `${summaryLine} · ${remaining} document(s) still failed`, `${mergedWs.payloadLog.length} payloads`);
      }

      await persistMergedWorkspace(mergedWs, ventureIdMap, lastRun.docCount, lastRun.chunkCount);
      renderFailedDocs();
      toast(`${docName} synthesized and added to workspace`, 'ok');
    } catch (e) {
      if (retryLog.length > 0 && lastRun) {
        lastRun.ws = { ...lastRun.ws, payloadLog: [...lastRun.ws.payloadLog, ...retryLog] };
      }
      const msg = errText(e);
      item.message = msg;
      setStage('synthesize', 'err', `${docName}: ${msg}`);
      renderFailedDocs();
      toast(`Retry failed for ${docName}: ${msg}`, 'warn');
    } finally {
      running = false;
    }
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
      const log: PayloadLogEntry[] = [];
      const legend = buildLegend(anon);
      const orderedSlots = new Map<number, KnowledgeGraph>();
      let totalSlots = 0;
      const usedModels = new Set<string>();
      const failedDocs = new Map<string, FailedDocItem>();
      let gateBlocked = false;

      setStage('synthesize', 'run');
      try {
        const synth = await synthesizeGraph(
          anon.blinded,
          legend,
          (entry) => log.push(entry),
          undefined,
          undefined,
          {
            allowPartial: true,
            onPoolProgress: (progress) => {
              const formatted = formatSynthesizeProgress(progress);
              setStage('synthesize', 'run', formatted.text, formatted.metric);
            },
            onBatchRetry: ({ docNames, attempt, waitMs }) =>
              setStage(
                'synthesize',
                'run',
                `Gemini is busy on ${docNames.join(', ')}, retrying… (attempt ${attempt} of ${SYNTHESIZE_MAX_ATTEMPTS} failed, waiting ~${Math.max(1, Math.round(waitMs / 1000))}s)`,
              ),
          },
        );
        for (const m of synth.usedModels) usedModels.add(m);
        const failureByCall = new Map(synth.failures.map((f) => [f.call - 1, f]));
        for (let b = 0; b < synth.batchGraphs.length; b++) {
          const g = synth.batchGraphs[b];
          if (g) {
            orderedSlots.set(totalSlots++, g);
          } else {
            const fail = failureByCall.get(b);
            if (fail) {
              for (const docName of fail.docNames) {
                const docChunks = fail.chunks.filter((c) => c.docName === docName);
                failedDocs.set(docName, {
                  docName,
                  slotIndex: totalSlots++,
                  chunks: docChunks,
                  message: fail.message,
                });
              }
            }
          }
        }
        graph = mergeOrderedGraphSlots(orderedSlots, totalSlots);
        const models = [...usedModels];
        const baseSummary = `${graph.ventures.length} venture(s) · ${graph.products.length} SKU(s) · ${graph.dealRules.length} rule(s) · ${log.length} payload(s) logged${models.length ? ` · model(s): ${models.join(' + ')}` : ''}`;
        if (failedDocs.size === 0) {
          setStage('synthesize', 'ok', baseSummary, `${log.length} payloads`);
        } else {
          setStage(
            'synthesize',
            'err',
            `${baseSummary} · ${failedDocs.size} document(s) failed (${[...failedDocs.keys()].join(', ')})`,
            `${log.length} payloads`,
          );
        }
        // Honest attribution stays visible in the card header, not just the line.
        modelChip.textContent = models.length ? `model: ${models.join(' + ')}` : '';
      } catch (e) {
        gateBlocked = e instanceof PayloadBlockedError;
        setStage(
          'synthesize',
          'err',
          gateBlocked
            ? `${errText(e)} — workspace kept WITHOUT the cloud graph`
            : `${errText(e)} — workspace kept WITHOUT the cloud graph (${log.length} attempted payload(s) recorded)`,
        );
      }

      const incomingWs: Workspace = {
        id: store.workspace?.id ?? newId(),
        name: texts.map((t) => t.docName).join(' + ').slice(0, 80) || 'Workspace',
        graph,
        tokenMap: anon.tokenMap,
        docs: anon.blinded.map((b) => ({ docName: b.docName, page: b.page, index: b.index, blindedText: b.text })),
        payloadLog: log,
        updatedAt: Date.now(),
      };
      const { workspace: ws, ventureIdMap } = mergeWorkspaces(store.workspace, incomingWs);

      // Stage 5 — local persistence, venture-id remap, summary, and store update
      await persistMergedWorkspace(ws, ventureIdMap, texts.length, chunks.length);

      if (!gateBlocked) {
        lastRun = {
          anon,
          legend,
          docCount: texts.length,
          chunkCount: chunks.length,
          ws,
          orderedSlots,
          totalSlots,
          usedModels,
          failedDocs,
        };
      }
      renderFailedDocs();

      const full = ws.graph.ventures.length > 0 && failedDocs.size === 0;
      toast(
        full
          ? `Workspace ready — open Settings → Privacy to see the exact cloud payload`
          : failedDocs.size > 0
            ? `${failedDocs.size} document(s) failed cloud synthesis — use "Retry this document" below`
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
    failedBox,
    evlog,
    wsSummary,
    statusLine,
  );

  /* ---------- loaded documents grouped by venture ---------- */

  const loadedDocsBody = el('div', { id: 'loadedDocsList' });
  const loadedDocsSection = el(
    'div',
    { class: 'section' },
    el('h2', { class: 'section-title' }, 'Loaded documents'),
    loadedDocsBody,
  );

  async function handleRemoveDocument(docName: string): Promise<void> {
    const ws = store.workspace;
    if (!ws) return;

    // Preview removal without mutating state so the confirm dialog states exact effects.
    const preview = removeDocumentFromWorkspace(ws, docName);
    const willRemoveVentureNames = preview.removedVentureIds.map((vid) => {
      const v = ws.graph.ventures.find((x) => x.venture_id === vid);
      return v ? hydrate(ws.tokenMap, v.venture_token) || v.venture_id : vid;
    });

    const opts = buildRemoveDocumentDialog(
      {
        docName,
        ruleCount: preview.removedRuleCount,
        willRemoveVentureNames,
        hasSyncedCopy: hasSyncedCopy(),
      },
      goSync,
    );

    const confirmed = await openConfirmDialog(opts);
    if (!confirmed) return;

    const latest = store.workspace;
    if (!latest) return;
    const result = removeDocumentFromWorkspace(latest, docName);

    for (const vid of result.removedVentureIds) {
      removeRequestsForVenture(vid);
    }

    if (result.workspace === null) {
      await clearWorkspacesLocal();
      lastRun = null;
      renderFailedDocs();
      store.setWorkspace(null);
    } else {
      await saveWorkspaceLocal(result.workspace);
      if (lastRun) {
        lastRun.ws = result.workspace;
        lastRun.failedDocs.delete(docName);
        renderFailedDocs();
      }
      store.setWorkspace(result.workspace);
    }
    syncRequestsFromStorage();
    toast(`Removed ${docName} from this device.`, 'ok');
  }

  function renderLoadedDocs(): void {
    const ws = store.workspace;
    if (!ws || ws.docs.length === 0) {
      loadedDocsBody.replaceChildren(
        el(
          'p',
          { class: 'hint' },
          'No documents loaded on this device yet. Upload files, paste text, or load the sample workspace below.',
        ),
      );
      return;
    }

    const groups = groupDocumentsByVenture(ws).filter((g) => g.docs.length > 0);
    if (groups.length === 0) {
      loadedDocsBody.replaceChildren(
        el('p', { class: 'hint' }, 'No documents loaded on this device yet.'),
      );
      return;
    }

    const groupNodes = groups.map((group) => {
      const rows = group.docs.map((entry) => {
        const removeBtn = el(
          'button',
          { class: 'btn btn-secondary', type: 'button', 'aria-label': `Remove ${entry.docName}` },
          'Remove',
        );
        removeBtn.addEventListener('click', () => {
          void handleRemoveDocument(entry.docName).catch((e: unknown) => {
            toast(`Could not remove document: ${errText(e)}`, 'error');
          });
        });
        return el(
          'tr',
          {},
          el('td', {}, entry.docName),
          el('td', {}, `${entry.pages} ${entry.pages === 1 ? 'page' : 'pages'}`),
          el('td', {}, `${entry.ruleCount} ${entry.ruleCount === 1 ? 'rule' : 'rules'}`),
          el('td', { class: 'doc-actions-cell' }, removeBtn),
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
            el('th', { scope: 'col' }, 'Document'),
            el('th', { scope: 'col' }, 'Pages'),
            el('th', { scope: 'col' }, 'Extracted rules'),
            el('th', { scope: 'col' }, 'Action'),
          ),
        ),
        el('tbody', {}, ...rows),
      );

      return el(
        'div',
        { class: 'doc-group', 'data-venture-group': group.ventureName },
        el('h3', { class: 'doc-group-title' }, group.ventureName),
        table,
      );
    });

    loadedDocsBody.replaceChildren(...groupNodes);
  }

  store.subscribe(renderLoadedDocs);
  renderLoadedDocs();

  root.replaceChildren(
    loadedDocsSection,
    el('div', { class: 'grid-2' }, filesCard, pasteCard),
    sampleCard,
    progressCard,
  );
}
