// Integration test: load sample workspace through mountIngest, fail one document
// during cloud synthesis, click "Retry this document" (mocked), and assert that
// both the initial run and the retry go through mergeWorkspaces + venture-id remap
// so there is always exactly one venture per company.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnonymizedChunk,
  KnowledgeGraph,
  PayloadLogEntry,
  TokenMap,
  Workspace,
} from '../types';
import type { SynthesizeResult } from '../cloud/graphExtractor';

/* ---------- mocks ---------- */

const savedWorkspaces: Workspace[] = [];

vi.mock('../storage/db', () => ({
  saveWorkspaceLocal: vi.fn(async (ws: Workspace) => {
    savedWorkspaces.push(ws);
  }),
  clearWorkspacesLocal: vi.fn(async () => {}),
}));

vi.mock('../hybrid', () => ({
  SYNTHESIZE_MAX_ATTEMPTS: 3,
  onDeviceStatus: vi.fn(async () => ({ available: false, detail: 'test' })),
  generate: vi.fn(async () => {
    throw new Error('on-device unavailable in test');
  }),
}));

const synthesizeMock = vi.fn<
  (
    blinded: AnonymizedChunk[],
    tokenLegend: string,
    onPayload?: (entry: PayloadLogEntry) => void,
  ) => Promise<SynthesizeResult>
>();

const retryDocMock = vi.fn<
  (
    docChunks: AnonymizedChunk[],
    tokenLegend: string,
    onPayload?: (entry: PayloadLogEntry) => void,
    onRetryNotice?: (attempt: number, waitMs: number, kind: string) => void,
    onCallProgress?: unknown,
    options?: { extraKnownValues?: TokenMap },
  ) => Promise<SynthesizeResult>
>();

vi.mock('../cloud/graphExtractor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloud/graphExtractor')>();
  return {
    ...actual,
    synthesizeGraph: (...args: Parameters<typeof synthesizeMock>) => synthesizeMock(...args),
    retrySynthesizeDocument: (...args: Parameters<typeof retryDocMock>) => retryDocMock(...args),
  };
});

import { mountIngest } from './ingest';
import { store } from './state';
import { hydrate } from './util';
import { uniqueVentureOptions } from './workspaceCue';

/* ---------- minimal DOM harness ---------- */

class FakeNode {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  private _text = '';

  get textContent(): string {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes = [];
    this._text = String(v ?? '');
  }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attrs = new Map<string, string>();
  value = '';
  disabled = false;
  files: File[] | null = null;
  private listeners = new Map<string, Array<() => void>>();

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }

  append(...items: Array<FakeNode | string>): void {
    for (const item of items) {
      const node = typeof item === 'string' ? new FakeText(item) : item;
      if (node.parentNode) node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...items: Array<FakeNode | string>): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...items);
  }

  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  click(): void {
    if (this.disabled) return;
    for (const fn of [...(this.listeners.get('click') ?? [])]) fn();
  }

  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (pred(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.findAll((el) => el.id === id);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.findAll((el) => el.className.split(/\s+/).includes(cls));
    }
    return this.findAll((el) => el.tagName === sel.toUpperCase());
  }
}

/* ---------- helpers ---------- */

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(here, '..', '..', 'public', 'sample-docs');

function findTokenInChunks(chunks: AnonymizedChunk[], type: string, needle: string): string {
  const lower = needle.toLowerCase();
  for (const c of chunks) {
    for (const d of c.detected) {
      if (d.type === type && d.text.trim().toLowerCase() === lower) return d.token;
    }
  }
  for (const c of chunks) {
    for (const d of c.detected) {
      if (d.type === type && d.text.trim().toLowerCase().includes(lower)) return d.token;
    }
  }
  return '';
}

function findTokenInMap(tokenMap: TokenMap, prefix: string, needle: string): string {
  const lower = needle.toLowerCase();
  for (const [tok, val] of Object.entries(tokenMap)) {
    if (tok.startsWith(`[${prefix}_`) && val.trim().toLowerCase() === lower) return tok;
  }
  for (const [tok, val] of Object.entries(tokenMap)) {
    if (tok.startsWith(`[${prefix}_`) && val.trim().toLowerCase().includes(lower)) return tok;
  }
  return '';
}

async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ingest integration: sample workspace run + retry failed document keeps one venture per company', () => {
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    savedWorkspaces.length = 0;
    synthesizeMock.mockReset();
    retryDocMock.mockReset();
    store.setWorkspace(null);
    store.setVault(null, null);

    const mem: Record<string, string> = {};
    const body = new FakeElement('body');
    const root = new FakeElement('div');
    root.id = 'root-ingest';
    body.append(root);

    const fakeDoc = {
      body,
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (t: string) => new FakeText(t),
      getElementById: (id: string) => body.querySelector(`#${id}`),
      querySelector: (sel: string) => body.querySelector(sel),
      querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    };
    const fakeStorage = {
      getItem: (k: string): string | null => (k in mem ? mem[k] : null),
      setItem: (k: string, v: string): void => {
        mem[k] = String(v);
      },
      removeItem: (k: string): void => {
        delete mem[k];
      },
    };
    const fakeWin = {
      localStorage: fakeStorage,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };

    (globalThis as Record<string, unknown>).document = fakeDoc;
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).localStorage = fakeStorage;
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      const name = url.replace(/^\/sample-docs\//, '');
      const fullPath = join(SAMPLE_DIR, name);
      if (!existsSync(fullPath)) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => 'text/plain' },
          text: async () => 'Not found',
        };
      }
      const bodyText = readFileSync(fullPath, 'utf8');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/markdown' },
        text: async () => bodyText,
      };
    });
  });

  afterEach(() => {
    store.setWorkspace(null);
    (globalThis as Record<string, unknown>).document = origDocument;
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
    (globalThis as Record<string, unknown>).fetch = origFetch;
    vi.clearAllMocks();
  });

  it('loads sample workspace, fails one document, retries it, and preserves exactly one venture per company', async () => {
    const root = document.getElementById('root-ingest') as unknown as FakeElement;
    mountIngest(root as unknown as HTMLElement);

    const FAILED_DOC = 'A2-october-meeting-notes.md';
    let synthRun = 0;

    synthesizeMock.mockImplementation(async (blinded, _legend, onPayload) => {
      synthRun += 1;
      const byDoc = new Map<string, AnonymizedChunk[]>();
      for (const c of blinded) {
        const list = byDoc.get(c.docName) ?? [];
        list.push(c);
        byDoc.set(c.docName, list);
      }

      const aeToken = findTokenInChunks(blinded, 'VENTURE', 'Atelier Emily');
      const nsToken = findTokenInChunks(blinded, 'VENTURE', 'Nomad Studio');
      const floorToken = findTokenInChunks(blinded, 'MARGIN_FLOOR', '55%');
      const capToken = findTokenInChunks(blinded, 'DISCOUNT_CAP', '10%');

      const docEntries = [...byDoc.entries()];
      const batchGraphs: Array<KnowledgeGraph | null> = [];
      const failures: SynthesizeResult['failures'] = [];
      const payloadLog: PayloadLogEntry[] = [];

      docEntries.forEach(([docName, chunks], idx) => {
        const entry: PayloadLogEntry = {
          docName,
          page: chunks[0]?.page ?? 1,
          localText: `local:${docName}`,
          cloudText: `cloud:${docName}`,
          sentAt: Date.now(),
          status: docName === FAILED_DOC ? 'attempted' : 'responded',
        };
        payloadLog.push(entry);
        onPayload?.(entry);

        if (docName === FAILED_DOC) {
          batchGraphs.push(null);
          failures.push({
            call: idx + 1,
            docNames: [docName],
            chunks,
            error: new Error('503 Gemini busy'),
            message: '503 Gemini busy',
          });
          return;
        }

        const isNomad = docName.startsWith('B1');
        const vid = isNomad ? `v_ns_run${synthRun}_${idx}` : `v_ae_run${synthRun}_${idx}`;
        batchGraphs.push({
          ventures: [
            {
              venture_id: vid,
              venture_token: isNomad ? nsToken : aeToken,
              min_margin_pct_token: floorToken,
            },
          ],
          partners: [],
          products: [],
          dealRules: isNomad
            ? []
            : [
                {
                  rule_id: `r_${docName}_run${synthRun}`,
                  venture_id: vid,
                  max_discount_pct_token: capToken,
                  min_qty_condition: '30 units',
                  requires_partner_approval: true,
                  source_doc_name: docName,
                  page_or_section: '§4.3',
                  verbatim_blinded_excerpt: `cap ${capToken}`,
                },
              ],
        });
      });

      const merged: KnowledgeGraph = { ventures: [], partners: [], products: [], dealRules: [] };
      for (const g of batchGraphs) {
        if (!g) continue;
        merged.ventures.push(...g.ventures);
        merged.partners.push(...g.partners);
        merged.products.push(...g.products);
        merged.dealRules.push(...g.dealRules);
      }

      return {
        graph: merged,
        payloadLog,
        usedModels: ['gemini-2.5-flash'],
        failures,
        batchGraphs,
      };
    });

    retryDocMock.mockImplementation(async (docChunks, _legend, onPayload, _onRetry, _onProg, options) => {
      const tm = options?.extraKnownValues ?? {};
      const aeToken =
        findTokenInChunks(docChunks, 'VENTURE', 'Atelier Emily') ||
        findTokenInMap(tm, 'VENTURE', 'Atelier Emily');
      const floorToken =
        findTokenInChunks(docChunks, 'MARGIN_FLOOR', '55%') ||
        findTokenInMap(tm, 'MARGIN_FLOOR', '55%');
      const capToken =
        findTokenInChunks(docChunks, 'DISCOUNT_CAP', '10%') ||
        findTokenInMap(tm, 'DISCOUNT_CAP', '10%');

      const docName = docChunks[0]?.docName ?? FAILED_DOC;
      const entry: PayloadLogEntry = {
        docName,
        page: docChunks[0]?.page ?? 1,
        localText: `local-retry:${docName}`,
        cloudText: `cloud-retry:${docName}`,
        sentAt: Date.now(),
        status: 'responded',
      };
      onPayload?.(entry);

      // Intentionally return a brand-new venture_id for Atelier Emily so we prove
      // retryOneDocument merges it into the existing Atelier Emily venture instead
      // of creating a duplicate venture.
      const graph: KnowledgeGraph = {
        ventures: [
          {
            venture_id: 'v_ae_retry_fresh',
            venture_token: aeToken,
            min_margin_pct_token: floorToken,
          },
        ],
        partners: [],
        products: [],
        dealRules: [
          {
            rule_id: 'r_a2_retried',
            venture_id: 'v_ae_retry_fresh',
            max_discount_pct_token: capToken,
            min_qty_condition: '50 units',
            requires_partner_approval: true,
            source_doc_name: docName,
            page_or_section: 'Oct Notes p.1',
            verbatim_blinded_excerpt: `retry cap ${capToken}`,
          },
        ],
      };

      return {
        graph,
        payloadLog: [entry],
        usedModels: ['gemini-2.5-flash'],
        failures: [],
        batchGraphs: [graph],
      };
    });

    // 1. Click "Load sample workspace"
    const sampleBtn = root.findAll((el) => el.tagName === 'BUTTON' && el.textContent === 'Load sample workspace')[0];
    expect(sampleBtn).toBeDefined();
    sampleBtn.click();

    await flushUntil(() => store.workspace !== null && root.findAll((el) => el.textContent === 'Retry this document').length === 1);

    // After initial partial run: 2 ventures (Atelier Emily + Nomad Studio), 1 failed doc button
    const wsAfterInitial = store.workspace!;
    expect(wsAfterInitial).not.toBeNull();
    expect(wsAfterInitial.graph.ventures).toHaveLength(2);
    expect(
      wsAfterInitial.graph.ventures.map((v) => hydrate(wsAfterInitial.tokenMap, v.venture_token)).sort(),
    ).toEqual(['Atelier Emily', 'Nomad Studio']);

    const retryBtn = root.findAll((el) => el.tagName === 'BUTTON' && el.textContent === 'Retry this document')[0];
    expect(retryBtn).toBeDefined();

    // 2. Click "Retry this document"
    retryBtn.click();

    await flushUntil(() => retryDocMock.mock.calls.length === 1 && savedWorkspaces.length >= 2);

    // Retry only sent the failed document
    expect(retryDocMock).toHaveBeenCalledTimes(1);
    const retriedDocNames = new Set(retryDocMock.mock.calls[0][0].map((c) => c.docName));
    expect([...retriedDocNames]).toEqual([FAILED_DOC]);

    // 3. Assert ONE venture per company after retry
    const wsAfterRetry = store.workspace!;
    expect(wsAfterRetry.graph.ventures).toHaveLength(2);
    const ventureNames = wsAfterRetry.graph.ventures
      .map((v) => hydrate(wsAfterRetry.tokenMap, v.venture_token))
      .sort();
    expect(ventureNames).toEqual(['Atelier Emily', 'Nomad Studio']);
    expect(uniqueVentureOptions(wsAfterRetry).map((o) => o.label).sort()).toEqual([
      'Atelier Emily',
      'Nomad Studio',
    ]);

    // Retried rule must be attached to the single canonical Atelier Emily venture_id
    const atelierVenture = wsAfterRetry.graph.ventures.find(
      (v) => hydrate(wsAfterRetry.tokenMap, v.venture_token) === 'Atelier Emily',
    )!;
    const retriedRule = wsAfterRetry.graph.dealRules.find((r) => r.source_doc_name === FAILED_DOC);
    expect(retriedRule).toBeDefined();
    expect(retriedRule!.venture_id).toBe(atelierVenture.venture_id);

    // Every unique sample document is present once, and the retry banner is hidden
    const uniqueDocs = new Set(wsAfterRetry.docs.map((d) => d.docName));
    expect(uniqueDocs.size).toBe(4);
    const failedBanner = root.querySelector('.banner--fail');
    expect(failedBanner?.hidden).toBe(true);
  });
});
