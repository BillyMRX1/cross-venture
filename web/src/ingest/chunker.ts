import type { DocChunk } from '../types';

// Page markers: dashed form may appear inline; the plain form must own its line.
const PAGE_MARKER_ANY = /-{3,}\s*page\s+(\d+)\s*-{3,}/gi;
const PAGE_MARKER_LINE = /^[ \t]*page[ \t]+(\d+)[ \t]*$/gim;
const PAGE_MARKER_BLOCK = /^(?:-{3,}\s*page\s+\d+\s*-{3,}|page[ \t]+\d+)$/i;

interface Block {
  text: string;
  start: number;
  isPageMarker: boolean;
  words: number;
}

interface Marker {
  pos: number;
  page: number;
}

interface RawChunk {
  start: number;
  text: string;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function isHeading(text: string): boolean {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const line = firstLine.trim();
  return line.startsWith('#') || /^(Section|ARTICLE|Article)\b/.test(line);
}

function makeBlock(lines: string[], start: number): Block {
  const text = lines.join('\n');
  return {
    text,
    start,
    isPageMarker: PAGE_MARKER_BLOCK.test(text.trim()),
    words: countWords(text),
  };
}

/** Split on blank lines; consecutive non-empty lines stay together. */
function splitIntoBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: { lines: string[]; start: number } | null = null;
  let pos = 0;

  for (const line of text.split('\n')) {
    if (/^[ \t]*$/.test(line)) {
      if (current) {
        blocks.push(makeBlock(current.lines, current.start));
        current = null;
      }
    } else {
      if (!current) current = { lines: [], start: pos };
      current.lines.push(line);
    }
    pos += line.length + 1;
  }
  if (current) blocks.push(makeBlock(current.lines, current.start));
  return blocks;
}

/** Glue heading blocks onto the following body block (except the last block). */
function glueHeadings(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = blocks[i + 1];
    if (isHeading(block.text) && next && !block.isPageMarker && !next.isPageMarker) {
      out.push({
        text: `${block.text}\n\n${next.text}`,
        start: block.start,
        isPageMarker: false,
        words: block.words + next.words,
      });
      i += 1;
    } else {
      out.push(block);
    }
  }
  return out;
}

interface Sentence {
  text: string;
  index: number;
}

function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const re = /(?<=[.!?])\s+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    sentences.push({ text: text.slice(last, match.index), index: last });
    last = match.index + match[0].length;
  }
  sentences.push({ text: text.slice(last), index: last });
  return sentences.filter((sentence) => sentence.text.trim() !== '');
}

/** Split an oversized block at sentence boundaries, falling back to words. */
function splitOversizedBlock(block: Block, targetWords: number): Block[] {
  const pieces: Block[] = [];
  let currentText = '';
  let currentStart = block.start;
  let currentWords = 0;

  const flush = (): void => {
    const trimmed = currentText.trim();
    if (trimmed !== '') {
      pieces.push({
        text: trimmed,
        start: currentStart,
        isPageMarker: false,
        words: countWords(trimmed),
      });
    }
    currentText = '';
    currentWords = 0;
  };

  for (const sentence of splitSentences(block.text)) {
    const words = countWords(sentence.text);
    if (words > targetWords) {
      flush();
      const tokens = sentence.text.trim().split(/\s+/);
      let buffer: string[] = [];
      const start = block.start + sentence.index;
      for (const token of tokens) {
        if (buffer.length >= targetWords) {
          const text = buffer.join(' ');
          pieces.push({ text, start, isPageMarker: false, words: countWords(text) });
          buffer = [];
        }
        buffer.push(token);
      }
      if (buffer.length > 0) {
        const text = buffer.join(' ');
        pieces.push({ text, start, isPageMarker: false, words: countWords(text) });
      }
      continue;
    }

    if (currentWords > 0 && currentWords + words > targetWords) flush();
    if (currentWords === 0) {
      currentStart = block.start + sentence.index;
      currentText = sentence.text;
      currentWords = words;
    } else {
      currentText += ' ' + sentence.text;
      currentWords += words;
    }
  }
  flush();
  return pieces;
}

function expandOversized(blocks: Block[], targetWords: number): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.isPageMarker || block.words <= targetWords) {
      out.push(block);
    } else {
      out.push(...splitOversizedBlock(block, targetWords));
    }
  }
  return out;
}

/** Greedy packing with paragraph boundaries. */
function buildRawChunks(blocks: Block[], targetWords: number): RawChunk[] {
  const chunks: RawChunk[] = [];
  let current: { start: number; text: string; words: number } | null = null;

  const flush = (): void => {
    if (current && current.text.trim() !== '') {
      chunks.push({ start: current.start, text: current.text });
    }
    current = null;
  };

  for (const block of blocks) {
    // Marker-only blocks ride along with the current chunk, but their text
    // (and position) still feeds the page tracker for whatever follows.
    if (block.isPageMarker) {
      if (!current) {
        current = { start: block.start, text: block.text, words: 0 };
      } else {
        current.text += '\n\n' + block.text;
        // A marker closes the current chunk so following content begins a
        // new chunk whose start is after the marker (pageAt sees the new page).
        if (current.words > 0) flush();
      }
      continue;
    }

    if (!current) {
      current = { start: block.start, text: block.text, words: block.words };
      continue;
    }

    const exceeds = current.words + block.words > targetWords;
    if (exceeds && current.words >= targetWords * 0.4) {
      flush();
      current = { start: block.start, text: block.text, words: block.words };
    } else {
      current.text += '\n\n' + block.text;
      current.words += block.words;
    }
  }
  flush();
  return chunks;
}

function findMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  let match: RegExpExecArray | null;

  PAGE_MARKER_ANY.lastIndex = 0;
  while ((match = PAGE_MARKER_ANY.exec(text))) {
    markers.push({ pos: match.index, page: Number(match[1]) });
  }
  PAGE_MARKER_LINE.lastIndex = 0;
  while ((match = PAGE_MARKER_LINE.exec(text))) {
    markers.push({ pos: match.index, page: Number(match[1]) });
  }
  markers.sort((a, b) => a.pos - b.pos);
  return markers;
}

function pageAt(start: number, text: string, markers: Marker[], targetWords: number): number {
  let page = 1;
  let seen = false;
  for (const marker of markers) {
    if (marker.pos <= start) {
      page = marker.page;
      seen = true;
    } else {
      break;
    }
  }
  if (!seen) {
    const wordsBefore = countWords(text.slice(0, start));
    page = 1 + Math.floor(wordsBefore / targetWords);
  }
  return Math.max(1, page);
}

export function chunkDocument(docName: string, text: string, targetWords = 600): DocChunk[] {
  const target = targetWords > 0 ? targetWords : 600;
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.trim() === '') {
    return [{ docName, page: 1, index: 0, text: '' }];
  }

  const markers = findMarkers(normalized);
  const blocks = glueHeadings(splitIntoBlocks(normalized));
  const expanded = expandOversized(blocks, target);
  const raw = buildRawChunks(expanded, target);

  return raw.map((chunk, index) => ({
    docName,
    page: pageAt(chunk.start, normalized, markers, target),
    index,
    text: chunk.text,
  }));
}
