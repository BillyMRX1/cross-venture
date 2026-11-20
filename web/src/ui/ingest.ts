// WS-4 Ingest tab: file upload / paste / sample seed → chunker → anonymizer
// → blinded cloud graph synthesis → local save. Stages degrade with visible
// messages when upstream modules throw (expected while stubs are in place).
import { PayloadBlockedError, synthesizeGraph } from '../cloud/graphExtractor';
import { anonymizeChunks } from '../ingest/anonymizer';
import { chunkDocument } from '../ingest/chunker';
import { extractTextFromFile } from '../ingest/textextract';
import { saveWorkspaceLocal } from '../storage/db';
import type { AnonymizeResult, DocChunk, KnowledgeGraph, PayloadLogEntry, Workspace } from '../types';
import { store } from './state';
import { el, errText, newId, toast } from './util';
import { isSpaFallback } from '../ingest/spaFallback';

/**
 * Sample docs (TD-6). Each entry lists candidate paths under /sample-docs/:
 * the canonical names from the task spec first, then the A1/A2/A3/B1 variants
 * actually shipped by WS-1, so the seed button works against either layout.
 */
const SAMPLE_DOCS: Array<{ title: string; paths: string[] }> = [
  { title: 'Atelier Emily partnership agreement', paths: ['atelier-emily-partnership-agreement.md', 'A1-atelier-emily-partnership-agreement.md'] },
  { title: 'Atelier Emily October meeting notes', paths: ['atelier-emily-october-meeting-notes.md', 'A2-october-meeting-notes.md'] },
  { title: 'Atelier Emily cost sheet', paths: ['atelier-emily-cost-sheet.md', 'A3-atelier-emily-cost-sheet.md'] },
  { title: 'Nomad Studio solo terms', paths: ['nomad-studio-solo-terms.md', 'B1-nomad-studio-solo-terms.md'] },
];

const STAGES = [
  { id: 'extract', label: '1 · Extract text', blurb: '.txt / .md / text-layer PDF — local' },
  { id: 'chunk', label: '2 · Chunk documents', blurb: '~600 words, page-tagged — local' },
  { id: 'redact', label: '3 · Symbolic redaction', blurb: 'regex + on-device roles — local; raw text never leaves' },
  { id: 'synthesize', label: '4 · Cloud graph synthesis', blurb: 'IN_CLOUD — blinded tokens only' },
  { id: 'save', label: '5 · Save workspace', blurb: 'IndexedDB local cache' },
] as const;

type StageId = (typeof STAGES)[number]['id'];
type StageState = 'idle' | 'run' | 'ok' | 'err' | 'skip';

const EMPTY_GRAPH: KnowledgeGraph = { ventures: [], partners: [], products: [], dealRules: [] };

export function mountIngest(root: HTMLElement): void {
  let running = false;
  const stageEls = new Map<StageId, { li: HTMLLIElement; note: HTMLElement }>();

  const stageList = el('ul', { class: 'stages' });
  for (const s of STAGES) {
    const note = el('div', { class: 'note-wrap hint', text: s.blurb });
    const li = el('li', { class: 'stage', id: `stage-${s.id}` }, el('span', { class: 'dot' }), el('span', { class: 'label' }, s.label), note);
    stageEls.set(s.id, { li, note });
    stageList.append(li);
  }

  function setStage(id: StageId, state: StageState, text?: string): void {
    const s = stageEls.get(id);
    if (!s) return;
    s.li.className = `stage stage--${state}`;
    if (text !== undefined) s.note.textContent = text;
  }

  function resetStages(): void {
    for (const s of STAGES) {
      const entry = stageEls.get(s.id);
      if (entry) {
        entry.li.className = 'stage';
        entry.note.textContent = s.blurb;
      }
    }
  }

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
        if (stageEls.get('extract')!.li.className === 'stage stage--run') setStage('extract', 'err', 'No text extracted.');
        return;
      }
      const chars = texts.reduce((a, t) => a + t.text.length, 0);
      setStage('extract', 'ok', `${texts.length} document(s) · ${chars.toLocaleString()} chars`);

      // Stage 2 — chunk
      setStage('chunk', 'run');
      let chunks: DocChunk[] = [];
      try {
        for (const t of texts) chunks = chunks.concat(chunkDocument(t.docName, t.text, 600));
        setStage('chunk', 'ok', `${chunks.length} chunk(s) across ${texts.length} doc(s)`);
      } catch (e) {
        setStage('chunk', 'err', errText(e));
        return;
      }

      // Stage 3 — redact (local)
      setStage('redact', 'run');
      let anon: AnonymizeResult;
      try {
        anon = await anonymizeChunks(chunks);
        setStage('redact', 'ok', `${Object.keys(anon.tokenMap).length} typed token(s) · ${anon.blinded.length} blinded chunk(s)`);
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
        const synth = await synthesizeGraph(anon.blinded, buildLegend(anon), (entry) => log.push(entry));
        graph = synth.graph;
        setStage('synthesize', 'ok', `${graph.ventures.length} venture(s) · ${graph.products.length} SKU(s) · ${graph.dealRules.length} rule(s) · ${log.length} payload(s) logged`);
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
        setStage('save', 'ok', 'Saved to local cache (IndexedDB)');
      } catch (e) {
        setStage('save', 'skip', `Not persisted: ${errText(e)}`);
      }

      store.setWorkspace(ws);
      const full = graph.ventures.length > 0;
      toast(
        full
          ? `Workspace ready — open Privacy Inspector to see the exact cloud payload`
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
        setStatus('note--err', 'No sample docs available. Serve them from web/public/sample-docs/ (WS-1) or upload files instead.');
        sampleBtn.disabled = false;
        return;
      }
      if (missing.length > 0) toast(`${sources.length} of ${SAMPLE_DOCS.length} sample docs loaded`, 'warn');
      await runPipeline(sources);
      sampleBtn.disabled = false;
    })();
  });

  /* ---------- layout ---------- */

  const filesCard = el(
    'div',
    { class: 'card' },
    el('h2', {}, 'Upload files'),
    el('p', {}, 'Contracts, meeting notes, cost sheets — .txt, .md or text-layer .pdf (TD-3). Extraction is fully local.'),
    el('div', { class: 'field' }, el('label', { for: 'fileInput' }, 'Documents'), fileInput),
  );

  const pasteCard = el(
    'div',
    { class: 'card' },
    el('h2', {}, 'Paste text'),
    el('p', {}, 'Paste any agreement or note; it joins the same pipeline.'),
    el('div', { class: 'field' }, el('label', { for: 'pasteText' }, 'Text'), pasteArea),
    el('div', { class: 'field' }, el('label', { for: 'pasteName' }, 'Document name'), pasteName),
    pasteBtn,
  );

  const sampleCard = el(
    'div',
    { class: 'card' },
    el('h2', {}, 'Sample workspace (TD-6)'),
    el('p', {}, 'Scenario A “Atelier Emily” (co-owned, capped discounts) + Scenario B “Nomad Studio” (solo). Fetches the four sample docs from /sample-docs/.'),
    sampleBtn,
  );

  const progressCard = el(
    'div',
    { class: 'card' },
    el('h2', {}, 'Pipeline'),
    el('p', {}, 'Local stages run first; only blinded tokens reach the cloud stage. Errors degrade visibly instead of crashing.'),
    stageList,
    el('div', { class: 'card-toolbar' }, statusLine),
  );

  root.replaceChildren(
    el('div', { class: 'grid-2' }, filesCard, pasteCard),
    sampleCard,
    progressCard,
  );
}
