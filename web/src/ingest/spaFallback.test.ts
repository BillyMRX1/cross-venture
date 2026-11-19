import { describe, expect, it } from 'vitest';
import { isSpaFallback } from './spaFallback';

describe('isSpaFallback', () => {
  it('rejects a response with an html content-type', () => {
    expect(isSpaFallback('text/html; charset=utf-8', '# not really html')).toBe(true);
  });

  it('rejects an html body even when content-type is text/plain', () => {
    expect(isSpaFallback('text/plain', '<!DOCTYPE html>\n<html><body></body></html>')).toBe(true);
    expect(isSpaFallback(null, '  \n<html lang="en">')).toBe(true);
  });

  it('accepts markdown', () => {
    expect(isSpaFallback('text/markdown; charset=utf-8', '# Partnership Agreement\n\nSome text')).toBe(false);
    expect(isSpaFallback(null, '# Heading')).toBe(false);
  });
});
