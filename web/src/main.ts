// App entry: Stripe-style shell (top bar + sidebar nav), status chips,
// offline banner, service-worker registration, local workspace restore.
// Must never crash on load even while other workstreams are stubs.
import './styles.css';
import { onDeviceStatus } from './hybrid';
import { loadWorkspaceLocal } from './storage/db';
import { mountIngest } from './ui/ingest';
import { mountInspector } from './ui/inspector';
import { mountRules } from './ui/rules';
import { mountRequests, currentVentureId, registerVentureSwitcherSync, selectVenture } from './ui/requests';
import { mountSync } from './ui/sync';
import { el, errText, hydrate, toast } from './ui/util';
import { lsGet, lsSet, registerTabSetter, store } from './ui/state';
import { initThemeToggle } from './ui/theme';
import { initTour } from './ui/tour';

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

function mountNav(): void {
  const btns = PAGES
    .map((id) => document.querySelector<HTMLButtonElement>(`.nav-link[data-page="${id}"]`))
    .filter((b): b is HTMLButtonElement => b !== null);
  const pages = PAGES
    .map((id) => document.getElementById(`page-${id}`))
    .filter((p): p is HTMLElement => p !== null);

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

function setupVentureSwitcher(): void {
  const sel = document.querySelector<HTMLSelectElement>('#ventureSwitch');
  if (!sel) return;
  const refresh = (): void => {
    const ws = store.workspace;
    sel.replaceChildren();
    if (!ws || ws.graph.ventures.length === 0) {
      sel.append(el('option', { value: '' }, 'No workspace loaded'));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const current = currentVentureId();
    for (const v of ws.graph.ventures) {
      const opt = el('option', { value: v.venture_id }, hydrate(ws.tokenMap, v.venture_token) || v.venture_id);
      if (v.venture_id === current) opt.selected = true;
      sel.append(opt);
    }
  };
  sel.addEventListener('change', () => selectVenture(sel.value));
  // Keep switcher and page in sync both ways: opening a record from another
  // venture repaints this select through the registered setter.
  registerVentureSwitcherSync(refresh);
  store.subscribe(refresh);
  refresh();
}

function refreshDeviceChip(): void {
  const chip = document.getElementById('chipDevice');
  if (!chip) return;
  void onDeviceStatus()
    .then((st) => {
      chip.className = `chip ${st.available ? 'chip--ok' : 'chip--warn'}`;
      chip.textContent = st.available ? 'ON-DEVICE READY' : 'ON-DEVICE: unavailable';
      chip.title = st.detail;
    })
    .catch((e: unknown) => {
      chip.className = 'chip chip--warn';
      chip.textContent = 'ON-DEVICE: status check failed';
      chip.title = errText(e);
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
  void loadWorkspaceLocal()
    .then((ws) => {
      if (ws && !store.workspace) {
        store.setWorkspace(ws);
        toast(`Restored local workspace “${ws.name}”`, 'ok');
      }
    })
    .catch(() => {
      /* WS-3 stub or empty cache — start with the ingest empty-state */
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
