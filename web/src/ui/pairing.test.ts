import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportVaultKey, generateVaultKey, importVaultKey } from '../crypto/vault';
import {
  PAIRING_AUTO_HIDE_MS,
  PAIRING_STEPS,
  PAIRING_WARNING_COPY,
  buildQrMatrix,
  decodePairingPayload,
  encodePairingPayload,
  mountPairingPanel,
  renderQrSvgString,
} from './pairing';
import { store } from './state';
import { mountSync } from './sync';

/* ---------- minimal DOM shim for Node vitest environment ---------- */

type Listener = (ev?: unknown) => void;

class FakeElement {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  attrs = new Map<string, string>();
  children: Array<FakeElement | FakeText> = [];
  parentNode: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {};
  disabled = false;
  value = '';
  private _hidden = false;
  private _textContent = '';

  constructor(tag: string, ns: string | null = null) {
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
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
    return this._hidden;
  }
  set hidden(v: boolean) {
    const prev = this._hidden;
    this._hidden = Boolean(v);
    if (this._hidden) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
    if (prev !== this._hidden) {
      notifyMutationObservers(this, 'hidden');
    }
  }

  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this._textContent = v;
  }

  setAttribute(name: string, value: string): void {
    if (name === 'hidden') {
      this.hidden = true;
      return;
    }
    if (name === 'style') {
      for (const decl of value.split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const prop = decl.slice(0, idx).trim();
        const val = decl.slice(idx + 1).trim();
        if (prop) this.style[prop] = val;
      }
    }
    this.attrs.set(name, value);
    notifyMutationObservers(this, name);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }

  removeAttribute(name: string): void {
    if (name === 'hidden') {
      this.hidden = false;
      return;
    }
    this.attrs.delete(name);
    notifyMutationObservers(this, name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const n of nodes) {
      const child = typeof n === 'string' ? new FakeText(n) : n;
      if (child instanceof FakeElement) child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const c of this.children) {
      if (c instanceof FakeElement) c.parentNode = null;
    }
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  click(): void {
    if (this.disabled) return;
    for (const fn of [...(this.listeners.get('click') ?? [])]) {
      fn({ target: this, currentTarget: this, preventDefault() {} });
    }
  }

  matchesSelector(sel: string): boolean {
    const parts = sel.split(',').map((s) => s.trim());
    return parts.some((p) => {
      if (p.startsWith('#')) return this.id === p.slice(1);
      if (p.startsWith('.')) return this.className.split(/\s+/).includes(p.slice(1));
      return this.tagName.toLowerCase() === p.toLowerCase();
    });
  }

  closest(sel: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matchesSelector(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(sel: string): FakeElement | null {
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        if (c.matchesSelector(sel)) return c;
        const found = c.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const c of node.children) {
        if (c instanceof FakeElement) {
          if (c.matchesSelector(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

class FakeText {
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
}

interface ActiveObserver {
  target: FakeElement;
  cb: (records: Array<{ attributeName: string | null }>) => void;
  filter?: string[];
}

const activeObservers = new Set<ActiveObserver>();

function notifyMutationObservers(target: FakeElement, attrName: string): void {
  for (const obs of [...activeObservers]) {
    if (obs.target !== target) continue;
    if (obs.filter && !obs.filter.includes(attrName)) continue;
    obs.cb([{ attributeName: attrName }]);
  }
}

class FakeMutationObserver {
  private cb: (records: Array<{ attributeName: string | null }>) => void;
  private entries: ActiveObserver[] = [];

  constructor(cb: (records: Array<{ attributeName: string | null }>) => void) {
    this.cb = cb;
  }

  observe(target: FakeElement, opts?: { attributeFilter?: string[] }): void {
    const entry: ActiveObserver = { target, cb: this.cb, filter: opts?.attributeFilter };
    this.entries.push(entry);
    activeObservers.add(entry);
  }

  disconnect(): void {
    for (const entry of this.entries) activeObservers.delete(entry);
    this.entries = [];
  }
}

function installDomShim(): {
  docListeners: Map<string, Listener[]>;
  setDocumentHidden: (hidden: boolean) => void;
} {
  const docListeners = new Map<string, Listener[]>();
  let docHidden = false;
  const fakeDoc = {
    get hidden(): boolean {
      return docHidden;
    },
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
    createTextNode: (text: string) => new FakeText(text),
    addEventListener: (type: string, fn: Listener) => {
      const arr = docListeners.get(type) ?? [];
      arr.push(fn);
      docListeners.set(type, arr);
    },
    removeEventListener: (type: string, fn: Listener) => {
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDoc;
  (globalThis as Record<string, unknown>).MutationObserver = FakeMutationObserver;
  return {
    docListeners,
    setDocumentHidden(hidden: boolean) {
      docHidden = hidden;
      for (const fn of [...(docListeners.get('visibilitychange') ?? [])]) fn({});
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/* ---------- payload encode / decode tests ---------- */

describe('pairing payload encode / decode', () => {
  it('round-trips wsId and real WebCrypto exported vault key in backward-compatible base64url JSON format', async () => {
    const key = await generateVaultKey();
    const exported = await exportVaultKey(key);
    const wsId = 'ws-2026-atelier_01';

    const encoded = encodePairingPayload({ wsId, key: exported });

    // Backward-compatible unpadded base64url charset (matches Android Pairing.kt)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const rawJson = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(JSON.parse(rawJson)).toEqual({ wsId, key: exported });

    const decoded = decodePairingPayload(encoded);
    expect(decoded).toEqual({ wsId, key: exported });
  });

  it('decodes legacy pasted strings with surrounding whitespace', () => {
    const legacy = Buffer.from(
      JSON.stringify({ wsId: 'legacy_ws-42', key: 'eyJrdHkiOiJvY3QiLCJrIjoiQUFBIn0' }),
      'utf8',
    ).toString('base64url');
    expect(decodePairingPayload(`  \n${legacy}\t `)).toEqual({
      wsId: 'legacy_ws-42',
      key: 'eyJrdHkiOiJvY3QiLCJrIjoiQUFBIn0',
    });
  });

  it('rejects empty, non-base64url, non-object, and incomplete payloads', () => {
    expect(() => decodePairingPayload('')).toThrow();
    expect(() => decodePairingPayload('https://example.com')).toThrow();
    expect(() => decodePairingPayload(Buffer.from('[]').toString('base64url'))).toThrow();
    expect(() =>
      decodePairingPayload(Buffer.from(JSON.stringify({ wsId: 'ws-1' })).toString('base64url')),
    ).toThrow();
    expect(() =>
      decodePairingPayload(Buffer.from(JSON.stringify({ key: 'AAAA' })).toString('base64url')),
    ).toThrow();
    expect(() =>
      decodePairingPayload(
        Buffer.from(JSON.stringify({ wsId: 'bad/../id', key: 'AAAA' })).toString('base64url'),
      ),
    ).toThrow();
    expect(() =>
      decodePairingPayload(
        Buffer.from(JSON.stringify({ wsId: 'ws-1', key: { kty: 'oct' } })).toString('base64url'),
      ),
    ).toThrow();
  });

  it('renders a local self-contained SVG QR code with no external URLs', async () => {
    const key = await generateVaultKey();
    const exported = await exportVaultKey(key);
    const payload = encodePairingPayload({ wsId: '550e8400-e29b-41d4-a716-446655440000', key: exported });

    const matrix = buildQrMatrix(payload);
    expect(matrix.size).toBeGreaterThanOrEqual(45);
    expect(matrix.modules.length).toBe(matrix.size);
    expect(matrix.modules[0].length).toBe(matrix.size);

    const svg = renderQrSvgString(payload);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('<rect ');
    expect(svg).toContain('<path ');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
  it('matches the cross-platform Android PairingTest QR vector byte-for-byte', () => {
    const keyB64Url =
      'eyJrZXlfb3BzIjpbImVuY3J5cHQiLCJkZWNyeXB0Il0sImV4dCI6dHJ1ZSwiYWxnIjoiQTI1NkdDTSIsImt0eSI6Im9jdCIsImsiOiJpUG14WjhsM0NKZjJJQUhqQUtuRV9DS2tVWVlJcTM5MTZwS0tlTVAwVFFrIn0';
    const wsId = '550e8400-e29b-41d4-a716-446655440000';
    const expected =
      'eyJ3c0lkIjoiNTUwZTg0MDAtZTI5Yi00MWQ0LWE3MTYtNDQ2NjU1NDQwMDAwIiwia2V5IjoiZXlKclpYbGZiM0J6SWpwYkltVnVZM0o1Y0hRaUxDSmtaV055ZVhCMElsMHNJbVY0ZENJNmRISjFaU3dpWVd4bklqb2lRVEkxTmtkRFRTSXNJbXQwZVNJNkltOWpkQ0lzSW1zaU9pSnBVRzE0V2poc00wTktaakpKUVVocVFVdHVSVjlEUzJ0VldWbEpjVE01TVRad1MwdGxUVkF3VkZGckluMCJ9';

    expect(encodePairingPayload({ wsId, key: keyB64Url })).toBe(expected);
    expect(decodePairingPayload(expected)).toEqual({ wsId, key: keyB64Url });
  });
});

/* ---------- UI behavior, security, auto-hide, fallback tests ---------- */

describe('pairing panel UI security and interactions', () => {
  let setDocumentHidden: (hidden: boolean) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    activeObservers.clear();
    ({ setDocumentHidden } = installDomShim());
  });

  afterEach(() => {
    vi.useRealTimers();
    activeObservers.clear();
  });

  function makeSamplePayload(): string {
    return encodePairingPayload({
      wsId: 'ws-atelier-emily',
      key: 'eyJrdHkiOiJvY3QiLCJhbGciOiJBMjU2R0NNIiwiayI6ImlQbXhaOGwzQ0pmMklBSGpBS25FX0NLa1VZWUlxMzkxNnBLS2VNUDBUUWsifQ',
    });
  }

  it('shows NO QR code before clicking "Connect your phone", then renders blurred QR with steps and warning', async () => {
    const payload = makeSamplePayload();
    const generatePayload = vi.fn(async () => payload);
    const handle = mountPairingPanel({ generatePayload });
    const root = handle.element as unknown as FakeElement;

    const connectBtn = root.querySelector('#connectPhoneBtn')!;
    const panel = root.querySelector('#pairingPanel')!;
    const qrHost = root.querySelector('#pairingQrHost')!;

    expect(connectBtn.textContent).toBe('Connect your phone');
    expect(panel.hidden).toBe(true);
    expect(qrHost.querySelector('svg')).toBeNull();
    expect(handle.isOpen()).toBe(false);
    expect(generatePayload).not.toHaveBeenCalled();

    // Click "Connect your phone"
    connectBtn.click();
    await flushMicrotasks();

    expect(generatePayload).toHaveBeenCalledTimes(1);
    expect(panel.hidden).toBe(false);
    expect(handle.isOpen()).toBe(true);
    expect(qrHost.querySelector('svg')).not.toBeNull();

    // Blurred until the user taps "Show code"
    expect(handle.isRevealed()).toBe(false);
    expect(qrHost.getAttribute('data-revealed')).toBe('false');
    expect(qrHost.style.filter).toContain('blur');

    const showBtn = root.querySelector('#showQrBtn')!;
    const overlay = root.querySelector('#pairingQrOverlay')!;
    expect(showBtn.textContent).toBe('Show code');
    expect(overlay.hidden).toBe(false);

    // Warning line and three numbered steps
    expect(root.querySelector('#pairingWarning')?.textContent).toBe(PAIRING_WARNING_COPY);
    expect(PAIRING_WARNING_COPY).toBe('Anyone who scans this can read your synced data.');
    const steps = root.querySelectorAll('li').map((li) => li.textContent);
    expect(steps).toEqual([...PAIRING_STEPS]);
    expect(steps).toEqual([
      'Open Cross-Venture on your phone',
      'Tap Scan',
      'Point at this code',
    ]);

    // Tap "Show code" to unblur
    showBtn.click();
    expect(handle.isRevealed()).toBe(true);
    expect(qrHost.getAttribute('data-revealed')).toBe('true');
    expect(qrHost.style.filter).toBe('none');
    expect(overlay.hidden).toBe(true);

    handle.destroy();
  });

  it('auto-hides the QR code and clears sensitive DOM after 2 minutes', async () => {
    const payload = makeSamplePayload();
    const statuses: string[] = [];
    const handle = mountPairingPanel({
      generatePayload: async () => payload,
      onStatus: (_kind, text) => statuses.push(text),
    });
    const root = handle.element as unknown as FakeElement;

    root.querySelector('#connectPhoneBtn')!.click();
    await flushMicrotasks();
    root.querySelector('#showQrBtn')!.click();

    expect(PAIRING_AUTO_HIDE_MS).toBe(120_000);
    expect(handle.isOpen()).toBe(true);
    expect(handle.isRevealed()).toBe(true);

    // Just before 2 minutes: still visible
    vi.advanceTimersByTime(PAIRING_AUTO_HIDE_MS - 1);
    expect(handle.isOpen()).toBe(true);

    // At 2 minutes: hidden, SVG removed, fallback cleared, blur reset
    vi.advanceTimersByTime(1);
    expect(handle.isOpen()).toBe(false);
    expect(handle.isRevealed()).toBe(false);
    expect(root.querySelector('#pairingPanel')!.hidden).toBe(true);
    expect(root.querySelector('#pairingQrHost')!.querySelector('svg')).toBeNull();
    expect(root.querySelector('#pairingValue')!.value).toBe('');
    expect(statuses.some((s) => /hidden/i.test(s))).toBe(true);

    handle.destroy();
  });

  it('hides the QR code when the user leaves Settings or backgrounds the tab', async () => {
    const payload = makeSamplePayload();
    const settingsPage = new FakeElement('section');
    settingsPage.id = 'page-settings';
    settingsPage.className = 'page';

    const handle = mountPairingPanel({
      generatePayload: async () => payload,
      observeLeaveRoot: settingsPage as unknown as HTMLElement,
    });
    settingsPage.append(handle.element as unknown as FakeElement);
    const root = handle.element as unknown as FakeElement;

    root.querySelector('#connectPhoneBtn')!.click();
    await flushMicrotasks();
    root.querySelector('#showQrBtn')!.click();
    expect(handle.isOpen()).toBe(true);

    // Navigate away from Settings (main.ts sets page-settings.hidden = true)
    settingsPage.hidden = true;
    expect(handle.isOpen()).toBe(false);
    expect(root.querySelector('#pairingQrHost')!.querySelector('svg')).toBeNull();

    // Return to Settings and open again, then background the browser tab
    settingsPage.hidden = false;
    root.querySelector('#connectPhoneBtn')!.click();
    await flushMicrotasks();
    expect(handle.isOpen()).toBe(true);

    setDocumentHidden(true);
    expect(handle.isOpen()).toBe(false);
    expect(root.querySelector('#pairingValue')!.value).toBe('');

    handle.destroy();
  });

  it('keeps the copyable fallback pairing string available under "Can\'t scan?"', async () => {
    const payload = makeSamplePayload();
    const copied: string[] = [];
    const handle = mountPairingPanel({
      generatePayload: async () => payload,
      onCopy: (v) => copied.push(v),
    });
    const root = handle.element as unknown as FakeElement;

    root.querySelector('#connectPhoneBtn')!.click();
    await flushMicrotasks();

    const cantScan = root.querySelector('#cantScanLink')!;
    const fallback = root.querySelector('#pairingFallback')!;
    const pairingTextarea = root.querySelector('#pairingValue')!;
    const copyBtn = root.querySelector('#copyPairingBtn')!;

    expect(cantScan.textContent).toBe("Can't scan?");
    expect(fallback.hidden).toBe(true);
    expect(cantScan.getAttribute('aria-expanded')).toBe('false');

    // Expand fallback
    cantScan.click();
    expect(fallback.hidden).toBe(false);
    expect(cantScan.getAttribute('aria-expanded')).toBe('true');
    expect(pairingTextarea.value).toBe(payload);
    expect(decodePairingPayload(pairingTextarea.value).wsId).toBe('ws-atelier-emily');

    // Copy fallback string
    copyBtn.click();
    expect(copied).toEqual([payload]);

    // Collapse fallback
    cantScan.click();
    expect(fallback.hidden).toBe(true);
    expect(cantScan.getAttribute('aria-expanded')).toBe('false');

    handle.destroy();
  });

  it('mountSync wires "Connect your phone" to a real WebCrypto key and hides when leaving Settings', async () => {
    const mem: Record<string, string> = {};
    (globalThis as Record<string, unknown>).window = {
      addEventListener() {},
      removeEventListener() {},
      localStorage: {
        getItem: (k: string) => (k in mem ? mem[k] : null),
        setItem: (k: string, v: string) => {
          mem[k] = v;
        },
      },
    };
    store.setVault(null, null);
    store.setWorkspace(null);

    const settingsPage = new FakeElement('section');
    settingsPage.id = 'page-settings';
    settingsPage.className = 'page';
    const root = new FakeElement('div');
    root.id = 'root-sync';
    settingsPage.append(root);

    mountSync(root as unknown as HTMLElement);

    // No QR rendered on mount
    expect(root.querySelector('#pairingPanel')!.hidden).toBe(true);
    expect(root.querySelector('#pairingQrHost')!.querySelector('svg')).toBeNull();

    // Click "Connect your phone"
    root.querySelector('#connectPhoneBtn')!.click();
    await flushMicrotasks();
    // WebCrypto exportKey is async — allow microtasks to settle
    await vi.waitFor(() => {
      expect(root.querySelector('#pairingPanel')!.hidden).toBe(false);
    });

    expect(root.querySelector('#pairingQrHost')!.querySelector('svg')).not.toBeNull();
    expect(root.querySelector('#pairingQrHost')!.getAttribute('data-revealed')).toBe('false');

    // Fallback string decodes to a real importable AES-256-GCM key
    root.querySelector('#cantScanLink')!.click();
    const raw = root.querySelector('#pairingValue')!.value;
    const decoded = decodePairingPayload(raw);
    const imported = await importVaultKey(decoded.key);
    expect(imported.algorithm.name).toBe('AES-GCM');

    // Leaving Settings hides and clears the QR
    settingsPage.hidden = true;
    expect(root.querySelector('#pairingPanel')!.hidden).toBe(true);
    expect(root.querySelector('#pairingQrHost')!.querySelector('svg')).toBeNull();
    expect(root.querySelector('#pairingValue')!.value).toBe('');
  });
});
