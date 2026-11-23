import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Style-layer pins (CEO UI/UX polish 2026-11-23): the design-token system is a
// contract, not a vibe. If someone re-introduces one-off hexes, literal font
// sizes, or drops motion/reduced-motion support, this suite goes red.

// Read from disk rather than a ?raw import: vitest stubs CSS modules to ''
// unless css handling is enabled, and the contract wants the real text.
const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

function stripTokenBlocks(source: string): string {
  // Token definitions live only in :root {...} blocks (light + dark variants).
  return source.replace(/:root\s*\{[^}]*\}/g, '');
}

describe('design-token contract', () => {
  it('defines the full token scales', () => {
    for (const t of ['--f-2xs', '--f-xs', '--f-sm', '--f-base', '--f-md', '--f-lg', '--f-xl', '--f-stat',
                     '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6',
                     '--t-fast', '--t-med', '--ease', '--shadow-lift', '--shadow-edge']) {
      expect(css, `token ${t} must be defined in a token block`).toContain(`${t}:`);
    }
  });

  it('no raw hex colors outside token blocks', () => {
    const rest = stripTokenBlocks(css);
    const hits = rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits, `raw hex colors outside :root token blocks: ${hits.join(', ')}`).toEqual([]);
  });

  it('every font-size declaration uses a token', () => {
    const rest = stripTokenBlocks(css);
    const literals = (rest.match(/font-size:\s*[^;]+;/g) ?? []).filter((d) => !d.includes('var('));
    expect(literals, `font-size must use var(--f-*): ${literals.join(' | ')}`).toEqual([]);
  });

  it('supports prefers-reduced-motion', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe('class-hook contract', () => {
  // Every class the TS UI actually uses must exist in the stylesheet (no dead
  // hooks, and the new hero classes are pinned here too).
  const required = [
    // pre-existing hooks (inventory 2026-11-23)
    'badge', 'banner', 'banner--fail', 'banner--info', 'banner--muted', 'banner--pass', 'banner--offline',
    'boot-error', 'btn', 'btn-primary', 'btn-run', 'btn-sm', 'card', 'card-toolbar', 'card-head',
    'chip', 'chip--ok', 'chip--warn', 'chip--muted', 'cite', 'cite-excerpt', 'cite-note',
    'cite-src', 'code', 'dot', 'draft', 'draft-head', 'empty', 'field', 'field-row', 'grid-2', 'hint',
    'insp-cols', 'k', 'label', 'note', 'note--err', 'note--warn', 'note--ok', 'pairing', 'payload',
    'payload--cloud', 'payload-block', 'ph', 'query-chip', 'rule-strip', 'rule-tile', 'stage', 'stages',
    'stage--run', 'stage--ok', 'stage--err', 'stage--skip', 'tag', 'tok', 'token-table', 'v', 'val',
    'verdict', 'verdict-head', 'verdict-sub', 'vrow', 'toast', 'toast--in', 'toast--out', 'toast--ok',
    'toast--warn', 'toast--error', 'toasts', 'topbar', 'topbar-in', 'brand', 'brand-mark', 'brand-text',
    'brand-sub', 'chips', 'tabs', 'tab', 'panel', 'wrap', 'skip-link', 'col-head', 'col-head--local',
    'col-head--cloud',
    // new hero hooks (2026-11-23 polish)
    'model-chip', 'ws-summary', 'summary-head', 'stats', 'stat', 'stat-k', 'stat-v',
    'hero-head', 'hero-sub', 'cta-row',
    // verdict badges + stage states rendered via lookups/templates
    'badge--approved', 'badge--signoff', 'badge--breach',
  ];
  it.each(required)('.%s has a rule in styles.css', (cls: string) => {
    // Selector-position match with an identifier boundary: a renamed class
    // (.hero-head -> .hero-head-bogus) must NOT satisfy the hook for .hero-head.
    const re = new RegExp(`\\.${cls}(?![\\w-])`);
    expect(css, `missing selector for .${cls}`).toMatch(re);
  });
});
