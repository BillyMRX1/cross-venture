// QR phone pairing: backward-compatible payload codec, local SVG QR renderer,
// and security-gated pairing panel (click to show, blurred until revealed,
// auto-hides after 2 minutes or leaving Settings, copyable fallback string).
import qrcode from 'qrcode-generator';
import { el, errText, type NoteKind } from './util';

export const PAIRING_AUTO_HIDE_MS = 2 * 60 * 1000;
export const PAIRING_WARNING_COPY = 'Anyone who scans this can read your synced data.';
export const PAIRING_STEPS = [
  'Open Cross-Venture on your phone',
  'Tap Scan',
  'Point at this code',
] as const;

const SVG_NS = 'http://www.w3.org/2000/svg';
const WS_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface PairingPayload {
  wsId: string;
  key: string;
}

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export interface PairingPanelOptions {
  generatePayload: () => Promise<string>;
  onCopy?: (value: string) => void;
  onStatus?: (kind: NoteKind, text: string) => void;
  autoHideMs?: number;
  observeLeaveRoot?: HTMLElement | null;
}

export interface PairingPanelHandle {
  element: HTMLElement;
  hide: (reason?: 'timeout' | 'leave' | 'manual') => void;
  isOpen: () => boolean;
  isRevealed: () => boolean;
  destroy: () => void;
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === 'function') {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const Buf = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (!Buf) throw new Error('No base64url encoder available');
  return Buf.from(bytes).toString('base64url');
}

function b64urlDecode(s: string): string {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  const Buf = (globalThis as unknown as { Buffer?: { from(input: string, enc: string): Uint8Array } }).Buffer;
  if (!Buf) throw new Error('No base64url decoder available');
  return new TextDecoder().decode(Buf.from(padded, 'base64'));
}

/**
 * Encodes { wsId, key } in the exact backward-compatible base64url JSON format
 * accepted by web pullAndDecrypt() and Android Pairing.parse().
 */
export function encodePairingPayload(payload: PairingPayload): string {
  const wsId = payload.wsId.trim();
  const key = payload.key.trim();
  if (!WS_ID_RE.test(wsId)) {
    throw new Error('Invalid workspace id for pairing payload');
  }
  if (!B64URL_RE.test(key)) {
    throw new Error('Invalid vault key for pairing payload');
  }
  return b64urlEncode(JSON.stringify({ wsId, key }));
}

/**
 * Decodes a base64url({ wsId, key }) pairing string, enforcing the same
 * contract as Android Pairing.parse().
 */
export function decodePairingPayload(pairString: string): PairingPayload {
  const trimmed = pairString.trim();
  if (!trimmed) throw new Error('Pairing string is empty');
  if (!B64URL_RE.test(trimmed)) throw new Error('Pairing string is not base64url');

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(trimmed));
  } catch (e) {
    throw new Error(`Invalid pairing payload JSON: ${errText(e)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pairing payload must be a JSON object');
  }
  const obj = parsed as { wsId?: unknown; key?: unknown };
  if (typeof obj.wsId !== 'string' || !WS_ID_RE.test(obj.wsId)) {
    throw new Error('Pairing payload has invalid or missing wsId');
  }
  if (typeof obj.key !== 'string' || !B64URL_RE.test(obj.key)) {
    throw new Error('Pairing payload has invalid or missing key');
  }
  return { wsId: obj.wsId, key: obj.key };
}

/** Generates a QR module matrix locally using qrcode-generator (zero network). */
export function buildQrMatrix(data: string): QrMatrix {
  if (!data) throw new Error('QR payload is empty');
  const qr = qrcode(0, 'M');
  qr.addData(data, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) {
      line.push(qr.isDark(row, col));
    }
    modules.push(line);
  }
  return { size, modules };
}

function buildQrSvgGeometry(data: string, quietZone = 4): { total: number; pathD: string } {
  const { size, modules } = buildQrMatrix(data);
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    const line = modules[row];
    let col = 0;
    while (col < size) {
      if (!line[col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < size && line[col]) col += 1;
      const run = col - start;
      parts.push(`M${start + quietZone} ${row + quietZone}h${run}v1h-${run}z`);
    }
  }
  return { total: size + quietZone * 2, pathD: parts.join('') };
}

/** Pure SVG string for local QR rendering (always white quiet zone + dark modules for reliable scanning). */
export function renderQrSvgString(data: string, quietZone = 4): string {
  const { total, pathD } = buildQrSvgGeometry(data, quietZone);
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${total} ${total}" ` +
    `role="img" aria-label="Phone pairing QR code" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${pathD}" fill="#1a1b25"/>` +
    `</svg>`
  );
}

/** Creates an <svg> element directly via DOM APIs (no innerHTML). */
export function createQrSvgElement(data: string, quietZone = 4): SVGSVGElement {
  const { total, pathD } = buildQrSvgGeometry(data, quietZone);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Phone pairing QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('style', 'display:block;width:100%;height:100%');

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', '#ffffff');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', '#1a1b25');

  svg.append(bg, path);
  return svg;
}

/**
 * Mounts the one-button "Connect your phone" QR pairing experience.
 * Security guarantees:
 * - No QR or key is rendered until the user clicks "Connect your phone".
 * - QR renders blurred until the user explicitly taps "Show code".
 * - Automatically hides and clears the QR + fallback string after 2 minutes
 *   or when the user leaves Settings / backgrounds the tab.
 */
export function mountPairingPanel(options: PairingPanelOptions): PairingPanelHandle {
  const autoHideMs = options.autoHideMs ?? PAIRING_AUTO_HIDE_MS;
  let open = false;
  let revealed = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const connectBtn = el(
    'button',
    { type: 'button', class: 'btn btn-primary', id: 'connectPhoneBtn' },
    'Connect your phone',
  );

  const qrHost = el('div', {
    id: 'pairingQrHost',
    'data-revealed': 'false',
    'aria-hidden': 'true',
    style: 'width:100%;height:100%;filter:blur(10px);transition:filter var(--t-fast) var(--ease);user-select:none',
  });

  const showBtn = el(
    'button',
    { type: 'button', class: 'btn btn-primary', id: 'showQrBtn' },
    'Show code',
  );

  const qrOverlay = el(
    'div',
    {
      id: 'pairingQrOverlay',
      style:
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:color-mix(in srgb, var(--bg-page) 55%, transparent)',
    },
    showBtn,
  );

  const qrFrame = el(
    'div',
    {
      style:
        'position:relative;width:224px;height:224px;flex-shrink:0;' +
        'border:1px solid var(--border-subtle);border-radius:var(--radius);' +
        'overflow:hidden;background:var(--bg-page)',
    },
    qrHost,
    qrOverlay,
  );

  const stepsList = el(
    'ol',
    {
      id: 'pairingSteps',
      style:
        'margin:0 0 var(--sp-3);padding-left:var(--sp-4);display:flex;flex-direction:column;' +
        'gap:var(--sp-2);color:var(--text-primary);font-size:var(--f-base)',
    },
    ...PAIRING_STEPS.map((step) => el('li', {}, step)),
  );

  const warningLine = el(
    'p',
    {
      id: 'pairingWarning',
      class: 'note note--warn',
      style: 'margin:0 0 var(--sp-3)',
    },
    PAIRING_WARNING_COPY,
  );

  const cantScanLink = el(
    'button',
    {
      type: 'button',
      class: 'link',
      id: 'cantScanLink',
      'aria-expanded': 'false',
      style: 'font-size:var(--f-sm)',
    },
    "Can't scan?",
  );

  const hideBtn = el(
    'button',
    { type: 'button', class: 'btn btn-secondary', id: 'hideQrBtn' },
    'Hide code',
  );

  const controlsRow = el(
    'div',
    {
      style: 'display:flex;align-items:center;gap:var(--sp-4);flex-wrap:wrap',
    },
    cantScanLink,
    hideBtn,
  );

  const autoHideHint = el(
    'p',
    { class: 'hint', style: 'margin:var(--sp-2) 0 0' },
    'Hides automatically after 2 minutes.',
  );

  const guideCol = el(
    'div',
    { style: 'flex:1 1 240px;min-width:0' },
    stepsList,
    warningLine,
    controlsRow,
    autoHideHint,
  );

  const qrRow = el(
    'div',
    {
      style: 'display:flex;flex-wrap:wrap;gap:var(--sp-5);align-items:flex-start',
    },
    qrFrame,
    guideCol,
  );

  const pairingBox = el('textarea', {
    class: 'pairing',
    id: 'pairingValue',
    readonly: '',
    spellcheck: 'false',
    'aria-label': 'Pairing string — copy into the phone app',
  });

  const copyBtn = el(
    'button',
    { type: 'button', class: 'btn btn-secondary', id: 'copyPairingBtn' },
    'Copy pairing string',
  );

  const fallbackBox = el(
    'div',
    {
      id: 'pairingFallback',
      hidden: '',
      style: 'margin-top:var(--sp-3);padding-top:var(--sp-3);border-top:1px solid var(--border-subtle)',
    },
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'pairingValue' }, 'Pairing string'),
      pairingBox,
      el('div', { class: 'btn-row' }, copyBtn),
    ),
  );

  const panel = el(
    'div',
    {
      id: 'pairingPanel',
      hidden: '',
      style: 'margin-top:var(--sp-4)',
    },
    qrRow,
    fallbackBox,
  );

  const container = el('div', {}, connectBtn, panel);

  function clearTimer(): void {
    if (hideTimer !== null) {
      globalThis.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function setBlurred(blurred: boolean): void {
    revealed = !blurred;
    qrHost.setAttribute('data-revealed', revealed ? 'true' : 'false');
    qrHost.style.filter = blurred ? 'blur(10px)' : 'none';
    if (blurred) qrHost.setAttribute('aria-hidden', 'true');
    else qrHost.removeAttribute('aria-hidden');
    qrOverlay.hidden = !blurred;
  }

  function setFallbackExpanded(expanded: boolean): void {
    fallbackBox.hidden = !expanded;
    cantScanLink.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function hide(reason: 'timeout' | 'leave' | 'manual' = 'manual'): void {
    clearTimer();
    const wasOpen = open;
    open = false;
    panel.hidden = true;
    qrHost.replaceChildren();
    pairingBox.value = '';
    setBlurred(true);
    setFallbackExpanded(false);
    if (wasOpen && reason === 'timeout') {
      options.onStatus?.('note', 'Pairing code hidden after 2 minutes. Click Connect your phone to show it again.');
    }
  }

  function startAutoHideTimer(): void {
    clearTimer();
    hideTimer = globalThis.setTimeout(() => {
      hide('timeout');
    }, autoHideMs);
  }

  connectBtn.addEventListener('click', () => {
    void (async () => {
      connectBtn.disabled = true;
      options.onStatus?.('note', 'Preparing pairing code on this device…');
      try {
        const payload = await options.generatePayload();
        const svg = createQrSvgElement(payload);
        qrHost.replaceChildren(svg);
        pairingBox.value = payload;
        setBlurred(true);
        setFallbackExpanded(false);
        panel.hidden = false;
        open = true;
        startAutoHideTimer();
        options.onStatus?.('note--ok', 'Pairing code ready — tap Show code to reveal and scan.');
      } catch (e) {
        hide('manual');
        options.onStatus?.('note--err', `Vault unavailable: ${errText(e)}`);
      } finally {
        connectBtn.disabled = false;
      }
    })();
  });

  showBtn.addEventListener('click', () => {
    if (!open) return;
    setBlurred(false);
  });

  hideBtn.addEventListener('click', () => {
    hide('manual');
    options.onStatus?.('note', 'Pairing code hidden.');
  });

  cantScanLink.addEventListener('click', () => {
    setFallbackExpanded(fallbackBox.hidden);
  });

  copyBtn.addEventListener('click', () => {
    if (!pairingBox.value) return;
    options.onCopy?.(pairingBox.value);
  });

  // Hide automatically when leaving Settings (page-settings gets hidden=true)
  // or when the browser tab becomes hidden.
  let observer: MutationObserver | null = null;
  const leaveTarget = options.observeLeaveRoot ?? null;
  if (leaveTarget && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (leaveTarget.hidden && open) hide('leave');
    });
    observer.observe(leaveTarget, { attributes: true, attributeFilter: ['hidden'] });
  }

  const onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.hidden && open) {
      hide('leave');
    }
  };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const onPageHide = (): void => {
    if (open) hide('leave');
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', onPageHide);
  }

  function destroy(): void {
    clearTimer();
    observer?.disconnect();
    observer = null;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', onPageHide);
    }
  }

  return {
    element: container,
    hide,
    isOpen: () => open,
    isRevealed: () => revealed,
    destroy,
  };
}
