// App entry: Stripe-style shell (top bar + sidebar nav), status chips,
// offline banner, service-worker registration, local workspace restore.
// Must never crash on load even while other workstreams are stubs.
import './styles.css';
import { onDeviceStatus } from './hybrid';
import {
  clearWorkspacesLocal,
  loadAndMigrateWorkspaceLocal,
  saveWorkspaceLocal,
} from './storage/db';
import { removeVentureFromWorkspace } from './storage/workspaceOps';
import { openConfirmDialog } from './ui/confirmDialog';
import { mountDataSettings } from './ui/dataSettings';
import { mountIngest } from './ui/ingest';
import { mountInspector } from './ui/inspector';
import { mountRules } from './ui/rules';
import {
  clearAllRequests,
  loadRequests,
  remapRequestVentureIds,
  removeRequestsForVenture,
  ventureNameOf,
} from './ui/requestModel';
import {
  currentVentureId,
  mountRequests,
  registerVentureSwitcherSync,
  selectVenture,
  syncRequestsFromStorage,
} from './ui/requests';
import { mountSync } from './ui/sync';
import { el, errText, toast } from './ui/util';
import {
  clearSyncedCopyFlag,
  goSync,
  hasSyncedCopy,
  lsGet,
  lsRemove,
  lsSet,
  registerTabSetter,
  store,
} from './ui/state';
import { initThemeToggle } from './ui/theme';
import { initTour } from './ui/tour';
import { mountVentureSwitcherCue, MULTI_VENTURE_HINT_KEY } from './ui/workspaceCue';

const PAGES = ['requests', 'rules', 'documents', 'settings'] as const;
type PageId = (typeof PAGES)[number];
const TAB_KEY = 'cv.tab';

// Old tab ids keep working: cross-links (goTab) and persisted state from
// before the nav redesign map onto the new pages.
const LEGACY_TAB_MAP: Record<string, PageId> = {
  ingest: 'documents',
  simulator: 'requests',
  inspector: 'settings',
  sync: 'settings',
};

function navIconSvg(page: PageId): Element {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'nav-icon');

  const add = (tag: string, attrs: Record<string, string>): void => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.5');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    svg.append(node);
  };

  if (page === 'requests') {
    add('rect', { x: '2.5', y: '3.25', width: '13', height: '11.5', rx: '2' });
    add('path', { d: 'M2.5 10.5H6L7.25 12H10.75L12 10.5H15.5' });
  } else if (page === 'rules') {
    add('path', { d: 'M9 2.25L14.5 4.5V8.75C14.5 12.1 12.1 14.75 9 15.75C5.9 14.75 3.5 12.1 3.5 8.75V4.5L9 2.25Z' });
    add('path', { d: 'M6.75 9L8.25 10.5L11.5 7.25' });
  } else if (page === 'documents') {
    add('path', { d: 'M5 2.5H10.5L13.5 5.5V15.5H5C4.17 15.5 3.5 14.83 3.5 14V4C3.5 3.17 4.17 2.5 5 2.5Z' });
    add('path', { d: 'M10.5 2.5V5.5H13.5' });
    add('path', { d: 'M6.25 9.25H11.25M6.25 12H9.75' });
  } else {
    add('path', { d: 'M3 5.25H15M3 9H15M3 12.75H15' });
    add('circle', { cx: '6.25', cy: '5.25', r: '1.5', fill: 'var(--bg-page)' });
    add('circle', { cx: '11.75', cy: '9', r: '1.5', fill: 'var(--bg-page)' });
    add('circle', { cx: '7.5', cy: '12.75', r: '1.5', fill: 'var(--bg-page)' });
  }
  return svg;
}

function mountNav(): void {
  const btns = PAGES
    .map((id) => document.querySelector<HTMLButtonElement>(`.nav-link[data-page="${id}"]`))
    .filter((b): b is HTMLButtonElement => b !== null);
  const pages = PAGES
    .map((id) => document.getElementById(`page-${id}`))
    .filter((p): p is HTMLElement => p !== null);

  for (const b of btns) {
    const id = b.dataset.page as PageId | undefined;
    if (id && !b.querySelector('.nav-icon')) {
      const label = b.textContent?.trim() ?? '';
      b.replaceChildren(navIconSvg(id), el('span', { class: 'nav-label' }, label));
    }
  }

  function setTab(id: string): void {
    const mapped = LEGACY_TAB_MAP[id] ?? id;
    const target: PageId = (PAGES as readonly string[]).includes(mapped) ? (mapped as PageId) : 'requests';
    for (const b of btns) {
      const on = b.dataset.page === target;
      b.classList.toggle('is-selected', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const p of pages) {
      p.hidden = p.id !== `page-${target}`;
    }
    lsSet(TAB_KEY, target);
  }

  registerTabSetter(setTab);

  for (const b of btns) {
    b.addEventListener('click', () => setTab(b.dataset.page ?? 'requests'));
  }

  const saved = lsGet(TAB_KEY);
  setTab(saved ?? 'requests');
}

const dataSettingsListeners = new Set<() => void>();

function notifyDataSettings(): void {
  for (const fn of [...dataSettingsListeners]) {
    try {
      fn();
    } catch {
      /* isolate listener errors */
    }
  }
}

function setupVentureSwitcher(): void {
  const sel = document.querySelector<HTMLSelectElement>('#ventureSwitch');
  if (!sel) return;
  const cue = mountVentureSwitcherCue(sel, {
    getWorkspace: () => store.workspace,
    getCurrentVentureId: currentVentureId,
    onSelectVenture: (ventureId) => {
      selectVenture(ventureId);
      notifyDataSettings();
    },
  });
  const refreshAll = (): void => {
    cue.refresh();
    notifyDataSettings();
  };
  // Keep switcher, page, and Settings → Data in sync both ways: opening a
  // record from another venture repaints this select through the registered setter.
  registerVentureSwitcherSync(refreshAll);
  store.subscribe(refreshAll);
  refreshAll();
}

function setupDataSettings(): void {
  const settingsPage = document.getElementById('page-settings');
  if (!settingsPage) return;
  let dataRoot = document.getElementById('root-data');
  if (!dataRoot) {
    dataRoot = el('div', { id: 'root-data' });
    const appearance = settingsPage.querySelector('section[aria-labelledby="set-appearance"]');
    if (appearance) settingsPage.insertBefore(dataRoot, appearance);
    else settingsPage.append(dataRoot);
  }
  mountDataSettings(dataRoot, {
    getWorkspace: () => store.workspace,
    getSelectedVentureId: currentVentureId,
    getSelectedVentureName: () => {
      const ws = store.workspace;
      const vid = currentVentureId();
      return ws && vid ? ventureNameOf(ws, vid) || vid : '';
    },
    getVentureDeletionCounts: (ventureId) => {
      const ws = store.workspace;
      const requestCount = loadRequests().filter((r) => r.ventureId === ventureId).length;
      if (!ws) return { docCount: 0, ruleCount: 0, productCount: 0, requestCount };
      const preview = removeVentureFromWorkspace(ws, ventureId);
      return {
        docCount: preview.removedDocs.length,
        ruleCount: preview.removedRuleCount,
        productCount: preview.removedProductCount,
        requestCount,
      };
    },
    getRequestCount: () => loadRequests().length,
    hasSyncedCopy,
    confirm: openConfirmDialog,
    onOpenSync: goSync,
    onRemoveVenture: async (ventureId) => {
      const ws = store.workspace;
      if (!ws) return;
      const { workspace: nextWs } = removeVentureFromWorkspace(ws, ventureId);
      removeRequestsForVenture(ventureId);
      if (nextWs === null) {
        await clearWorkspacesLocal();
        store.setWorkspace(null);
      } else {
        await saveWorkspaceLocal(nextWs);
        store.setWorkspace(nextWs);
      }
      syncRequestsFromStorage();
      notifyDataSettings();
    },
    onClearAllData: async () => {
      await clearWorkspacesLocal();
      clearAllRequests();
      lsRemove('cv.wsId');
      lsRemove(MULTI_VENTURE_HINT_KEY);
      clearSyncedCopyFlag();
      store.setVault(null, null);
      store.setWorkspace(null);
      syncRequestsFromStorage();
      notifyDataSettings();
    },
    subscribe: (listener) => {
      dataSettingsListeners.add(listener);
      const unsubStore = store.subscribe(listener);
      return () => {
        dataSettingsListeners.delete(listener);
        unsubStore();
      };
    },
    onToast: toast,
  });
}

function syncStatusDot(): void {
  const dot = document.getElementById('statusDot');
  const trigger = document.getElementById('statusMenuBtn');
  const dev = document.getElementById('chipDevice');
  const net = document.getElementById('chipNet');
  if (!dot) return;
  const devWarn = dev?.classList.contains('chip--warn') ?? false;
  const netWarn = net?.classList.contains('chip--warn') ?? false;
  const devOk = dev?.classList.contains('chip--ok') ?? false;
  const netOk = net?.classList.contains('chip--ok') ?? false;
  const tone = devWarn || netWarn ? 'status-dot--warn' : devOk && netOk ? 'status-dot--ok' : 'status-dot--muted';
  dot.className = `status-dot ${tone}`;
  if (trigger) {
    const summary = [net?.textContent?.trim(), dev?.textContent?.trim()].filter(Boolean).join(' · ');
    trigger.title = summary || 'Runtime status and theme';
  }
}

function setupStatusMenu(): void {
  const host = document.querySelector<HTMLElement>('.topbar-right');
  if (!host || host.querySelector('#statusMenuBtn')) return;

  const popover = el('div', {
    class: 'status-popover',
    id: 'statusPopover',
    role: 'region',
    'aria-label': 'Runtime status and theme',
  });
  while (host.firstChild) popover.append(host.firstChild);

  const NS = 'http://www.w3.org/2000/svg';
  const chev = document.createElementNS(NS, 'svg');
  chev.setAttribute('width', '12');
  chev.setAttribute('height', '12');
  chev.setAttribute('viewBox', '0 0 12 12');
  chev.setAttribute('fill', 'none');
  chev.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3 4.5L6 7.5L9 4.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  chev.append(path);

  const btn = el(
    'button',
    {
      type: 'button',
      class: 'status-menu-btn',
      id: 'statusMenuBtn',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      'aria-controls': 'statusPopover',
      'aria-label': 'Runtime status and theme',
    },
    el('span', { class: 'status-dot status-dot--muted', id: 'statusDot', 'aria-hidden': 'true' }),
    chev,
  );

  const setOpen = (open: boolean): void => {
    host.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(!host.classList.contains('is-open'));
  });

  document.addEventListener('click', (ev) => {
    if (!host.classList.contains('is-open')) return;
    if (ev.target instanceof Node && host.contains(ev.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && host.classList.contains('is-open')) {
      setOpen(false);
      btn.focus();
    }
  });

  host.append(btn, popover);
  syncStatusDot();
}

function refreshDeviceChip(): void {
  const chip = document.getElementById('chipDevice');
  if (!chip) return;
  void onDeviceStatus()
    .then((st) => {
      chip.className = `chip ${st.available ? 'chip--ok' : 'chip--warn'}`;
      chip.textContent = st.available ? 'ON-DEVICE READY' : 'ON-DEVICE: unavailable';
      chip.title = st.detail;
      syncStatusDot();
    })
    .catch((e: unknown) => {
      chip.className = 'chip chip--warn';
      chip.textContent = 'ON-DEVICE: status check failed';
      chip.title = errText(e);
      syncStatusDot();
    });
}

function setupNetwork(): void {
  const chip = document.getElementById('chipNet');
  const banner = document.getElementById('bannerOffline');
  function refresh(): void {
    const online = navigator.onLine;
    if (chip) {
      chip.className = `chip ${online ? 'chip--ok' : 'chip--warn'}`;
      chip.textContent = online ? 'ONLINE' : 'OFFLINE';
    }
    if (banner) banner.hidden = online;
    syncStatusDot();
  }
  window.addEventListener('online', () => {
    refresh();
    toast('Back online — cloud stages and sync are available again', 'ok');
  });
  window.addEventListener('offline', () => {
    refresh();
    toast('You went offline — local pipeline and margin engine keep working', 'warn');
  });
  refresh();
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const probe = await fetch('/sw.js', { method: 'GET' });
    if (!probe.ok) return;
    const ct = probe.headers.get('content-type') ?? '';
    // Dev servers answer unknown paths with index.html — don't register that.
    if (!/javascript/i.test(ct)) return;
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* no service worker present (WS-3 adds sw.js later) — ignore */
  }
}

function restoreWorkspace(): void {
  void loadAndMigrateWorkspaceLocal()
    .then(({ workspace: ws, migrated, ventureIdMap }) => {
      if (migrated && Object.keys(ventureIdMap).length > 0 && remapRequestVentureIds(ventureIdMap)) {
        syncRequestsFromStorage();
      }
      if (ws && !store.workspace) {
        store.setWorkspace(ws);
        toast(`Restored local workspace “${ws.name}”`, 'ok');
      }
    })
    .catch(() => {
      /* empty cache or unavailable IndexedDB — start with the ingest empty-state */
    });
}

function boot(): void {
  const roots: Array<[string, (root: HTMLElement) => void]> = [
    ['root-simulator', mountRequests],
    ['root-rules', mountRules],
    ['root-ingest', mountIngest],
    ['root-sync', mountSync],
    ['root-inspector', mountInspector],
  ];
  for (const [id, mount] of roots) {
    const node = document.getElementById(id);
    if (node) mount(node);
  }
  mountNav();
  setupVentureSwitcher();
  setupDataSettings();
  setupStatusMenu();
  initThemeToggle();
  refreshDeviceChip();
  setupNetwork();
  void registerServiceWorker();
  restoreWorkspace();
  initTour();
}

try {
  boot();
} catch (e) {
  const box = el('div', { class: 'boot-error' }, `UI failed to start: ${errText(e)}`);
  document.body.append(box);
}
