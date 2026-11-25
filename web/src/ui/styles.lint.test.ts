import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design contract v3 (owner pick 2026-11-24: Stripe Dashboard style).
// White page, hairline dividers, unboxed stacked sections, purple accent.
// Light is the default; DARK is the same token vocabulary with dark neutrals
// and the same purple — modes are TOKEN SETS ONLY. Fonts are self-hosted from
// /fonts/ (Source Sans 3 + Source Code Pro, OFL); external font URLs are a red.
// If anyone re-introduces one-off hexes, an external font, a boxed-card shell,
// or breaks the light/dark vocabulary symmetry, red here.

// Read from disk rather than a ?raw import: vitest stubs CSS modules to ''
// unless css handling is enabled, and the contract wants the real text.
const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const mainTs = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');
const stateTs = readFileSync(resolve(__dirname, 'state.ts'), 'utf8');

// Palette blocks = any :root-anchored custom-property block (light default,
// media dark, explicit [data-theme] variant). Everything else must be hex-free.
function paletteBlocks(src: string): string[] {
  return src.match(/:root[^{]*\{[^}]*\}/g) ?? [];
}
function stripPaletteBlocks(src: string): string {
  return src.replace(/:root[^{]*\{[^}]*\}/g, '');
}
function propsIn(block: string): string[] {
  return [...block.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

const light = paletteBlocks(css).find((b) => b.includes('--bg-page: #ffffff'));
const dark = paletteBlocks(css).filter((b) => b.includes('--bg-page: #101118'));

// Signature tokens, verbatim from the picked mock (cv-stripe.html).
const LIGHT_SIG = [
  '#ffffff', '#ebeef1', '#d5dbe1', '#1a1b25', '#30313d', '#414552', '#5c6676', '#5851f0',
  '#635bff', '#5349f5', '#f5f6ff', '#ffe7f2', '#b3093c', '#d7f7c2', '#006908',
  '#fcedb9', '#a82c00', '#ebeef1',
];

describe('stripe palette contract (light default, dark token set)', () => {
  it('has a light default block with the picked-mock colors', () => {
    expect(light, 'light palette block (--bg-page: #ffffff) required').toBeTruthy();
    for (const sig of LIGHT_SIG) expect(light!, `light block must carry ${sig}`).toContain(sig);
  });

  it('has dark blocks for BOTH prefers-color-scheme and explicit [data-theme="dark"]', () => {
    expect(dark.length, 'dark must serve the media query AND the manual toggle').toBeGreaterThanOrEqual(2);
    for (const b of dark) expect(b, 'same purple in dark mode').toContain('#635bff');
  });

  it('dark vocabulary equals light vocabulary (modes are token sets only)', () => {
    for (const b of dark) expect(propsIn(b), 'vocabulary must match across modes').toEqual(propsIn(light!));
  });

  it('no raw hex colors outside palette blocks', () => {
    const hits = stripPaletteBlocks(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits, `raw hex outside :root palette blocks: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('token contract', () => {
  const tokens = [
    '--bg-page', '--bg-soft', '--bg-inset', '--border-subtle', '--border-control',
    '--text-primary', '--text-body', '--text-nav', '--text-secondary',
    '--brand', '--brand-hover', '--brand-tint', '--brand-text', '--on-brand',
    '--danger-bg', '--danger-text', '--danger-border',
    '--success-bg', '--success-text', '--warning-bg', '--warning-text', '--neutral-bg',
    '--font-sans', '--font-mono', '--focus', '--ring',
    '--radius', '--radius-sm', '--radius-pill',
  ];
  it.each(tokens)('%s is defined', (token: string) => {
    expect(css, `token ${token} must be defined`).toContain(`${token}:`);
  });
});

describe('self-hosted fonts (no external URLs, ever)', () => {
  const files = [
    'source-sans-3-latin-400-normal.woff2',
    'source-sans-3-latin-600-normal.woff2',
    'source-sans-3-latin-700-normal.woff2',
    'source-code-pro-latin-400-normal.woff2',
    'source-code-pro-latin-500-normal.woff2',
  ];
  it.each(files)('css loads /fonts/%s', (file: string) => {
    expect(css, `must reference /fonts/${file}`).toContain(`url(/fonts/${file})`);
  });

  it('five @font-face rules, all font-display: swap', () => {
    expect((css.match(/@font-face\s*\{/g) ?? []).length).toBe(5);
    expect((css.match(/font-display:\s*swap/g) ?? []).length).toBe(5);
  });

  it('no external font URLs in css or index.html (no Google Fonts, no @import)', () => {
    expect(css).not.toMatch(/https?:/);
    expect(css).not.toMatch(/@import/);
    expect(css.match(/url\((?!["']?\/fonts\/)/g) ?? []).toEqual([]);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)/);
    expect(html.match(/<link[^>]+href=["']https?:/g) ?? []).toEqual([]);
  });

  it('token font stacks name the self-hosted families', () => {
    expect(css).toMatch(/--font-sans:\s*'Source Sans 3'/);
    expect(css).toMatch(/--font-mono:\s*'Source Code Pro'/);
  });
});

describe('accessibility law', () => {
  it('visible focus ring is 2px solid the brand color', () => {
    expect(css).toMatch(/--focus:\s*2px solid var\(--brand\)/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus\)/);
  });

  it('supports prefers-reduced-motion and :focus-visible', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('index.html keeps labels/roles: nav landmark, labeled switcher/search, aria-live toasts', () => {
    expect(html).toMatch(/<nav class="sidebar" aria-label="Primary navigation">/);
    expect(html).toMatch(/<select id="ventureSwitch" class="venture-switcher" aria-label="Switch venture">/);
    expect(html).toMatch(/class="search-input" placeholder="Search" aria-label=/);
    expect(html).toMatch(/id="toasts" role="status" aria-live="polite"/);
  });
});

describe('shell law (top bar + sidebar nav, replacing the old tab bar)', () => {
  it('exactly four nav links: Requests, Rules, Documents, Settings', () => {
    expect((html.match(/class="nav-link"/g) ?? []).length).toBe(4);
    for (const p of ['requests', 'rules', 'documents', 'settings']) {
      expect(html, `nav item ${p} required`).toMatch(new RegExp(`data-page="${p}">[^<]+</button>`));
    }
    expect(html).toMatch(/data-page="requests">Requests<\/button>/);
    expect(html).toMatch(/data-page="rules">Rules<\/button>/);
    expect(html).toMatch(/data-page="documents">Documents<\/button>/);
    expect(html).toMatch(/data-page="settings">Settings<\/button>/);
  });

  it('old tab bar is gone (no role="tablist", no .tabs/.tab chrome)', () => {
    expect(html).not.toMatch(/role="tablist"/);
    expect(html).not.toMatch(/class="tabs"/);
  });

  it('top bar has wordmark, venture switcher, search field, theme toggle', () => {
    expect(html).toMatch(/class="wordmark"[\s\S]*Cross-Venture/);
    expect(html).toMatch(/id="ventureSwitch"/);
    expect(html).toMatch(/class="search-input"/);
    expect(html).toMatch(/id="themeToggle"/);
  });

  it('nav selection = brand tint + brand text (Stripe selected-item anatomy)', () => {
    const sel = css.match(/\.nav-link\.is-selected\s*\{[^}]*\}/);
    expect(sel, '.nav-link.is-selected rule required').toBeTruthy();
    expect(sel![0]).toMatch(/background:\s*var\(--brand-tint\)/);
    expect(sel![0]).toMatch(/color:\s*var\(--brand-text\)/);
    const nav = css.match(/\.nav-link\s*\{[^}]*\}/);
    expect(nav![0]).toMatch(/color:\s*var\(--text-nav\)/);
  });

  it('legacy tab ids map onto the new pages (goTab keeps working)', () => {
    expect(mainTs).toContain("ingest: 'documents'");
    expect(mainTs).toContain("simulator: 'requests'");
    expect(mainTs).toContain("inspector: 'settings'");
    expect(mainTs).toContain("sync: 'settings'");
    expect(mainTs).toMatch(/registerTabSetter\(setTab\)/);
    expect(stateTs).toMatch(/export function registerTabSetter/);
    expect(stateTs).toMatch(/export function goTab/);
  });

  it('pages mount every former screen under the new nav', () => {
    for (const rootId of ['root-simulator', 'root-rules', 'root-ingest', 'root-sync', 'root-inspector']) {
      expect(html, `mount point #${rootId} required`).toContain(`id="${rootId}"`);
    }
  });
});

describe('component anatomy (cv-stripe mock, verbatim measures)', () => {
  it('page title 24px/700; section titles 16px/700 with a 1px divider', () => {
    const title = css.match(/\.page-title\s*\{[^}]*\}/);
    expect(title, '.page-title rule required').toBeTruthy();
    expect(title![0]).toMatch(/font-size:\s*var\(--f-xl\)/);
    expect(title![0]).toMatch(/font-weight:\s*700/);
    const sec = css.match(/\.section-title\s*\{[^}]*\}/);
    expect(sec![0]).toMatch(/font-size:\s*var\(--f-lg\)/);
    expect(sec![0]).toMatch(/font-weight:\s*700/);
    expect(sec![0]).toMatch(/border-bottom:\s*1px solid var\(--border-subtle\)/);
  });

  it('sections stack with dividers — the page has no boxed .card', () => {
    expect(css).toMatch(/\.section\s*\{[^}]*margin-bottom:/);
    expect(css).not.toMatch(/\.card\s*\{/);
  });

  it('buttons: 28px tall, 6px radius; primary is the brand fill; secondary is white + control border', () => {
    const btn = css.match(/\.btn\s*\{[^}]*\}/);
    expect(btn, '.btn rule required').toBeTruthy();
    expect(btn![0]).toMatch(/height:\s*28px/);
    expect(btn![0]).toMatch(/border-radius:\s*var\(--radius\)/);
    const primary = css.match(/\.btn-primary\s*\{[^}]*\}/);
    expect(primary![0]).toMatch(/background:\s*var\(--brand\)/);
    const secondary = css.match(/\.btn-secondary\s*\{[^}]*\}/);
    expect(secondary![0]).toMatch(/border:\s*1px solid var\(--border-control\)/);
  });

  it('badges are small 4px-radius chips with the semantic pairs', () => {
    const badge = css.match(/\.badge\s*\{[^}]*\}/);
    expect(badge, '.badge rule required').toBeTruthy();
    expect(badge![0]).toMatch(/height:\s*20px/);
    expect(badge![0]).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    const danger = css.match(/\.badge--breach\s*\{[^}]*\}/);
    expect(danger![0]).toMatch(/background:\s*var\(--danger-bg\)/);
    expect(danger![0]).toMatch(/color:\s*var\(--danger-text\)/);
    const ok = css.match(/\.badge--approved\s*\{[^}]*\}/);
    expect(ok![0]).toMatch(/background:\s*var\(--success-bg\)/);
    const warn = css.match(/\.badge--signoff\s*\{[^}]*\}/);
    expect(warn![0]).toMatch(/background:\s*var\(--warning-bg\)/);
  });

  it('tables: 12px uppercase secondary headers + tabular numerals', () => {
    const table = css.match(/table\.data-table[^{]*\{|\.data-table\s*\{[^}]*\}/);
    expect(table, '.data-table rule required').toBeTruthy();
    const th = css.match(/\.data-table th[^{]*\{[^}]*\}/g) ?? [];
    expect(th.length, 'th rules required').toBeGreaterThan(0);
    expect(th.join('\n')).toMatch(/text-transform:\s*uppercase/);
    expect(th.join('\n')).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(th.join('\n')).toMatch(/font-size:\s*var\(--f-2xs\)/);
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('pipeline ledger stays a fixed 5-col grid', () => {
    expect(css).toMatch(/grid-template-columns:\s*40px\s+1fr\s+150px\s+120px\s+72px/);
  });

  it('cloud-bound stage tag wears the brand color; local tags stay neutral (trust legend)', () => {
    const cloud = css.match(/\.engine-tag--cloud\s*\{[^}]*\}/);
    expect(cloud, '.engine-tag--cloud rule required').toBeTruthy();
    expect(cloud![0]).toMatch(/color:\s*var\(--brand-text\)/);
  });

  it('inspector mapping marks raw PII strikes and the cloud side', () => {
    const tok = css.match(/\.token-table td\.tok\s*\{[^}]*\}/);
    expect(tok, 'td.tok rule required').toBeTruthy();
    expect(tok![0]).toMatch(/color:\s*var\(--brand-text\)/);
    const st = css.match(/\.token-table td\.strike\s*\{[^}]*\}/);
    expect(st, 'td.strike rule required (raw PII proof)').toBeTruthy();
    expect(st![0]).toMatch(/text-decoration:\s*line-through/);
    expect(st![0]).toMatch(/color:\s*var\(--danger-text\)/);
    const payload = css.match(/pre\.payload--cloud\s*\{[^}]*\}/);
    expect(payload, 'payload--cloud rule required').toBeTruthy();
    expect(payload![0]).toMatch(/border-color:\s*var\(--brand\)/);
  });
});

describe('theme mechanism (owner pick, unchanged)', () => {
  it('index.html defines the toggle control and anti-FOUC boot', () => {
    expect(html).toMatch(/id="themeToggle"/);
    expect(html).toMatch(/id="themeMode"/);
    expect(html).toMatch(/cv-theme/); // localStorage key applied before first paint
    expect(html).toMatch(/data-theme/);
  });
  it('css honors prefers-color-scheme AND explicit data-theme', () => {
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\)/);
  });
});

describe('hygiene (mirrors fleet designcheck MUST rules)', () => {
  it('comments are well-formed (no mid-text comment-style early close)', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stray = stripped.match(/\/\*|\*\//g) ?? [];
    expect(stray, `stray comment delimiters (a "--x-*/" closes a comment early): ${stray.join(' ')}`).toEqual([]);
  });
  it('no transition:all, no brightness() hover', () => {
    expect(css).not.toMatch(/transition\s*:\s*all\b/);
    expect(css).not.toMatch(/filter\s*:\s*brightness/);
  });
  it('every font-size declaration uses a token', () => {
    const rest = stripPaletteBlocks(css);
    const literals = (rest.match(/font-size:\s*[^;]+;/g) ?? []).filter((d) => !d.includes('var('));
    expect(literals, `font-size must use var(--f-*): ${literals.join(' | ')}`).toEqual([]);
  });
  it('every border-radius uses a token (no raw px)', () => {
    const off = (css.match(/border-radius\s*:\s*[^;{}]+;/g) ?? []).filter((d) => /\d+(\.\d+)?px/.test(d));
    expect(off, `border-radius must use var(--radius*): ${off.join(' | ')}`).toEqual([]);
  });
});

describe('class-hook contract', () => {
  // Inventory 2026-11-24 (Stripe restyle): every class rendered by ui/*.ts or index.html.
  const required = [
    'badge', 'badge--approved', 'badge--breach', 'badge--signoff',
    'banner', 'banner--fail', 'banner--info', 'banner--muted', 'banner--offline', 'banner--pass',
    'boot-error', 'boundary-band', 'btn', 'btn-primary', 'btn-row', 'btn-secondary',
    'chip', 'chip--muted', 'chip--ok', 'chip--warn', 'cite', 'cite-excerpt',
    'cite-note', 'cite-src', 'code', 'col-head', 'col-head--cloud', 'col-head--local',
    'cta-row', 'data-table', 'draft', 'draft-head', 'dur', 'empty', 'empty-sub',
    'empty-title', 'engine-tag', 'engine-tag--cloud', 'evlog', 'evlog-head', 'evmsg',
    'evrow', 'evrow--err', 'evrow--ok', 'evtime', 'field', 'field-row', 'grid-2',
    'hint', 'insp-cols', 'is-selected', 'k', 'ledger', 'lidx', 'llabel', 'lnote',
    'lrow', 'lrow--active', 'lrow--done', 'lrow--err', 'lrow--queued', 'lrow--skip',
    'metric', 'model-chip', 'nav-icon', 'nav-label', 'nav-link', 'nav-list', 'note', 'note--err', 'note--ok',
    'note--warn', 'page', 'page-header', 'page-sub', 'page-title', 'pairing',
    'payload', 'payload--cloud', 'payload-block', 'ph', 'query-chip', 'rule-strip',
    'rule-tile', 'search-box', 'search-input', 'section', 'section-head', 'section-title',
    'shell', 'sidebar', 'skip-link', 'stat', 'stat-k', 'stat-v', 'stats', 'status-dot',
    'status-dot--muted', 'status-dot--ok', 'status-dot--warn', 'status-menu-btn', 'status-popover',
    'strike', 'summary-head', 'table-scroll', 'tag', 'theme-toggle', 'tok', 'token-table', 'toast',
    'toast--error', 'toast--in', 'toast--ok', 'toast--out', 'toast--warn', 'toasts',
    'topbar', 'topbar-brand', 'topbar-divider', 'topbar-left', 'topbar-main',
    'topbar-right', 'v', 'val', 'venture-switcher', 'verdict', 'verdict-head',
    'verdict-sub', 'vrow', 'wordmark', 'wordmark-dot', 'workspace', 'ws-summary',
  ];
  it.each(required)('.%s has a rule in styles.css', (cls: string) => {
    // Selector-position match with an identifier boundary: a renamed class
    // (.section-title -> .section-title-bogus) must NOT satisfy the hook.
    const re = new RegExp(`\\.${cls}(?![\\w-])`);
    expect(css, `missing selector for .${cls}`).toMatch(re);
  });
});

function extractMediaBlock(src: string, query: string): string | null {
  const idx = src.indexOf(query);
  if (idx < 0) return null;
  const start = src.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

describe('phone layout contract (<= 480px)', () => {
  const phoneBlock = extractMediaBlock(css, '@media (max-width: 480px)');

  it('defines a @media (max-width: 480px) block', () => {
    expect(phoneBlock, '@media (max-width: 480px) block required in styles.css').toBeTruthy();
  });

  it('arranges topbar as brand + venture switcher + collapsed status menu on row 1 and full-width search below', () => {
    const block = phoneBlock ?? '';
    expect(block).toMatch(/\.topbar\s*\{[^}]*display:\s*grid/);
    expect(block).toMatch(/\.topbar-brand\s*\{[^}]*grid-row:\s*1/);
    expect(block).toMatch(/\.venture-switcher\s*\{[^}]*grid-row:\s*1/);
    expect(block).toMatch(/\.search-box\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(block).toMatch(/\.search-box\s*\{[^}]*grid-row:\s*2/);
    expect(block).toMatch(/\.status-menu-btn\s*\{[^}]*display:\s*inline-flex/);
    expect(block).toMatch(/\.status-popover\s*\{[^}]*display:\s*none/);
    expect(block).toMatch(/\.topbar-right\.is-open\s+\.status-popover\s*\{[^}]*display:\s*flex/);
  });

  it('turns sidebar into a fixed bottom tab bar with four equal columns', () => {
    const block = phoneBlock ?? '';
    expect(block).toMatch(/\.sidebar\s*\{[^}]*position:\s*fixed/);
    expect(block).toMatch(/\.sidebar\s*\{[^}]*bottom:\s*0/);
    expect(block).toMatch(/\.nav-list\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('stacks record detail and multi-column grids to a single column', () => {
    const block = phoneBlock ?? '';
    expect(block).toMatch(/\.detail-grid[\s\S]*?grid-template-columns:\s*(?:1fr|minmax\(0,\s*1fr\))/);
    expect(block).toMatch(/\.form-grid[\s\S]*?grid-template-columns:\s*(?:1fr|minmax\(0,\s*1fr\))/);
    expect(block).toMatch(/\.meta-grid[\s\S]*?grid-template-columns:\s*(?:1fr|minmax\(0,\s*1fr\))/);
  });

  it('keeps tables scrolling inside .table-scroll rather than the page', () => {
    const block = phoneBlock ?? '';
    expect(block).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(block).toMatch(/\.table-scroll\s+\.data-table\s*\{[^}]*min-width:/);
    expect(block).toMatch(/\.table-scroll\s+\.token-table\s*\{[^}]*min-width:/);
  });

  it('enforces >= 44px touch targets for interactive controls on phones', () => {
    const block = phoneBlock ?? '';
    for (const selector of [
      /\.venture-switcher\s*\{[^}]*min-height:\s*44px/,
      /\.search-input\s*\{[^}]*min-height:\s*44px/,
      /\.status-menu-btn\s*\{[^}]*min-height:\s*44px/,
      /\.status-menu-btn\s*\{[^}]*min-width:\s*44px/,
      /\.nav-link\s*\{[^}]*min-height:\s*44px/,
      /\.btn\s*\{[^}]*min-height:\s*44px/,
      /\.breadcrumb\s*\{[^}]*min-height:\s*44px/,
      /\.link\s*\{[^}]*min-height:\s*44px/,
      /\.clause-link\s*\{[^}]*min-height:\s*44px/,
    ]) {
      expect(block, `expected 44px touch target rule matching ${selector}`).toMatch(selector);
    }
  });
});
