// Theme toggle (owner pick 2026-11-24, kept through the Stripe restyle).
// Three honest states: auto (follow prefers-color-scheme), light, dark.
// Choice persists in localStorage (cv-theme); the anti-FOUC boot script in
// index.html applies it before first paint. CSS keys off data-theme + media.
// Two controls drive the same mode: the top-bar button (#themeToggle) and
// the Settings → Appearance select (#themeMode).
const KEY = 'cv-theme';
type ThemeMode = 'auto' | 'light' | 'dark';

function currentMode(): ThemeMode {
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    /* private mode — stay on auto */
  }
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function applyMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* persistence unavailable — applies for this session only */
  }
}

export function initThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  const sel = document.querySelector<HTMLSelectElement>('#themeMode');
  if (!btn && !sel) return;
  const paint = (): void => {
    const mode = currentMode();
    if (btn) {
      btn.textContent = `Theme: ${mode === 'auto' ? 'Auto' : mode === 'light' ? 'Light' : 'Dark'}`;
      btn.setAttribute('aria-label', `Switch color theme. Current: ${mode}.`);
    }
    if (sel) sel.value = mode;
  };
  applyMode(currentMode());
  paint();
  if (btn) {
    btn.addEventListener('click', () => {
      const order: ThemeMode[] = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(currentMode()) + 1) % order.length];
      applyMode(next);
      paint();
    });
  }
  if (sel) {
    sel.addEventListener('change', () => {
      const v = sel.value === 'light' || sel.value === 'dark' ? (sel.value as ThemeMode) : 'auto';
      applyMode(v);
      paint();
    });
  }
}
