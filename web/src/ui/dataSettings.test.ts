import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../types';
import { openConfirmDialog, type ConfirmDialogOptions } from './confirmDialog';
import {
  buildClearAllDialog,
  buildRemoveDocumentDialog,
  buildRemoveVentureDialog,
  mountDataSettings,
  requestClearAllData,
  requestRemoveVenture,
  type DataActionsDeps,
} from './dataSettings';

/* ---------- sample workspace fixtures ---------- */

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-test-1',
    name: 'Test Workspace',
    graph: {
      ventures: [
        { venture_id: 'v-ae', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
        { venture_id: 'v-ns', venture_token: '[VENTURE_2]', min_margin_pct_token: '[MARGIN_FLOOR_2]' },
      ],
      partners: [
        {
          partner_id: 'p-emily',
          partner_token: '[PARTNER_1]',
          venture_id: 'v-ae',
          approval_rules: 'signs off discounts above cap',
        },
      ],
      products: [
        {
          sku_id: 'sku-1',
          sku_token: '[SKU_1]',
          venture_id: 'v-ae',
          cogs_token: '[COST_1]',
          list_price_token: '[PRICE_1]',
        },
        {
          sku_id: 'sku-2',
          sku_token: '[SKU_2]',
          venture_id: 'v-ns',
          cogs_token: '[COST_2]',
          list_price_token: '[PRICE_2]',
        },
      ],
      dealRules: [
        {
          rule_id: 'R-1',
          venture_id: 'v-ae',
          max_discount_pct_token: '[DISCOUNT_CAP_1]',
          min_qty_condition: 'none',
          requires_partner_approval: true,
          source_doc_name: 'agreement.md',
          page_or_section: '§4.3',
          verbatim_blinded_excerpt: 'up to [DISCOUNT_CAP_1]',
        },
      ],
    },
    tokenMap: {
      '[VENTURE_1]': 'Atelier Emily',
      '[VENTURE_2]': 'Nomad Studio',
    },
    docs: [
      { docName: 'agreement.md', page: 1, index: 0, blindedText: 'chunk 1' },
      { docName: 'agreement.md', page: 2, index: 1, blindedText: 'chunk 2' },
      { docName: 'cost-sheet.md', page: 1, index: 0, blindedText: 'chunk 3' },
    ],
    payloadLog: [
      {
        docName: 'agreement.md',
        page: 1,
        localText: 'raw',
        cloudText: 'blinded',
        sentAt: 1000,
      },
    ],
    updatedAt: 2000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DataActionsDeps> = {}): DataActionsDeps {
  return {
    getWorkspace: () => makeWorkspace(),
    getSelectedVentureId: () => 'v-ae',
    getSelectedVentureName: () => 'Atelier Emily',
    getVentureDeletionCounts: () => ({
      docCount: 2,
      ruleCount: 1,
      productCount: 1,
      requestCount: 3,
    }),
    getRequestCount: () => 3,
    hasSyncedCopy: () => false,
    confirm: vi.fn(async () => false),
    onOpenSync: vi.fn(),
    onRemoveVenture: vi.fn(async () => {}),
    onClearAllData: vi.fn(async () => {}),
    subscribe: () => () => {},
    onToast: vi.fn(),
    ...overrides,
  };
}

/* ---------- pure copy builders ---------- */

describe('buildRemoveVentureDialog', () => {
  it('builds plain-words copy with exact plural counts and no sync notice when not synced', () => {
    const opts = buildRemoveVentureDialog({
      ventureName: 'Atelier Emily',
      docCount: 3,
      ruleCount: 4,
      productCount: 2,
      requestCount: 5,
      hasSyncedCopy: false,
    });

    expect(opts.title).toBe('Remove Atelier Emily?');
    expect(opts.summary).toBe('This deletes Atelier Emily from this device. It cannot be undone.');
    expect(opts.confirmLabel).toBe('Remove venture');
    expect(opts.danger).toBe(true);
    expect(opts.syncNotice).toBeUndefined();

    const joined = opts.items.join(' | ');
    expect(joined).toContain('Atelier Emily');
    expect(joined).toContain('3 documents');
    expect(joined).toContain('4 rules');
    expect(joined).toContain('2 products');
    expect(joined).toContain('5 buyer requests');
  });

  it('uses singular forms when counts are 1', () => {
    const opts = buildRemoveVentureDialog({
      ventureName: 'Nomad Studio',
      docCount: 1,
      ruleCount: 1,
      productCount: 1,
      requestCount: 1,
      hasSyncedCopy: false,
    });

    const joined = opts.items.join(' | ');
    expect(joined).toContain('1 document');
    expect(joined).not.toContain('1 documents');
    expect(joined).toContain('1 rule');
    expect(joined).not.toContain('1 rules');
    expect(joined).toContain('1 product');
    expect(joined).not.toContain('1 products');
    expect(joined).toContain('1 buyer request');
    expect(joined).not.toContain('1 buyer requests');
  });

  it('attaches syncNotice and wires onOpenSync only when hasSyncedCopy is true', () => {
    const onOpenSync = vi.fn();
    const opts = buildRemoveVentureDialog(
      {
        ventureName: 'Atelier Emily',
        docCount: 2,
        ruleCount: 0,
        productCount: 1,
        requestCount: 0,
        hasSyncedCopy: true,
      },
      onOpenSync,
    );

    expect(opts.syncNotice).toBeDefined();
    expect(opts.syncNotice?.text.toLowerCase()).toContain('not deleted');
    expect(opts.syncNotice?.actionLabel).toBe('Open Phone sync');
    opts.syncNotice?.onOpenSync();
    expect(onOpenSync).toHaveBeenCalledTimes(1);
  });
});

describe('buildClearAllDialog', () => {
  it('builds plain-words copy listing all local data types and storage layers', () => {
    const opts = buildClearAllDialog({
      ventureCount: 2,
      docCount: 4,
      ruleCount: 6,
      productCount: 3,
      requestCount: 5,
      payloadLogCount: 7,
      hasSyncedCopy: false,
    });

    expect(opts.title).toBe('Clear all data on this device?');
    expect(opts.summary).toBe(
      'This wipes everything stored on this device and returns the app to its empty first-run state.',
    );
    expect(opts.confirmLabel).toBe('Clear all data');
    expect(opts.danger).toBe(true);
    expect(opts.syncNotice).toBeUndefined();

    const joined = opts.items.join(' | ');
    expect(joined).toContain('2 ventures');
    expect(joined).toContain('4 documents');
    expect(joined).toContain('6 rules');
    expect(joined).toContain('3 products');
    expect(joined).toContain('5 buyer requests');
    expect(joined).toContain('7 cached payload log entries');
    expect(joined).toContain('IndexedDB');
    expect(joined).toContain('localStorage');
  });

  it('uses singular forms when counts are 1 and wires syncNotice when synced', () => {
    const onOpenSync = vi.fn();
    const opts = buildClearAllDialog(
      {
        ventureCount: 1,
        docCount: 1,
        ruleCount: 1,
        productCount: 1,
        requestCount: 1,
        payloadLogCount: 1,
        hasSyncedCopy: true,
      },
      onOpenSync,
    );

    const joined = opts.items.join(' | ');
    expect(joined).toContain('1 venture');
    expect(joined).not.toContain('1 ventures');
    expect(joined).toContain('1 document');
    expect(joined).not.toContain('1 documents');
    expect(joined).toContain('1 rule');
    expect(joined).not.toContain('1 rules');
    expect(joined).toContain('1 product');
    expect(joined).not.toContain('1 products');
    expect(joined).toContain('1 buyer request');
    expect(joined).not.toContain('1 buyer requests');
    expect(joined).toContain('1 cached payload log entry');
    expect(joined).not.toContain('1 cached payload log entries');

    expect(opts.syncNotice).toBeDefined();
    expect(opts.syncNotice?.text.toLowerCase()).toContain('not deleted');
    expect(opts.syncNotice?.actionLabel).toBe('Open Phone sync');
    opts.syncNotice?.onOpenSync();
    expect(onOpenSync).toHaveBeenCalledTimes(1);
  });
});

describe('buildRemoveDocumentDialog', () => {
  it('lists cached text, payload logs, and extracted rule count without venture removal when other docs remain', () => {
    const opts = buildRemoveDocumentDialog({
      docName: 'cost-sheet.md',
      ruleCount: 1,
      willRemoveVentureNames: [],
      hasSyncedCopy: false,
    });

    expect(opts.title).toBe('Remove cost-sheet.md?');
    expect(opts.summary).toBe('This removes cost-sheet.md from this device.');
    expect(opts.confirmLabel).toBe('Remove document');
    expect(opts.danger).toBe(true);
    expect(opts.syncNotice).toBeUndefined();

    const joined = opts.items.join(' | ');
    expect(joined.toLowerCase()).toContain('cached document text');
    expect(joined.toLowerCase()).toContain('payload log');
    expect(joined).toContain('1 extracted rule');
    expect(joined).not.toContain('1 extracted rules');
    expect(joined.toLowerCase()).not.toContain('no other documents');
  });

  it('warns when removing the document will also remove one or more ventures and attaches syncNotice when synced', () => {
    const onOpenSync = vi.fn();
    const single = buildRemoveDocumentDialog(
      {
        docName: 'nomad-terms.md',
        ruleCount: 3,
        willRemoveVentureNames: ['Nomad Studio'],
        hasSyncedCopy: true,
      },
      onOpenSync,
    );

    const singleJoined = single.items.join(' | ');
    expect(singleJoined).toContain('3 extracted rules');
    expect(singleJoined).toContain('Nomad Studio');
    expect(singleJoined.toLowerCase()).toContain('no other documents');
    expect(single.syncNotice).toBeDefined();
    expect(single.syncNotice?.actionLabel).toBe('Open Phone sync');
    single.syncNotice?.onOpenSync();
    expect(onOpenSync).toHaveBeenCalledTimes(1);

    const multi = buildRemoveDocumentDialog({
      docName: 'shared.md',
      ruleCount: 0,
      willRemoveVentureNames: ['Atelier Emily', 'Nomad Studio'],
      hasSyncedCopy: false,
    });
    const multiJoined = multi.items.join(' | ');
    expect(multiJoined).toContain('Atelier Emily');
    expect(multiJoined).toContain('Nomad Studio');
    expect(multiJoined.toLowerCase()).toContain('no other documents');
    expect(multi.syncNotice).toBeUndefined();
  });
});

/* ---------- guarded executors ---------- */

describe('requestRemoveVenture', () => {
  it('never calls onRemoveVenture when confirm resolves false', async () => {
    const deps = makeDeps({
      confirm: vi.fn(async () => false),
    });

    const removed = await requestRemoveVenture(deps);

    expect(removed).toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.onRemoveVenture).not.toHaveBeenCalled();
    expect(deps.onToast).not.toHaveBeenCalled();
  });

  it('calls onRemoveVenture with the selected ventureId when confirm resolves true', async () => {
    let capturedOpts: ConfirmDialogOptions | null = null;
    const deps = makeDeps({
      hasSyncedCopy: () => true,
      confirm: vi.fn(async (opts: ConfirmDialogOptions) => {
        capturedOpts = opts;
        return true;
      }),
    });

    const removed = await requestRemoveVenture(deps);

    expect(removed).toBe(true);
    expect(deps.onRemoveVenture).toHaveBeenCalledTimes(1);
    expect(deps.onRemoveVenture).toHaveBeenCalledWith('v-ae');
    expect(deps.onToast).toHaveBeenCalledTimes(1);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.title).toBe('Remove Atelier Emily?');
    expect(capturedOpts!.syncNotice).toBeDefined();
    capturedOpts!.syncNotice?.onOpenSync();
    expect(deps.onOpenSync).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no workspace or no venture is selected', async () => {
    const noWs = makeDeps({ getWorkspace: () => null });
    expect(await requestRemoveVenture(noWs)).toBe(false);
    expect(noWs.confirm).not.toHaveBeenCalled();
    expect(noWs.onRemoveVenture).not.toHaveBeenCalled();

    const noVenture = makeDeps({ getSelectedVentureId: () => '' });
    expect(await requestRemoveVenture(noVenture)).toBe(false);
    expect(noVenture.confirm).not.toHaveBeenCalled();
    expect(noVenture.onRemoveVenture).not.toHaveBeenCalled();
  });
});

describe('requestClearAllData', () => {
  it('never calls onClearAllData when confirm resolves false', async () => {
    const deps = makeDeps({
      confirm: vi.fn(async () => false),
    });

    const cleared = await requestClearAllData(deps);

    expect(cleared).toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.onClearAllData).not.toHaveBeenCalled();
    expect(deps.onToast).not.toHaveBeenCalled();
  });

  it('calls onClearAllData with zero args and accurate unique document count when confirm resolves true', async () => {
    let capturedOpts: ConfirmDialogOptions | null = null;
    const deps = makeDeps({
      hasSyncedCopy: () => true,
      confirm: vi.fn(async (opts: ConfirmDialogOptions) => {
        capturedOpts = opts;
        return true;
      }),
    });

    const cleared = await requestClearAllData(deps);

    expect(cleared).toBe(true);
    expect(deps.onClearAllData).toHaveBeenCalledTimes(1);
    expect(deps.onClearAllData).toHaveBeenCalledWith();
    expect(deps.onToast).toHaveBeenCalledTimes(1);

    // makeWorkspace() has 3 chunks across 2 unique docNames ('agreement.md' and 'cost-sheet.md')
    const joined = capturedOpts!.items.join(' | ');
    expect(joined).toContain('2 ventures');
    expect(joined).toContain('2 documents');
    expect(joined).toContain('1 rule');
    expect(joined).toContain('2 products');
    expect(joined).toContain('3 buyer requests');
    expect(joined).toContain('1 cached payload log entry');
    expect(capturedOpts!.syncNotice).toBeDefined();
  });

  it('works when workspace is null but buyer requests exist', async () => {
    let capturedOpts: ConfirmDialogOptions | null = null;
    const deps = makeDeps({
      getWorkspace: () => null,
      getRequestCount: () => 2,
      confirm: vi.fn(async (opts: ConfirmDialogOptions) => {
        capturedOpts = opts;
        return true;
      }),
    });

    const cleared = await requestClearAllData(deps);
    expect(cleared).toBe(true);
    expect(deps.onClearAllData).toHaveBeenCalledTimes(1);
    expect(capturedOpts!.items.join(' | ')).toContain('2 buyer requests');
  });
});

/* ---------- local-only safety guarantee ---------- */

describe('local-only delete boundary', () => {
  it('contains no cloud or Firestore delete calls in confirmDialog.ts or dataSettings.ts', () => {
    const files = [
      resolve(__dirname, 'confirmDialog.ts'),
      resolve(__dirname, 'dataSettings.ts'),
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/deleteDoc|firestore|firebase\/firestore|deleteField|pushEncrypted/i);
    }
  });
});

/* ---------- minimal DOM harness for confirmDialog & mountDataSettings ---------- */

type Listener = (ev: { target?: unknown; key?: string; preventDefault?: () => void }) => void;

class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  disabled = false;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeTextNode> = [];
  parent: FakeElement | null = null;
  listeners: Record<string, Listener[]> = {};
  focused = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get id(): string {
    return this.attrs.id ?? '';
  }
  set id(v: string) {
    this.attrs.id = v;
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'class') this.className = v;
  }

  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return k in this.attrs ? this.attrs[k] : null;
  }

  append(...nodes: Array<FakeElement | FakeTextNode>): void {
    for (const n of nodes) {
      if (n instanceof FakeElement) n.parent = this;
      this.children.push(n);
    }
  }

  replaceChildren(...nodes: Array<FakeElement | FakeTextNode>): void {
    for (const c of this.children) {
      if (c instanceof FakeElement) c.parent = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== fn);
  }

  dispatch(type: string, ev: { target?: unknown; key?: string; preventDefault?: () => void } = {}): void {
    const event = { target: this, preventDefault: () => {}, ...ev };
    for (const fn of [...(this.listeners[type] ?? [])]) {
      fn(event);
    }
  }

  focus(): void {
    this.focused = true;
  }

  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) {
      if (c instanceof FakeElement) out.push(...c.findAll(pred));
    }
    return out;
  }

  findById(id: string): FakeElement | null {
    return this.findAll((e) => e.attrs.id === id)[0] ?? null;
  }

  findByClass(cls: string): FakeElement[] {
    return this.findAll((e) => e.className.split(/\s+/).includes(cls));
  }

  allText(): string {
    const parts: string[] = [];
    if (this.textContent) parts.push(this.textContent);
    for (const c of this.children) {
      parts.push(c instanceof FakeElement ? c.allText() : c.data);
    }
    return parts.join(' ');
  }
}

class FakeTextNode {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}

function installFakeDom(): {
  body: FakeElement;
  docListeners: Record<string, Listener[]>;
  dispatchKeydown: (key: string) => void;
  restore: () => void;
} {
  const prevDoc = (globalThis as Record<string, unknown>).document;
  const body = new FakeElement('body');
  const docListeners: Record<string, Listener[]> = {};

  (globalThis as Record<string, unknown>).document = {
    body,
    activeElement: null,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeTextNode(text),
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (!docListeners[type]) return;
      docListeners[type] = docListeners[type].filter((l) => l !== fn);
    },
  };

  return {
    body,
    docListeners,
    dispatchKeydown: (key: string) => {
      for (const fn of [...(docListeners.keydown ?? [])]) {
        fn({ key, preventDefault: () => {} });
      }
    },
    restore: () => {
      if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = prevDoc;
    },
  };
}

describe('openConfirmDialog', () => {
  it('renders accessible modal markup and resolves true only on confirm click, cleaning up after', async () => {
    const dom = installFakeDom();
    try {
      const promise = openConfirmDialog({
        title: 'Remove Atelier Emily?',
        summary: 'Cannot be undone.',
        items: ['2 documents', '1 rule'],
        confirmLabel: 'Remove venture',
        danger: true,
      });

      const backdrop = dom.body.findByClass('modal-backdrop')[0];
      expect(backdrop).toBeDefined();
      const dialog = backdrop.findByClass('modal-dialog')[0];
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      const title = backdrop.findByClass('modal-title')[0];
      expect(title.getAttribute('id')).toBeTruthy();
      expect(dialog.getAttribute('aria-labelledby')).toBe(title.getAttribute('id'));
      expect(backdrop.findByClass('modal-body').length).toBe(1);
      expect(backdrop.findByClass('modal-list').length).toBe(1);
      expect(backdrop.findByClass('modal-actions').length).toBe(1);

      const confirmBtn = backdrop.findByClass('btn-danger')[0];
      expect(confirmBtn).toBeDefined();
      confirmBtn.dispatch('click');

      await expect(promise).resolves.toBe(true);
      expect(dom.body.children.length).toBe(0);
      expect(dom.docListeners.keydown?.length ?? 0).toBe(0);
    } finally {
      dom.restore();
    }
  });

  it('resolves false on cancel click, Escape key, backdrop click, and syncNotice action', async () => {
    const dom = installFakeDom();
    try {
      // 1. Cancel button
      const pCancel = openConfirmDialog({
        title: 'Confirm?',
        summary: 'Summary',
        items: ['Item'],
        confirmLabel: 'Do it',
        danger: false,
      });
      expect(dom.body.findByClass('btn-primary').length).toBe(1);
      dom.body.findByClass('btn-secondary')[0].dispatch('click');
      await expect(pCancel).resolves.toBe(false);
      expect(dom.body.children.length).toBe(0);

      // 2. Escape key
      const pEsc = openConfirmDialog({
        title: 'Confirm?',
        summary: 'Summary',
        items: ['Item'],
        confirmLabel: 'Do it',
      });
      dom.dispatchKeydown('Escape');
      await expect(pEsc).resolves.toBe(false);
      expect(dom.body.children.length).toBe(0);
      expect(dom.docListeners.keydown?.length ?? 0).toBe(0);

      // 3. Backdrop click
      const pBackdrop = openConfirmDialog({
        title: 'Confirm?',
        summary: 'Summary',
        items: ['Item'],
        confirmLabel: 'Do it',
      });
      const backdrop = dom.body.findByClass('modal-backdrop')[0];
      backdrop.dispatch('click', { target: backdrop });
      await expect(pBackdrop).resolves.toBe(false);
      expect(dom.body.children.length).toBe(0);

      // 4. Sync notice button
      const onOpenSync = vi.fn();
      const pSync = openConfirmDialog({
        title: 'Confirm?',
        summary: 'Summary',
        items: ['Item'],
        confirmLabel: 'Do it',
        danger: true,
        syncNotice: {
          text: 'Your encrypted phone-sync copy is not deleted by this action.',
          actionLabel: 'Open Phone sync',
          onOpenSync,
        },
      });
      const syncNote = dom.body.findByClass('modal-sync-note')[0];
      expect(syncNote).toBeDefined();
      const syncBtn = syncNote.findByClass('btn-secondary')[0];
      syncBtn.dispatch('click');
      await expect(pSync).resolves.toBe(false);
      expect(onOpenSync).toHaveBeenCalledTimes(1);
      expect(dom.body.children.length).toBe(0);
    } finally {
      dom.restore();
    }
  });
});

describe('mountDataSettings', () => {
  it('renders Data section, disables buttons when empty, and updates on subscribe notifications', () => {
    const dom = installFakeDom();
    try {
      const root = new FakeElement('div');
      let ws: Workspace | null = null;
      let ventureId = '';
      let reqCount = 0;
      const listeners = new Set<() => void>();
      const notify = (): void => {
        for (const l of listeners) l();
      };

      const deps = makeDeps({
        getWorkspace: () => ws,
        getSelectedVentureId: () => ventureId,
        getSelectedVentureName: () => (ventureId ? 'Atelier Emily' : ''),
        getRequestCount: () => reqCount,
        subscribe: (l) => {
          listeners.add(l);
          return () => {
            listeners.delete(l);
          };
        },
      });

      mountDataSettings(root as unknown as HTMLElement, deps);

      const section = root.findAll((e) => e.tagName === 'SECTION')[0];
      expect(section.getAttribute('aria-labelledby')).toBe('set-data');
      expect(root.findById('set-data')?.allText()).toContain('Data');
      expect(root.findById('btnRemoveVenture')?.disabled).toBe(true);
      expect(root.findById('btnClearAllData')?.disabled).toBe(true);

      // Load workspace and notify subscribers
      ws = makeWorkspace();
      ventureId = 'v-ae';
      reqCount = 2;
      notify();

      expect(root.findById('btnRemoveVenture')?.disabled).toBe(false);
      expect(root.findById('btnClearAllData')?.disabled).toBe(false);
      expect(root.allText()).toContain('Atelier Emily');

      // Workspace cleared, but 1 request remains -> Clear all data stays enabled, Remove venture disabled
      ws = null;
      ventureId = '';
      reqCount = 1;
      notify();

      expect(root.findById('btnRemoveVenture')?.disabled).toBe(true);
      expect(root.findById('btnClearAllData')?.disabled).toBe(false);
    } finally {
      dom.restore();
    }
  });
});
