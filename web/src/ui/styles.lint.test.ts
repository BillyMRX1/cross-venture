import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design contract v2 (owner pick 2026-11-24: BOTH concepts as modes).
// Concept A 'Manifest Light' = light DEFAULT, Concept B 'Terminal Control' = dark,
// switched by prefers-color-scheme + a persisted manual toggle. Modes are TOKEN SETS
// ONLY: identical property vocabulary, identical layout rules. Values come verbatim
// from redesign-mockups/STEP2_TOKEN_SHEET.md. If anyone re-introduces one-off hexes,
// off-scale spacing, mixed color meanings, or breaks the palette symmetry, red here.

// Read from disk rather than a ?raw import: vitest stubs CSS modules to ''
// unless css handling is enabled, and the contract wants the real text.
const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

// Palette blocks = any :root-anchored custom-property block (light default,
// media dark, explicit [data-theme] variants). Everything else must be hex-free.
function paletteBlocks(src: string): string[] {
  return src.match(/:root[^{]*\{[^}]*\}/g) ?? [];
}
function stripPaletteBlocks(src: string): string {
  return src.replace(/:root[^{]*\{[^}]*\}/g, '');
}
function propsIn(block: string): string[] {
  return [...block.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

// Signature colors, verbatim from the sheet (A light / B dark).
const A_SIG = ['#F5F3EE', '#D94814', '#136F4A', '#1E4E8C'];
const B_SIG = ['#12130F', '#E59A24', '#34C77B', '#7A97C4'];

describe('dual-mode palette contract', () => {
  const blocks = paletteBlocks(css);

  it('has a light default block with the concept-A sheet colors', () => {
    const light = blocks.find((b) => b.includes('#F5F3EE'));
    expect(light, 'concept A palette (sheet STEP2_TOKEN_SHEET.md) must be the light default').toBeTruthy();
    for (const sig of A_SIG) expect(light!).toContain(sig);
  });

  it('has dark blocks with the concept-B sheet colors (contrast-bumped text-dim)', () => {
    const dark = blocks.filter((b) => b.includes('#12130F'));
    expect(dark.length, 'concept B must serve BOTH prefers-color-scheme and explicit [data-theme="dark"]').toBeGreaterThanOrEqual(2);
    for (const b of dark) for (const sig of B_SIG) expect(b, `dark block must carry ${sig}`).toContain(sig);
    for (const b of dark) expect(b, "B's mandatory gray bump").toContain('#9C9E93');
  });

  it('both palettes define the SAME vocabulary (modes are token sets only)', () => {
    const light = blocks.find((b) => b.includes('#F5F3EE'))!;
    const dark = blocks.filter((b) => b.includes('#12130F'))![0];
    expect(propsIn(dark), 'dark vocabulary must equal light vocabulary').toEqual(propsIn(light));
  });

  it('semantic color vocabulary is single across modes', () => {
    for (const t of ['--accent', '--accent-ink', '--accent-soft', '--ok', '--warn', '--danger', '--local-accent', '--cloud-accent']) {
      expect(css, `semantic token ${t} required`).toContain(`${t}:`);
    }
  });

  it('no raw hex colors outside palette blocks', () => {
    const hits = stripPaletteBlocks(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits, `raw hex outside :root palette blocks: ${hits.join(', ')}`).toEqual([]);
  });

  it('live-probe tokens exist: --sans, --mono, --gap, --radius, --radius-sm', () => {
    for (const t of ['--sans', '--mono', '--gap', '--radius', '--radius-sm']) {
      expect(css, `${t} must be defined (design-lane live probe reads computed values)`).toContain(`${t}:`);
    }
  });

  it('scale tokens exist (type, spacing, motion, elevation)', () => {
    for (const t of ['--f-2xs', '--f-xs', '--f-sm', '--f-base', '--f-md', '--f-lg', '--f-xl', '--f-stat',
                     '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6',
                     '--t-fast', '--t-med', '--ease', '--shadow', '--shadow-lift', '--shadow-edge']) {
      expect(css, `token ${t} must be defined`).toContain(`${t}:`);
    }
  });
});

describe('layout law (comp-committed rules)', () => {
  it('pipeline ledger is a fixed 5-col grid (never card-in-card)', () => {
    expect(css).toMatch(/grid-template-columns:\s*36px\s+1fr\s+140px\s+90px\s*72px/);
  });
  it('PRIVACY BOUNDARY signature band: 2px border-strong top AND bottom', () => {
    const band = css.match(/\.boundary-band\s*\{[^}]*\}/);
    expect(band, '.boundary-band rule required').toBeTruthy();
    expect(band![0]).toMatch(/border-top:\s*2px solid var\(--border-strong\)/);
    expect(band![0]).toMatch(/border-bottom:\s*2px solid var\(--border-strong\)/);
  });
  it('inspector mapping table marks raw PII strikes, cloud tokens and verbatim rows', () => {
    const tok = css.match(/\.token-table td\.tok\s*\{[^}]*\}/);
    expect(tok, 'td.tok rule required').toBeTruthy();
    expect(tok![0]).toMatch(/color:\s*var\(--cloud-accent\)/);
    const st = css.match(/\.token-table td\.strike\s*\{[^}]*\}/);
    expect(st, 'td.strike rule required (raw PII proof)').toBeTruthy();
    expect(st![0]).toMatch(/text-decoration:\s*line-through/);
    expect(st![0]).toMatch(/color:\s*var\(--danger\)/);
  });
  it('event log strip exists (ops-tool proof)', () => {
    expect(css).toMatch(/\.evlog[^{]*\{/);
  });
  it('cloud-bound stage tag uses the cloud color, never the local color (trust legend)', () => {
    const cloud = css.match(/\.engine-tag--cloud\s*\{[^}]*\}/);
    expect(cloud, '.engine-tag--cloud rule required').toBeTruthy();
    expect(cloud![0]).toMatch(/color:\s*var\(--cloud-accent\)/);
    expect(cloud![0], 'cloud tag must not reference local-accent').not.toMatch(/local-accent/);
  });
});

describe('theme mechanism (owner pick)', () => {
  it('index.html defines the toggle control and anti-FOUC boot', () => {
    expect(html).toMatch(/id="themeToggle"/);
    expect(html).toMatch(/cv-theme/); // localStorage key applied before first paint
    expect(html).toMatch(/data-theme/);
  });
  it('css honors prefers-color-scheme AND explicit data-theme', () => {
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\)/);
  });
});

describe('designcheck law (mirrors fleet designcheck.py MUST rules)', () => {
  it('comments are well-formed (no mid-text /*-style early close)', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stray = stripped.match(/\/\*|\*\//g) ?? [];
    expect(stray, `stray comment delimiters (a "--x-*/" closes a comment early): ${stray.join(' ')}`).toEqual([]);
  });
  it('spacing literals stay on the 4/8/12/16/24/32/48 scale', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bad: string[] = [];
    for (const m of code.matchAll(/(?:margin|padding|gap|row-gap|column-gap)\s*:\s*([^;{}]+)/g)) {
      const scale = new Set([0, 4, 8, 12, 16, 24, 32, 48]);
      for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
        if (!scale.has(parseInt(px[1], 10)) || px[1] !== String(parseInt(px[1], 10))) bad.push(m[1]);
      }
    }
    expect(bad, `off-scale spacing: ${bad.join(' | ')}`).toEqual([]);
  });
  it('radius literals stay in {0,4,8,12,999}', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const scale = new Set([0, 4, 8, 12, 999]);
    const bad: string[] = [];
    for (const m of code.matchAll(/border-radius\s*:\s*([^;{}]+)/g)) {
      for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
        if (!scale.has(parseInt(px[1], 10))) bad.push(m[1]);
      }
    }
    expect(bad, `off-scale radius: ${bad.join(' | ')}`).toEqual([]);
  });
  it('no transition:all, no brightness() hover', () => {
    expect(css).not.toMatch(/transition\s*:\s*all\b/);
    expect(css).not.toMatch(/filter\s*:\s*brightness/);
  });
  it('supports prefers-reduced-motion and :focus-visible', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/:focus-visible/);
  });
  it('every font-size declaration uses a token', () => {
    const rest = stripPaletteBlocks(css);
    const literals = (rest.match(/font-size:\s*[^;]+;/g) ?? []).filter((d) => !d.includes('var('));
    expect(literals, `font-size must use var(--f-*): ${literals.join(' | ')}`).toEqual([]);
  });
});

describe('class-hook contract', () => {
  // Inventory 2026-11-24 (restyle): every class rendered by ui/*.ts or index.html.
  const required = [
    'badge', 'badge--approved', 'badge--signoff', 'badge--breach',
    'banner', 'banner--fail', 'banner--info', 'banner--muted', 'banner--pass', 'banner--offline',
    'boot-error', 'boundary-band', 'brand', 'brand-mark', 'brand-sub', 'brand-text',
    'btn', 'btn-primary', 'btn-run', 'btn-sm', 'card', 'card-head', 'card-toolbar',
    'chip', 'chip--muted', 'chip--ok', 'chip--warn', 'chips', 'cite', 'cite-excerpt',
    'cite-note', 'cite-src', 'code', 'col-head', 'col-head--cloud', 'col-head--local',
    'cta-row', 'dot', 'draft', 'dur',    'draft-head', 'empty', 'engine-tag', 'engine-tag--cloud', 'evlog',
    'evlog-head', 'evmsg', 'evrow', 'evtime', 'field', 'field-row', 'grid-2',
    'hero-head', 'hero-sub', 'hint', 'insp-cols', 'k', 'ledger', 'lidx',
    'llabel', 'lnote', 'lrow', 'lrow--active', 'lrow--done', 'lrow--err',
    'lrow--queued', 'lrow--skip', 'metric', 'model-chip', 'note', 'note--err',
    'note--ok', 'note--warn', 'panel', 'pairing', 'payload', 'payload--cloud',
    'payload-block', 'ph', 'query-chip', 'rail', 'rail-step', 'rail-step--active',
    'rail-step--done', 'rule-strip', 'rule-tile', 'skip-link', 'stat', 'stat-k', 'stat-v',
    'stats', 'strike', 'summary-head', 'tab', 'tabs', 'tag', 'theme-toggle', 'tok',
    'token-table', 'toast', 'toast--error', 'toast--in', 'toast--ok', 'toast--out',
    'toast--warn', 'toasts', 'topbar', 'topbar-in', 'v', 'val', 'verdict',
    'verdict-head', 'verdict-sub', 'vrow', 'wrap', 'ws-summary',
  ];
  it.each(required)('.%s has a rule in styles.css', (cls: string) => {
    // Selector-position match with an identifier boundary: a renamed class
    // (.hero-head -> .hero-head-bogus) must NOT satisfy the hook for .hero-head.
    const re = new RegExp(`\\.${cls}(?![\\w-])`);
    expect(css, `missing selector for .${cls}`).toMatch(re);
  });
});
