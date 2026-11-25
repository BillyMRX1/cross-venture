// Settings "Data" section + pure delete-confirmation copy builders and guarded
// local-only deletion executors. None of these actions touch remote phone sync.
import type { Workspace } from '../types';
import type { ConfirmDialogOptions } from './confirmDialog';
import { el, errText } from './util';

const SYNC_NOTICE_TEXT = 'Your encrypted phone-sync copy is not deleted by this action.';
const SYNC_ACTION_LABEL = 'Open Phone sync';

function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function uniqueDocCount(ws: Workspace | null): number {
  if (!ws) return 0;
  return new Set(ws.docs.map((d) => d.docName)).size;
}

function syncNoticeFor(
  hasSyncedCopy: boolean,
  onOpenSync?: () => void,
): ConfirmDialogOptions['syncNotice'] {
  if (!hasSyncedCopy) return undefined;
  return {
    text: SYNC_NOTICE_TEXT,
    actionLabel: SYNC_ACTION_LABEL,
    onOpenSync: onOpenSync ?? (() => {}),
  };
}

/* ---------- pure confirm-dialog copy builders ---------- */

export interface RemoveVentureSummaryInput {
  ventureName: string;
  docCount: number;
  ruleCount: number;
  productCount: number;
  requestCount: number;
  hasSyncedCopy: boolean;
}

export function buildRemoveVentureDialog(
  input: RemoveVentureSummaryInput,
  onOpenSync?: () => void,
): ConfirmDialogOptions {
  const syncNotice = syncNoticeFor(input.hasSyncedCopy, onOpenSync);
  return {
    title: `Remove ${input.ventureName}?`,
    summary: `This deletes ${input.ventureName} from this device. It cannot be undone.`,
    items: [
      `Venture "${input.ventureName}" and its partner details`,
      countLabel(input.docCount, 'document'),
      countLabel(input.ruleCount, 'rule'),
      countLabel(input.productCount, 'product'),
      countLabel(input.requestCount, 'buyer request'),
    ],
    confirmLabel: 'Remove venture',
    danger: true,
    ...(syncNotice ? { syncNotice } : {}),
  };
}

export interface ClearAllSummaryInput {
  ventureCount: number;
  docCount: number;
  ruleCount: number;
  productCount: number;
  requestCount: number;
  payloadLogCount: number;
  hasSyncedCopy: boolean;
}

export function buildClearAllDialog(
  input: ClearAllSummaryInput,
  onOpenSync?: () => void,
): ConfirmDialogOptions {
  const syncNotice = syncNoticeFor(input.hasSyncedCopy, onOpenSync);
  return {
    title: 'Clear all data on this device?',
    summary:
      'This wipes everything stored on this device and returns the app to its empty first-run state.',
    items: [
      countLabel(input.ventureCount, 'venture'),
      countLabel(input.docCount, 'document'),
      countLabel(input.ruleCount, 'rule'),
      countLabel(input.productCount, 'product'),
      countLabel(input.requestCount, 'buyer request'),
      countLabel(input.payloadLogCount, 'cached payload log entry', 'cached payload log entries'),
      'All local browser storage for this app (IndexedDB and localStorage)',
    ],
    confirmLabel: 'Clear all data',
    danger: true,
    ...(syncNotice ? { syncNotice } : {}),
  };
}

export interface RemoveDocSummaryInput {
  docName: string;
  ruleCount: number;
  willRemoveVentureNames: string[];
  hasSyncedCopy: boolean;
}

export function buildRemoveDocumentDialog(
  input: RemoveDocSummaryInput,
  onOpenSync?: () => void,
): ConfirmDialogOptions {
  const items: string[] = [
    'Cached document text and payload logs for this document',
    countLabel(input.ruleCount, 'extracted rule'),
  ];
  if (input.willRemoveVentureNames.length === 1) {
    items.push(
      `Venture "${input.willRemoveVentureNames[0]}" has no other documents and will also be removed`,
    );
  } else if (input.willRemoveVentureNames.length > 1) {
    items.push(
      `Ventures with no other documents will also be removed: ${input.willRemoveVentureNames.join(', ')}`,
    );
  }
  const syncNotice = syncNoticeFor(input.hasSyncedCopy, onOpenSync);
  return {
    title: `Remove ${input.docName}?`,
    summary: `This removes ${input.docName} from this device.`,
    items,
    confirmLabel: 'Remove document',
    danger: true,
    ...(syncNotice ? { syncNotice } : {}),
  };
}

/* ---------- guarded deletion executors ---------- */

export interface DataActionsDeps {
  getWorkspace: () => Workspace | null;
  getSelectedVentureId: () => string;
  getSelectedVentureName: () => string;
  getVentureDeletionCounts: (ventureId: string) => {
    docCount: number;
    ruleCount: number;
    productCount: number;
    requestCount: number;
  };
  getRequestCount: () => number;
  hasSyncedCopy: () => boolean;
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onOpenSync: () => void;
  onRemoveVenture: (ventureId: string) => Promise<void>;
  onClearAllData: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  onToast?: (msg: string, kind: 'ok' | 'warn' | 'error') => void;
}

export async function requestRemoveVenture(deps: DataActionsDeps): Promise<boolean> {
  const ws = deps.getWorkspace();
  const ventureId = deps.getSelectedVentureId();
  if (!ws || !ventureId) return false;

  const ventureName = deps.getSelectedVentureName() || ventureId;
  const counts = deps.getVentureDeletionCounts(ventureId);
  const opts = buildRemoveVentureDialog(
    {
      ventureName,
      docCount: counts.docCount,
      ruleCount: counts.ruleCount,
      productCount: counts.productCount,
      requestCount: counts.requestCount,
      hasSyncedCopy: deps.hasSyncedCopy(),
    },
    deps.onOpenSync,
  );

  const ok = await deps.confirm(opts);
  if (!ok) return false;

  await deps.onRemoveVenture(ventureId);
  deps.onToast?.(`Removed ${ventureName} from this device.`, 'ok');
  return true;
}

export async function requestClearAllData(deps: DataActionsDeps): Promise<boolean> {
  const ws = deps.getWorkspace();
  const opts = buildClearAllDialog(
    {
      ventureCount: ws ? ws.graph.ventures.length : 0,
      docCount: uniqueDocCount(ws),
      ruleCount: ws ? ws.graph.dealRules.length : 0,
      productCount: ws ? ws.graph.products.length : 0,
      requestCount: deps.getRequestCount(),
      payloadLogCount: ws ? ws.payloadLog.length : 0,
      hasSyncedCopy: deps.hasSyncedCopy(),
    },
    deps.onOpenSync,
  );

  const ok = await deps.confirm(opts);
  if (!ok) return false;

  await deps.onClearAllData();
  deps.onToast?.('Cleared all data on this device.', 'ok');
  return true;
}

/* ---------- Settings "Data" section ---------- */

function deviceSummaryText(ws: Workspace | null, requestCount: number): string {
  if (!ws && requestCount === 0) {
    return 'Nothing is stored on this device yet. Data you load stays in local browser storage until you remove it.';
  }
  const parts: string[] = [];
  if (ws) {
    parts.push(countLabel(ws.graph.ventures.length, 'venture'));
    parts.push(countLabel(uniqueDocCount(ws), 'document'));
    parts.push(countLabel(ws.graph.dealRules.length, 'rule'));
    parts.push(countLabel(ws.graph.products.length, 'product'));
  }
  parts.push(countLabel(requestCount, 'buyer request'));
  return `Stored on this device: ${parts.join(', ')}. Removing data here never deletes an encrypted phone-sync copy.`;
}

export function mountDataSettings(root: HTMLElement, deps: DataActionsDeps): void {
  let busy = false;

  function render(): void {
    const ws = deps.getWorkspace();
    const ventureId = deps.getSelectedVentureId();
    const ventureName = deps.getSelectedVentureName();
    const requestCount = deps.getRequestCount();
    const hasSelectedVenture = Boolean(ws && ventureId);
    const isEmpty = ws === null && requestCount === 0;

    const removeVentureBtn = el(
      'button',
      { class: 'btn btn-secondary', id: 'btnRemoveVenture', type: 'button' },
      'Remove this venture',
    );
    removeVentureBtn.disabled = busy || !hasSelectedVenture;
    removeVentureBtn.addEventListener('click', () => {
      if (busy) return;
      void (async () => {
        busy = true;
        render();
        try {
          await requestRemoveVenture(deps);
        } catch (e) {
          deps.onToast?.(`Could not remove venture: ${errText(e)}`, 'error');
        } finally {
          busy = false;
          render();
        }
      })();
    });

    const clearAllBtn = el(
      'button',
      { class: 'btn btn-danger', id: 'btnClearAllData', type: 'button' },
      'Clear all data',
    );
    clearAllBtn.disabled = busy || isEmpty;
    clearAllBtn.addEventListener('click', () => {
      if (busy) return;
      void (async () => {
        busy = true;
        render();
        try {
          await requestClearAllData(deps);
        } catch (e) {
          deps.onToast?.(`Could not clear data: ${errText(e)}`, 'error');
        } finally {
          busy = false;
          render();
        }
      })();
    });

    const removeDesc = hasSelectedVenture
      ? `Deletes ${ventureName || ventureId} and its documents, rules, products, and buyer requests from this device.`
      : 'Select a venture to remove it and its associated local data from this device.';

    const section = el(
      'section',
      { class: 'section', 'aria-labelledby': 'set-data' },
      el('h2', { class: 'section-title', id: 'set-data' }, 'Data'),
      el('p', { class: 'hint' }, deviceSummaryText(ws, requestCount)),
      el(
        'div',
        { class: 'data-actions' },
        el(
          'div',
          { class: 'data-row' },
          el(
            'div',
            { class: 'data-row-copy' },
            el('strong', {}, 'Remove this venture'),
            el('p', { class: 'hint' }, removeDesc),
          ),
          removeVentureBtn,
        ),
        el(
          'div',
          { class: 'data-row' },
          el(
            'div',
            { class: 'data-row-copy' },
            el('strong', {}, 'Clear all data'),
            el(
              'p',
              { class: 'hint' },
              'Wipes your workspace, documents, rules, products, requests, and cached payload logs on this device.',
            ),
          ),
          clearAllBtn,
        ),
      ),
    );

    root.replaceChildren(section);
  }

  deps.subscribe(render);
  render();
}
