// Product tour tests (Node environment with a minimal DOM harness over the real
// index.html and real UI mounters). Covers: first-visit auto-start, no
// auto-start on second visit, replay from Settings & top bar "?", skip/Esc
// persistence, Finish action, copy length, and that every step's target
// selector resolves to a visible element after navigating to its page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountIngest } from './ingest';
import { mountInspector } from './inspector';
import { mountRequests } from './requests';
import { mountRules } from './rules';
import { lsGet, lsSet, registerTabSetter } from './state';
import { mountSync } from './sync';
import { initTour, TOUR_SEEN_KEY, TOUR_STEPS } from './tour';

/* ---------- minimal DOM shim (supports the real index.html + ui/*.ts) ---------- */

class FakeEvent {
  type: string;
  key?: string;
  defaultPrevented = false;
  target: unknown = null;
  constructor(type: string, init: { key?: string } = {}) {
    this.type = type;
    this.key = init.key;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    /* noop */
  }
}

class FakeClassList {
  private set = new Set<string>();
  constructor(private host: FakeElement) {}
  syncFrom(val: string): void {
    this.set = new Set(val.split(/\s+/).filter(Boolean));
  }
  toString(): string {
    return [...this.set].join(' ');
  }
  add(...names: string[]): void {
    for (const n of names) if (n) this.set.add(n);
    this.host._syncClassAttr();
  }
  remove(...names: string[]): void {
    for (const n of names) this.set.delete(n);
    this.host._syncClassAttr();
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force !== undefined ? force : !this.set.has(name);
    if (on) this.set.add(name);
    else this.set.delete(name);
    this.host._syncClassAttr();
    return on;
  }
  contains(name: string): boolean {
    return this.set.has(name);
  }
}

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
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
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
  classList: FakeClassList;
  style: Record<string, string> = {};
  value = '';
  disabled = false;
  selected = false;
  private listeners = new Map<string, Array<(e: FakeEvent) => void>>();

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList(this);
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
    this.classList.syncFrom(v);
  }

  _syncClassAttr(): void {
    const s = this.classList.toString();
    if (s) this.attrs.set('class', s);
    else this.attrs.delete('class');
  }

  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }

  get dataset(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of this.attrs.entries()) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        out[camel] = v;
      }
    }
    return out;
  }

  setAttribute(k: string, v: string): void {
    if (k === 'class') {
      this.className = v;
      return;
    }
    this.attrs.set(k, String(v));
    if (k === 'value') this.value = String(v);
    if (k === 'disabled') this.disabled = true;
  }

  getAttribute(k: string): string | null {
    return this.attrs.has(k) ? (this.attrs.get(k) ?? '') : null;
  }

  removeAttribute(k: string): void {
    this.attrs.delete(k);
    if (k === 'class') this.classList.syncFrom('');
    if (k === 'disabled') this.disabled = false;
  }

  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
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

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  dispatchEvent(ev: FakeEvent): boolean {
    ev.target = this;
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click'));
  }

  focus(): void {
    /* noop */
  }

  scrollIntoView(): void {
    /* noop */
  }

  getBoundingClientRect(): {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    return { top: 80, left: 40, right: 240, bottom: 120, width: 200, height: 40, x: 40, y: 80 };
  }

  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector);
  }
}

/* ---------- minimal CSS selector matcher (supports #, ., tag, [attr], >, space, :first-child) ---------- */

function matchSimple(el: FakeElement, simple: string): boolean {
  let rest = simple.trim();
  if (!rest) return false;
  if (rest.endsWith(':first-child')) {
    rest = rest.slice(0, -':first-child'.length);
    const parent = el.parentNode;
    if (!parent || parent.children[0] !== el) return false;
  }
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g;
  for (const m of rest.matchAll(attrRe)) {
    const [, name, expected] = m;
    if (!el.hasAttribute(name)) return false;
    if (expected !== undefined && el.getAttribute(name) !== expected) return false;
  }
  rest = rest.replace(attrRe, '');
  const parts = rest.match(/([#.][^#.]+|[^#.]+)/g) ?? [];
  for (const p of parts) {
    if (p.startsWith('#')) {
      if (el.id !== p.slice(1)) return false;
    } else if (p.startsWith('.')) {
      if (!el.classList.contains(p.slice(1))) return false;
    } else if (p !== '*') {
      if (el.tagName !== p.toUpperCase()) return false;
    }
  }
  return true;
}

function matchChain(el: FakeElement, selector: string): boolean {
  const tokens: Array<{ rel: 'desc' | 'child'; part: string }> = [];
  const raw = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  let nextRel: 'desc' | 'child' = 'desc';
  for (const tok of raw) {
    if (tok === '>') {
      nextRel = 'child';
      continue;
    }
    tokens.push({ rel: nextRel, part: tok });
    nextRel = 'desc';
  }
  if (tokens.length === 0) return false;

  function step(node: FakeElement, idx: number): boolean {
    if (!matchSimple(node, tokens[idx].part)) return false;
    if (idx === 0) return true;
    const rel = tokens[idx].rel;
    if (rel === 'child') {
      return node.parentNode ? step(node.parentNode, idx - 1) : false;
    }
    let cur = node.parentNode;
    while (cur) {
      if (step(cur, idx - 1)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  return step(el, tokens.length - 1);
}

function queryAll(root: FakeElement, selector: string): FakeElement[] {
  const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
  const out: FakeElement[] = [];
  function walk(node: FakeElement): void {
    for (const child of node.children) {
      if (selectors.some((s) => matchChain(child, s))) out.push(child);
      walk(child);
    }
  }
  walk(root);
  return out;
}

/* ---------- minimal HTML parser for web/index.html ---------- */

const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function parseHtmlIntoBody(html: string, body: FakeElement): void {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const src = (bodyMatch ? bodyMatch[1] : html).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const stack: FakeElement[] = [body];
  const tokenRe = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of src.matchAll(tokenRe)) {
    const [, closeTag, openTag, attrStr, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (closeTag) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === closeTag.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
    } else if (openTag) {
      const el = new FakeElement(openTag);
      const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
      for (const am of (attrStr ?? '').matchAll(attrRe)) {
        const [, k, v1, v2] = am;
        el.setAttribute(k, v1 ?? v2 ?? '');
      }
      top.append(el);
      if (!selfClose && !VOID_TAGS.has(openTag.toLowerCase())) stack.push(el);
    } else if (text && text.trim()) {
      top.append(new FakeText(text));
    }
  }
}

/* ---------- test environment bootstrap ---------- */

const INDEX_HTML = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

interface TestEnv {
  mem: Record<string, string>;
  doc: FakeElement;
  windowListeners: Map<string, Array<(e: FakeEvent) => void>>;
  docListeners: Map<string, Array<(e: FakeEvent) => void>>;
  pressKey: (key: string) => void;
}

function setupAppDom(initialStorage: Record<string, string> = {}): TestEnv {
  const mem: Record<string, string> = { ...initialStorage };
  const docEl = new FakeElement('html');
  const body = new FakeElement('body');
  docEl.append(body);
  parseHtmlIntoBody(INDEX_HTML, body);

  const windowListeners = new Map<string, Array<(e: FakeEvent) => void>>();
  const docListeners = new Map<string, Array<(e: FakeEvent) => void>>();

  const fakeDoc = {
    documentElement: docEl,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (t: string) => new FakeText(t),
    getElementById: (id: string) => docEl.querySelector(`#${id}`),
    querySelector: (sel: string) => docEl.querySelector(sel),
    querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
    addEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      const arr = docListeners.get(type) ?? [];
      arr.push(fn);
      docListeners.set(type, arr);
    },
    removeEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      const arr = docListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };

  const fakeWin = {
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: {
      getItem: (k: string): string | null => (k in mem ? mem[k] : null),
      setItem: (k: string, v: string): void => {
        mem[k] = String(v);
      },
      removeItem: (k: string): void => {
        delete mem[k];
      },
    },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      const arr = windowListeners.get(type) ?? [];
      arr.push(fn);
      windowListeners.set(type, arr);
    },
    removeEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      const arr = windowListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };

  (globalThis as Record<string, unknown>).document = fakeDoc;
  (globalThis as Record<string, unknown>).window = fakeWin;
  (globalThis as Record<string, unknown>).localStorage = fakeWin.localStorage;

  // Mount real pages & nav exactly like main.ts
  const pages = ['requests', 'rules', 'documents', 'settings'] as const;
  const pageEls = pages.map((p) => fakeDoc.getElementById(`page-${p}`)!).filter(Boolean);
  const navBtns = pages.map((p) => fakeDoc.querySelector(`.nav-link[data-page="${p}"]`)!).filter(Boolean);

  registerTabSetter((id: string) => {
    const target = (pages as readonly string[]).includes(id) ? id : 'requests';
    for (const b of navBtns) b.classList.toggle('is-selected', b.dataset.page === target);
    for (const p of pageEls) p.hidden = p.id !== `page-${target}`;
  });

  mountRequests(fakeDoc.getElementById('root-simulator') as unknown as HTMLElement);
  mountRules(fakeDoc.getElementById('root-rules') as unknown as HTMLElement);
  mountIngest(fakeDoc.getElementById('root-ingest') as unknown as HTMLElement);
  mountSync(fakeDoc.getElementById('root-sync') as unknown as HTMLElement);
  mountInspector(fakeDoc.getElementById('root-inspector') as unknown as HTMLElement);

  return {
    mem,
    doc: docEl,
    windowListeners,
    docListeners,
    pressKey: (key: string) => {
      const ev = new FakeEvent('keydown', { key });
      for (const fn of [...(docListeners.get('keydown') ?? [])]) fn(ev);
      for (const fn of [...(windowListeners.get('keydown') ?? [])]) fn(ev);
    },
  };
}

function hasHiddenAncestor(el: FakeElement | null): boolean {
  let cur = el;
  while (cur) {
    if (cur.hidden) return true;
    cur = cur.parentNode;
  }
  return false;
}

describe('product tour', () => {
  let ctrl: ReturnType<typeof initTour> | null = null;

  beforeEach(() => {
    ctrl = null;
  });

  afterEach(() => {
    ctrl?.destroy();
    ctrl = null;
    vi.restoreAllMocks();
  });

  it('first-visit auto start: launches on step 1 with step counter and does not pre-set seen flag', () => {
    const env = setupAppDom();
    ctrl = initTour();

    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.currentIndex()).toBe(0);
    expect(lsGet(TOUR_SEEN_KEY)).toBeNull();

    const pop = env.doc.querySelector('.tour-popover');
    expect(pop).not.toBeNull();
    expect(pop!.textContent).toContain(`1 of ${TOUR_STEPS.length}`);
    expect(pop!.textContent).toContain(TOUR_STEPS[0].title);
  });

  it('no auto start on second visit when seen flag is already stored', () => {
    const env = setupAppDom({ [TOUR_SEEN_KEY]: 'done' });
    ctrl = initTour();

    expect(ctrl.isActive()).toBe(false);
    expect(env.doc.querySelector('.tour-popover')).toBeNull();
  });

  it('replay from Settings ("Take the tour") and top bar ("?") restarts the tour', () => {
    const env = setupAppDom({ [TOUR_SEEN_KEY]: 'done' });
    ctrl = initTour();
    expect(ctrl.isActive()).toBe(false);

    // Settings entry
    const settingsBtn = env.doc.querySelector('#page-settings #tourReplayBtn');
    expect(settingsBtn, 'Settings must expose a Take the tour button').not.toBeNull();
    expect(settingsBtn!.textContent.toLowerCase()).toContain('take the tour');
    settingsBtn!.click();
    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.currentIndex()).toBe(0);

    // Dismiss and replay via top-bar "?"
    ctrl.skip();
    expect(ctrl.isActive()).toBe(false);
    const helpBtn = env.doc.querySelector('.topbar-right #tourHelpBtn');
    expect(helpBtn, 'Top bar must expose a ? help button').not.toBeNull();
    expect(helpBtn!.textContent.trim()).toBe('?');
    helpBtn!.click();
    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.currentIndex()).toBe(0);
  });

  it('skip stores the flag (via Skip button and via Escape key)', () => {
    const env = setupAppDom();
    ctrl = initTour();
    expect(lsGet(TOUR_SEEN_KEY)).toBeNull();

    const skipBtn = env.doc.querySelector('.tour-skip');
    expect(skipBtn).not.toBeNull();
    skipBtn!.click();

    expect(ctrl.isActive()).toBe(false);
    expect(lsGet(TOUR_SEEN_KEY)).toBeTruthy();
    expect(env.doc.querySelector('.tour-popover')).toBeNull();

    // Clear flag, replay, and verify Esc also closes and stores the flag
    delete env.mem[TOUR_SEEN_KEY];
    ctrl.start(2);
    expect(ctrl.isActive()).toBe(true);
    env.pressKey('Escape');
    expect(ctrl.isActive()).toBe(false);
    expect(lsGet(TOUR_SEEN_KEY)).toBeTruthy();
  });

  it('every step target selector exists and is visible after navigation, with Next/Back and Finish sample action', () => {
    const env = setupAppDom();
    ctrl = initTour();
    expect(TOUR_STEPS.length).toBe(8);

    for (let i = 0; i < TOUR_STEPS.length; i++) {
      const step = TOUR_STEPS[i];
      expect(ctrl.currentIndex()).toBe(i);
      const pop = env.doc.querySelector('.tour-popover');
      expect(pop).not.toBeNull();
      expect(pop!.textContent).toContain(`${i + 1} of ${TOUR_STEPS.length}`);

      const page = env.doc.querySelector(`#page-${step.page}`);
      expect(page, `page #page-${step.page} must exist`).not.toBeNull();
      expect(page!.hidden, `page #page-${step.page} must be visible on step ${i + 1}`).toBe(false);

      const target = env.doc.querySelector(step.target);
      expect(target, `step ${i + 1} target "${step.target}" must exist after navigation`).not.toBeNull();
      expect(hasHiddenAncestor(target), `step ${i + 1} target "${step.target}" must not be hidden`).toBe(false);

      if (i < TOUR_STEPS.length - 1) {
        const nextBtn = env.doc.querySelector('.tour-next');
        expect(nextBtn).not.toBeNull();
        nextBtn!.click();
      }
    }

    // Back from step 8 to step 7 and forward again
    env.doc.querySelector('.tour-back')!.click();
    expect(ctrl.currentIndex()).toBe(TOUR_STEPS.length - 2);
    env.doc.querySelector('.tour-next')!.click();
    expect(ctrl.currentIndex()).toBe(TOUR_STEPS.length - 1);

    // Final step primary button is "Load sample workspace" and triggers sample loader on Documents
    const finishBtn = env.doc.querySelector('.tour-next');
    expect(finishBtn!.textContent.trim()).toBe('Load sample workspace');

    const sampleBtn = env.doc.querySelector('#root-ingest > .section > .btn-primary');
    expect(sampleBtn).not.toBeNull();
    let sampleClicked = false;
    sampleBtn!.addEventListener('click', () => {
      sampleClicked = true;
    });

    finishBtn!.click();
    expect(ctrl.isActive()).toBe(false);
    expect(lsGet(TOUR_SEEN_KEY)).toBeTruthy();
    expect(env.doc.querySelector('#page-documents')!.hidden).toBe(false);
    expect(sampleClicked).toBe(true);
  });

  it('keeps every step concise (<= 25 words) and persists seen flag across restarts', () => {
    for (const step of TOUR_STEPS) {
      const words = step.body.trim().split(/\s+/).filter(Boolean);
      expect(words.length, `step "${step.id}" body too long (${words.length} words)`).toBeLessThanOrEqual(25);
    }
    const env = setupAppDom();
    lsSet(TOUR_SEEN_KEY, 'skipped');
    expect(env.mem[TOUR_SEEN_KEY]).toBe('skipped');
  });
});
