// First-run product tour (spotlight + tooltip coach marks).
// Self-contained, zero external dependencies, styled with the app's Stripe
// design tokens. Auto-starts once on first visit (persisted in localStorage),
// skippable at any step (Skip button or Esc), and replayable from Settings
// ("Take the tour") or the top-bar "?" button.
import { goTab, lsGet, lsSet } from './state';
import { el } from './util';

export const TOUR_SEEN_KEY = 'cv.tour.v1';

export type TourPage = 'requests' | 'rules' | 'documents' | 'settings';
export type TourPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TourStep {
  id: string;
  page: TourPage;
  target: string;
  title: string;
  body: string;
  placement?: TourPlacement;
}

export interface TourController {
  start(stepIndex?: number): void;
  next(): void;
  back(): void;
  skip(): void;
  finish(): void;
  isActive(): boolean;
  currentIndex(): number;
  destroy(): void;
}

const SAMPLE_BUTTON_SELECTOR = '#root-ingest > .section > .btn-primary';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    page: 'requests',
    target: '.wordmark',
    title: 'Welcome to Cross-Venture',
    body: 'Checks buyer discount requests against your own deal rules before you reply, so you never break a margin floor or partner cap.',
    placement: 'bottom',
  },
  {
    id: 'sample',
    page: 'documents',
    target: SAMPLE_BUTTON_SELECTOR,
    title: 'Try demo companies first',
    body: 'Click Load sample workspace to explore with two ready-made demo companies before adding your own files.',
    placement: 'top',
  },
  {
    id: 'switcher',
    page: 'documents',
    target: '#ventureSwitch',
    title: 'Switch between companies',
    body: 'Pick a company here. Each venture keeps its own deal rules, products, and buyer requests separate.',
    placement: 'bottom',
  },
  {
    id: 'documents',
    page: 'documents',
    target: '#root-ingest .grid-2 > .section:first-child',
    title: 'Add your documents',
    body: 'Upload contracts, meeting notes, or cost sheets here. Your files are read right on this device.',
    placement: 'bottom',
  },
  {
    id: 'rules',
    page: 'rules',
    target: '#root-rules',
    title: 'Review your deal rules',
    body: 'See every discount cap, margin floor, and approval rule found in your documents, each linked to its source.',
    placement: 'bottom',
  },
  {
    id: 'requests',
    page: 'requests',
    target: '#root-simulator .page-header',
    title: 'Check buyer requests live',
    body: "Paste a buyer's message or enter a discount. Cross-Venture checks margin, discount caps, and partner approvals live.",
    placement: 'bottom',
  },
  {
    id: 'privacy',
    page: 'settings',
    target: '#root-inspector',
    title: 'See what leaves your device',
    body: 'Only anonymised text goes to the cloud. Open Settings → Privacy anytime to inspect exactly what was sent.',
    placement: 'top',
  },
  {
    id: 'sync',
    page: 'settings',
    target: '#root-sync > .section:first-child',
    title: 'Take deal rules on your phone',
    body: 'Connect your phone with an encrypted pairing code to check buyer requests even when you are offline.',
    placement: 'bottom',
  },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 12;
const SPOTLIGHT_PAD = 6;
const SPOTLIGHT_RADIUS = 8;

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function prefersReducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, v));
}

function viewportSize(): { vw: number; vh: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const docW = typeof document !== 'undefined' ? document.documentElement?.clientWidth || 0 : 0;
  const docH = typeof document !== 'undefined' ? document.documentElement?.clientHeight || 0 : 0;
  const winW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1440;
  const winH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 900;
  const widths = [winW, docW, vv?.width].filter((n): n is number => typeof n === 'number' && n > 0);
  const heights = [winH, docH, vv?.height].filter((n): n is number => typeof n === 'number' && n > 0);
  return {
    vw: Math.min(...widths),
    vh: Math.min(...heights),
  };
}

/** Build an even-odd SVG path covering the viewport with a rounded hole around `hole`. */
function backdropPath(vw: number, vh: number, hole: Rect | null): string {
  const outer = `M0 0 H${vw} V${vh} H0 Z`;
  if (!hole || hole.width <= 0 || hole.height <= 0) return outer;
  const x = clamp(hole.left - SPOTLIGHT_PAD, 0, vw);
  const y = clamp(hole.top - SPOTLIGHT_PAD, 0, vh);
  const x2 = clamp(hole.right + SPOTLIGHT_PAD, x, vw);
  const y2 = clamp(hole.bottom + SPOTLIGHT_PAD, y, vh);
  const w = x2 - x;
  const h = y2 - y;
  if (w <= 0 || h <= 0) return outer;
  const r = Math.min(SPOTLIGHT_RADIUS, w / 2, h / 2);
  const inner = [
    `M${x + r} ${y}`,
    `H${x + w - r}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `V${y + h - r}`,
    `Q${x + w} ${y + h} ${x + w - r} ${y + h}`,
    `H${x + r}`,
    `Q${x} ${y + h} ${x} ${y + h - r}`,
    `V${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
  return `${outer} ${inner}`;
}

function choosePopoverCoords(
  target: Rect | null,
  popW: number,
  popH: number,
  preferred: TourPlacement,
  vw: number,
  vh: number,
): { left: number; top: number } {
  if (!target || (target.width === 0 && target.height === 0)) {
    return {
      left: clamp((vw - popW) / 2, VIEWPORT_MARGIN, vw - popW - VIEWPORT_MARGIN),
      top: clamp((vh - popH) / 2, VIEWPORT_MARGIN, vh - popH - VIEWPORT_MARGIN),
    };
  }

  const narrow = vw < 640;
  const space: Record<TourPlacement, number> = {
    bottom: vh - (target.bottom + SPOTLIGHT_PAD) - POPOVER_GAP - VIEWPORT_MARGIN,
    top: target.top - SPOTLIGHT_PAD - POPOVER_GAP - VIEWPORT_MARGIN,
    right: vw - (target.right + SPOTLIGHT_PAD) - POPOVER_GAP - VIEWPORT_MARGIN,
    left: target.left - SPOTLIGHT_PAD - POPOVER_GAP - VIEWPORT_MARGIN,
  };

  const candidates: TourPlacement[] = narrow
    ? preferred === 'top'
      ? ['top', 'bottom']
      : ['bottom', 'top']
    : [preferred, opposite(preferred), ...((['bottom', 'top', 'right', 'left'] as const).filter((p) => p !== preferred && p !== opposite(preferred)))];

  const fits = (p: TourPlacement): boolean => (p === 'top' || p === 'bottom' ? space[p] >= popH : space[p] >= popW);
  let side = candidates.find(fits);
  if (!side) {
    // Pick whichever vertical side has more room so the tooltip stays readable.
    side = space.bottom >= space.top ? 'bottom' : 'top';
  }

  let left = 0;
  let top = 0;
  if (side === 'bottom') {
    top = target.bottom + SPOTLIGHT_PAD + POPOVER_GAP;
    left = target.left + target.width / 2 - popW / 2;
  } else if (side === 'top') {
    top = target.top - SPOTLIGHT_PAD - POPOVER_GAP - popH;
    left = target.left + target.width / 2 - popW / 2;
  } else if (side === 'right') {
    left = target.right + SPOTLIGHT_PAD + POPOVER_GAP;
    top = target.top + target.height / 2 - popH / 2;
  } else {
    left = target.left - SPOTLIGHT_PAD - POPOVER_GAP - popW;
    top = target.top + target.height / 2 - popH / 2;
  }

  return {
    left: clamp(left, VIEWPORT_MARGIN, vw - popW - VIEWPORT_MARGIN),
    top: clamp(top, VIEWPORT_MARGIN, vh - popH - VIEWPORT_MARGIN),
  };
}

function opposite(p: TourPlacement): TourPlacement {
  if (p === 'top') return 'bottom';
  if (p === 'bottom') return 'top';
  if (p === 'left') return 'right';
  return 'left';
}

function mountTriggers(onReplay: () => void): () => void {
  const cleanups: Array<() => void> = [];

  // Top-bar "?" button
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight && !document.getElementById('tourHelpBtn')) {
    const helpBtn = el(
      'button',
      {
        type: 'button',
        id: 'tourHelpBtn',
        class: 'tour-help-btn',
        'aria-label': 'Take the product tour',
        title: 'Take the product tour',
      },
      '?',
    );
    const onClick = (): void => onReplay();
    helpBtn.addEventListener('click', onClick);
    topbarRight.append(helpBtn);
    cleanups.push(() => {
      helpBtn.removeEventListener('click', onClick);
      helpBtn.remove();
    });
  }

  // Settings → "Take the tour" section
  const settingsPage = document.getElementById('page-settings');
  if (settingsPage && !document.getElementById('tourSettingsSection')) {
    const replayBtn = el('button', { type: 'button', id: 'tourReplayBtn', class: 'btn btn-secondary' }, 'Take the tour');
    const onClick = (): void => onReplay();
    replayBtn.addEventListener('click', onClick);
    const sec = el(
      'section',
      { id: 'tourSettingsSection', class: 'section', 'aria-labelledby': 'set-tour' },
      el('h2', { class: 'section-title', id: 'set-tour' }, 'Product tour'),
      el('p', { class: 'hint' }, 'Walk through documents, deal rules, live request checks, privacy, and phone sync.'),
      el('div', { class: 'btn-row' }, replayBtn),
    );
    settingsPage.append(sec);
    cleanups.push(() => {
      replayBtn.removeEventListener('click', onClick);
      sec.remove();
    });
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}

export function initTour(): TourController {
  let active = false;
  let index = 0;
  let layer: HTMLElement | null = null;
  let backdropSvg: Element | null = null;
  let backdropPathEl: Element | null = null;
  let ringEl: HTMLElement | null = null;
  let popoverEl: HTMLElement | null = null;
  let repositionTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRepositionTimer(): void {
    if (repositionTimer !== null) {
      clearTimeout(repositionTimer);
      repositionTimer = null;
    }
  }

  function removeLayer(): void {
    clearRepositionTimer();
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
    if (layer) {
      layer.remove();
      layer = null;
    }
    backdropSvg = null;
    backdropPathEl = null;
    ringEl = null;
    popoverEl = null;
  }

  function close(reason: 'skipped' | 'done'): void {
    lsSet(TOUR_SEEN_KEY, reason);
    active = false;
    removeLayer();
  }

  function findTarget(step: TourStep): HTMLElement | null {
    return document.querySelector<HTMLElement>(step.target);
  }

  function positionCurrent(): void {
    if (!active || !popoverEl || !backdropSvg || !backdropPathEl || !ringEl) return;
    const step = TOUR_STEPS[index];
    const target = findTarget(step);
    const { vw, vh } = viewportSize();

    const svgBox = typeof backdropSvg.getBoundingClientRect === 'function' ? backdropSvg.getBoundingClientRect() : null;
    const svgW = svgBox && svgBox.width > 0 ? svgBox.width : vw;
    const svgH = svgBox && svgBox.height > 0 ? svgBox.height : vh;
    const svgLeft = svgBox ? svgBox.left : 0;
    const svgTop = svgBox ? svgBox.top : 0;

    backdropSvg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    backdropSvg.setAttribute('preserveAspectRatio', 'none');

    let rect: Rect | null = null;
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        rect = {
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      }
    }

    const svgHole: Rect | null = rect
      ? {
          top: rect.top - svgTop,
          left: rect.left - svgLeft,
          right: rect.right - svgLeft,
          bottom: rect.bottom - svgTop,
          width: rect.width,
          height: rect.height,
        }
      : null;

    backdropPathEl.setAttribute('d', backdropPath(svgW, svgH, svgHole));

    if (rect) {
      const x = clamp(rect.left - SPOTLIGHT_PAD, 0, vw);
      const y = clamp(rect.top - SPOTLIGHT_PAD, 0, vh);
      const x2 = clamp(rect.right + SPOTLIGHT_PAD, x, vw);
      const y2 = clamp(rect.bottom + SPOTLIGHT_PAD, y, vh);
      ringEl.hidden = false;
      ringEl.style.left = `${x}px`;
      ringEl.style.top = `${y}px`;
      ringEl.style.width = `${Math.max(0, x2 - x)}px`;
      ringEl.style.height = `${Math.max(0, y2 - y)}px`;
    } else {
      ringEl.hidden = true;
    }

    const maxPopW = Math.min(360, Math.max(220, vw - VIEWPORT_MARGIN * 2));
    popoverEl.style.maxWidth = `${maxPopW}px`;
    const popRect = popoverEl.getBoundingClientRect();
    const popW = popRect.width > 0 ? Math.min(popRect.width, maxPopW) : maxPopW;
    const popH = popRect.height > 0 ? popRect.height : 180;
    const coords = choosePopoverCoords(rect, popW, popH, step.placement ?? 'bottom', vw, vh);
    popoverEl.style.left = `${Math.round(coords.left)}px`;
    popoverEl.style.top = `${Math.round(coords.top)}px`;
  }

  function onViewportChange(): void {
    positionCurrent();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      skip();
    } else if (e.key === 'ArrowRight' && index < TOUR_STEPS.length - 1) {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      back();
    }
  }

  function ensureLayer(): void {
    if (layer) return;
    layer = el('div', { class: 'tour-layer', 'data-tour-active': 'true' });

    backdropSvg = document.createElementNS(SVG_NS, 'svg');
    backdropSvg.setAttribute('class', 'tour-backdrop');
    backdropSvg.setAttribute('aria-hidden', 'true');
    backdropPathEl = document.createElementNS(SVG_NS, 'path');
    backdropPathEl.setAttribute('class', 'tour-backdrop-path');
    backdropPathEl.setAttribute('fill-rule', 'evenodd');
    backdropSvg.append(backdropPathEl);

    ringEl = el('div', { class: 'tour-ring', 'aria-hidden': 'true' });

    popoverEl = el('div', {
      class: 'tour-popover',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tourTitle',
      'aria-describedby': 'tourBody',
      tabindex: '-1',
    });

    layer.append(backdropSvg, ringEl, popoverEl);
    document.body.append(layer);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
  }

  function renderStep(): void {
    if (!active) return;
    const step = TOUR_STEPS[index];
    goTab(step.page);
    ensureLayer();

    const target = findTarget(step);
    if (target) {
      const r = target.getBoundingClientRect();
      const { vh } = viewportSize();
      const topSafe = step.target === '.wordmark' || step.target === '#ventureSwitch' ? 0 : 72;
      const bottomSafe = vh - 72;
      const outOfView = r.top < topSafe || r.bottom > bottomSafe;
      if (outOfView) {
        if (typeof window.scrollTo === 'function') {
          const scrollY = window.scrollY || window.pageYOffset || 0;
          const docTop = r.top + scrollY;
          const desired = Math.max(0, docTop - Math.max(88, Math.round((vh - r.height) / 2)));
          window.scrollTo({ top: desired, behavior: 'auto' });
        } else if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        }
      }
    }

    const isFirst = index === 0;
    const isLast = index === TOUR_STEPS.length - 1;

    const closeBtn = el('button', { type: 'button', class: 'tour-close', 'aria-label': 'Close tour' }, '×');
    closeBtn.addEventListener('click', () => skip());

    const skipBtn = el('button', { type: 'button', class: 'tour-skip' }, 'Skip');
    skipBtn.addEventListener('click', () => skip());

    const backBtn = el('button', { type: 'button', class: 'btn btn-secondary tour-back' }, 'Back');
    if (isFirst) backBtn.hidden = true;
    backBtn.addEventListener('click', () => back());

    const primaryBtn = el(
      'button',
      { type: 'button', class: 'btn btn-primary tour-next' },
      isLast ? 'Load sample workspace' : 'Next',
    );
    primaryBtn.addEventListener('click', () => {
      if (isLast) finish();
      else next();
    });

    popoverEl!.replaceChildren(
      el(
        'div',
        { class: 'tour-head' },
        el('span', { class: 'tour-progress' }, `${index + 1} of ${TOUR_STEPS.length}`),
        closeBtn,
      ),
      el('h2', { id: 'tourTitle', class: 'tour-title' }, step.title),
      el('p', { id: 'tourBody', class: 'tour-body' }, step.body),
      el(
        'div',
        { class: 'tour-foot' },
        skipBtn,
        el('div', { class: 'tour-actions' }, backBtn, primaryBtn),
      ),
    );

    positionCurrent();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => positionCurrent());
    }
    clearRepositionTimer();
    if (!prefersReducedMotion()) {
      repositionTimer = setTimeout(() => positionCurrent(), 120);
    }
    try {
      primaryBtn.focus({ preventScroll: true });
    } catch {
      primaryBtn.focus();
    }
  }

  function start(stepIndex = 0): void {
    index = clamp(stepIndex, 0, TOUR_STEPS.length - 1);
    active = true;
    renderStep();
  }

  function next(): void {
    if (!active) return;
    if (index < TOUR_STEPS.length - 1) {
      index += 1;
      renderStep();
    } else {
      finish();
    }
  }

  function back(): void {
    if (!active || index <= 0) return;
    index -= 1;
    renderStep();
  }

  function skip(): void {
    if (!active) return;
    close('skipped');
  }

  function finish(): void {
    if (!active) return;
    close('done');
    goTab('documents');
    const sampleBtn = document.querySelector<HTMLButtonElement>(SAMPLE_BUTTON_SELECTOR);
    if (sampleBtn) {
      if (typeof sampleBtn.scrollIntoView === 'function') {
        sampleBtn.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
      sampleBtn.click();
    }
  }

  const unmountTriggers = mountTriggers(() => start(0));

  if (lsGet(TOUR_SEEN_KEY) === null) {
    start(0);
  }

  return {
    start,
    next,
    back,
    skip,
    finish,
    isActive: () => active,
    currentIndex: () => index,
    destroy: () => {
      active = false;
      removeLayer();
      unmountTriggers();
    },
  };
}
