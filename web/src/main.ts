// WS-4 app entry: tab shell (persisted, keyboard-accessible), status chips,
// offline banner, service-worker registration, local workspace restore.
// Must never crash on load even while other workstreams are stubs.
import './styles.css';
import { onDeviceStatus } from './hybrid';
import { loadWorkspaceLocal } from './storage/db';
import { mountIngest } from './ui/ingest';
import { mountInspector } from './ui/inspector';
import { mountSimulator } from './ui/simulator';
import { mountSync } from './ui/sync';
import { el, errText, toast } from './ui/util';
import { lsGet, lsSet, registerTabSetter, store } from './ui/state';
import { initThemeToggle } from './ui/theme';

const TABS = ['ingest', 'inspector', 'sync', 'simulator'] as const;
type TabId = (typeof TABS)[number];
const TAB_KEY = 'cv.tab';

function mountTabs(): void {
  const btns = TABS.map((id) => document.getElementById(`tabbtn-${id}`)).filter((b): b is HTMLButtonElement => b !== null);
  const panels = TABS.map((id) => document.getElementById(`tab-${id}`)).filter((p): p is HTMLElement => p !== null);
  const tablist = document.querySelector<HTMLElement>('.tabs[role="tablist"]');

  function setTab(id: string): void {
    const target = (TABS as readonly string[]).includes(id) ? (id as TabId) : 'ingest';
    for (const b of btns) {
      const on = b.dataset.tab === target;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of panels) {
      p.hidden = p.id !== `tab-${target}`;
    }
    lsSet(TAB_KEY, target);
  }

  registerTabSetter(setTab);

  for (const b of btns) {
    b.setAttribute('aria-selected', 'false');
    b.tabIndex = -1;
    b.addEventListener('click', () => setTab(b.dataset.tab ?? 'ingest'));
  }

  if (tablist) {
    tablist.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      const current = btns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      let next = current;
      if (ev.key === 'ArrowRight') next = (current + 1 + btns.length) % btns.length;
      else if (ev.key === 'ArrowLeft') next = (current - 1 + btns.length) % btns.length;
      else if (ev.key === 'Home') next = 0;
      else next = btns.length - 1;
      const b = btns[next];
      if (!b) return;
      ev.preventDefault();
      setTab(b.dataset.tab ?? 'ingest');
      b.focus();
    });
  }

  const saved = lsGet(TAB_KEY);
  setTab(saved ?? 'ingest');
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
    ['tab-ingest', mountIngest],
    ['tab-inspector', mountInspector],
    ['tab-sync', mountSync],
    ['tab-simulator', mountSimulator],
  ];
  for (const [id, mount] of roots) {
    const node = document.getElementById(id);
    if (node) mount(node);
  }
  mountTabs();
  initThemeToggle();
  refreshDeviceChip();
  setupNetwork();
  void registerServiceWorker();
  restoreWorkspace();
}

try {
  boot();
} catch (e) {
  const box = el('div', { class: 'boot-error' }, `UI failed to start: ${errText(e)}`);
  document.body.append(box);
}
