import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Copy law: the UI speaks product language. No ticket tags, no phase
// numbers in anything a user can see. Code comments may keep them — so we
// strip comments first, then scan the remaining source (strings included).
const BANNED: Array<[RegExp, string]> = [
  [/TD-/, 'ticket tag'],
  [/phase\s*2/i, 'phase number'],
];

function visibleCode(src: string, isHtml: boolean): string {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  s = s.replace(/^\s*\/\/.*$/gm, ' '); // whole-line comments
  if (isHtml) s = s.replace(/<!--[\s\S]*?-->/g, ' '); // HTML comments
  return s;
}

function scannedFiles(): string[] {
  const ui = __dirname;
  const others = [resolve(ui, '../../index.html'), resolve(ui, '../main.ts'), resolve(ui, '../types.ts')];
  const uiFiles = readdirSync(ui)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => resolve(ui, f));
  return [...others, ...uiFiles];
}

describe('no developer/internal copy in visible UI strings', () => {
  for (const file of scannedFiles()) {
    it(`${file.replace(/^.*\//, '')} stays in product language`, () => {
      const src = visibleCode(readFileSync(file, 'utf8'), file.endsWith('.html'));
      for (const [re, what] of BANNED) {
        const hit = src.match(re);
        expect(hit, `${what} "${hit?.[0] ?? ''}" found in ${file}`).toBeNull();
      }
    });
  }
});
