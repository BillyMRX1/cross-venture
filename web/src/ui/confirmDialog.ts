// Reusable accessible confirmation dialog. Never performs mutations itself;
// callers await openConfirmDialog(...) and proceed only when it resolves true.
import { el } from './util';

export interface ConfirmDialogOptions {
  title: string;
  summary: string;
  items: string[];
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  syncNotice?: {
    text: string;
    actionLabel: string;
    onOpenSync: () => void;
  };
}

let nextDialogId = 0;

function restoreFocus(node: unknown): void {
  if (node && typeof (node as { focus?: unknown }).focus === 'function') {
    try {
      (node as { focus: () => void }).focus();
    } catch {
      /* element may have been detached */
    }
  }
}

export function openConfirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;
    const titleId = `confirm-dialog-title-${++nextDialogId}`;

    const listEl = el(
      'ul',
      { class: 'modal-list' },
      ...opts.items.map((item) => el('li', {}, item)),
    );

    const bodyKids: Array<Node | string> = [el('p', {}, opts.summary)];
    if (opts.items.length > 0) bodyKids.push(listEl);

    let syncBtn: HTMLButtonElement | null = null;
    if (opts.syncNotice) {
      syncBtn = el(
        'button',
        { class: 'btn btn-secondary', type: 'button' },
        opts.syncNotice.actionLabel,
      );
      bodyKids.push(
        el('div', { class: 'modal-sync-note' }, el('p', {}, opts.syncNotice.text), syncBtn),
      );
    }

    const cancelBtn = el(
      'button',
      { class: 'btn btn-secondary', type: 'button' },
      opts.cancelLabel ?? 'Cancel',
    );
    const confirmBtn = el(
      'button',
      { class: opts.danger ? 'btn btn-danger' : 'btn btn-primary', type: 'button' },
      opts.confirmLabel,
    );

    const dialog = el(
      'div',
      {
        class: 'modal-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
      },
      el('h2', { class: 'modal-title', id: titleId }, opts.title),
      el('div', { class: 'modal-body' }, ...bodyKids),
      el('div', { class: 'modal-actions' }, cancelBtn, confirmBtn),
    );

    const backdrop = el('div', { class: 'modal-backdrop' }, dialog);

    let settled = false;
    function finish(confirmed: boolean, afterClose?: () => void): void {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      restoreFocus(prevFocus);
      if (afterClose) afterClose();
      resolve(confirmed);
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    }

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });
    if (syncBtn && opts.syncNotice) {
      const openSync = opts.syncNotice.onOpenSync;
      syncBtn.addEventListener('click', () => finish(false, openSync));
    }

    document.addEventListener('keydown', onKeyDown);
    document.body.append(backdrop);
    cancelBtn.focus();
  });
}
