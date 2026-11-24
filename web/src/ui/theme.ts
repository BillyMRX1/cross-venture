// Manual theme toggle (owner pick 2026-11-24). Three honest states:
// auto (follow prefers-color-scheme), light (concept A), dark (concept B).
// Choice persists in localStorage (cv-theme); the anti-FOUC boot script in
// index.html applies it before first paint. CSS keys off data-theme + media.
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
  if (!btn) return;
  const paint = (): void => {
    const mode = currentMode();
    btn.textContent = `THEME: ${mode.toUpperCase()}`;
    btn.setAttribute('aria-label', `Switch color theme. Current: ${mode}.`);
  };
  applyMode(currentMode());
  paint();
  btn.addEventListener('click', () => {
    const order: ThemeMode[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(currentMode()) + 1) % order.length];
    applyMode(next);
    paint();
  });
}
