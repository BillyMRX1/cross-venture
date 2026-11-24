import type {
  AnonymizeResult,
  AnonymizedChunk,
  DetectedSpan,
  DocChunk,
  EntityType,
} from '../types';
import { generate } from '../hybrid';
import { escapeRe, numericForms, splitNumber } from '../ui/util';

type SpanKind = 'MONEY' | 'PERCENT' | 'NAME';

interface Range {
  start: number;
  end: number;
}

interface Candidate {
  chunkIdx: number;
  start: number;
  end: number;
  text: string;
  kind: SpanKind;
  type?: EntityType;
  token?: string;
  // Override for the value-dedupe key (spelled-out amount phrases: they must
  // share one token with the parenthesised figure they annotate).
  key?: string;
}

const ENTITY_TYPES: EntityType[] = [
  'PARTNER',
  'VENTURE',
  'SKU',
  'COST',
  'PRICE',
  'DISCOUNT_CAP',
  'MARGIN_FLOOR',
  'VALUE',
];

// Types the tagging model may propose — VALUE is director-internal (Pass C only).
const MODEL_ENTITY_TYPES: EntityType[] = ENTITY_TYPES.filter((t) => t !== 'VALUE');

const REDACT_SCHEMA: object = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: MODEL_ENTITY_TYPES,
          },
        },
        required: ['id', 'type'],
      },
    },
  },
  required: ['assignments'],
};

// ---------------------------------------------------------------- detection

const PERCENT_RE = /\b\d+(?:\.\d+)?\s?%/g;
const SYMBOL_MONEY_RE = /[$€£¥₹]\s*\d[\d,]*(?:\.\d+)?/g;
const CODE_MONEY_RE =
  // (?<!\d)(?<!\d[.,]) — never start mid-number: '1.500.000 IDR' must not be
  // eaten from '500.000' and leave '1.' behind (Patch 5).
  /(?<![0-9])(?<![0-9][.,])\d[\d,]*(?:\.\d+)?\s?(?:USD|IDR|EUR|GBP|SGD|AUD|CAD|JPY|Rupiah|SGD)\b/gi;
const THOUSANDS_RE = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;
// Indonesian thousands (`1.500.000`) must be matched BEFORE DECIMAL_RE, which
// would otherwise blind only the `1.500` fragment and leave junk behind (Patch 5).
const ID_THOUSANDS_RE = /\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b/g;
const DECIMAL_RE = /\b\d+\.\d+\b/g;
const BARE_INT_RE = /\b\d+\b/g;

// Keyword case-insensitive via character classes, NOT the 'i' flag: with
// 'i' the capture's [A-Z][a-z]+ matches lowercase words and swallowed whole
// clauses ("Sari Dewi signed for the Bright Sprouts company"). Names must
// stay capitalized words.
const PARTNER_WITH_RE = /(?:[Ww]ith [Pp]artner|[Pp]artner|PARTNER)\s+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)/g;
const PARTNER_ROLE_RE =
  /(?:co-founder|Co-founder|CO-FOUNDER|Founder|founder|Owner|owner)\s*[:—–-][*"'’\s]*([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)/g;
const PARTNER_AND_RE = /[Aa]nd [Pp]artner ([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)/g;
const VENTURE_PAREN_RE =
  /(?:^|[^\w])([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){1,3})\s*\(\s*["'](?:the )?(?:Company|Venture|Partnership|Business)/g;
const VENTURE_THE_RE =
  /the ([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){1,3}) (?:venture|company|partnership|studio|business)/g;
// Defined short alias of a company: (the "Company" or "RoastLab"), ("Brightwell").
// The alias is the name in everyday use across the rest of the contract.
const VENTURE_ALIAS_RE =
  /\(\s*(?:the\s+)?(?:["“][A-Za-z ]+["”]\s*,?\s*or\s+)?(?:the\s+)?["“]([A-Z][A-Za-z0-9&'.-]*[a-z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,3})["”]\s*\)/g;
const VENTURE_ALIAS_GENERIC: ReadonlySet<string> = new Set(['company','venture','partnership','business','agreement','distributor','client','consultant','supplier','buyer','seller','partner','partners','party','parties','member','members','effective date','territory','products','services','licensor','licensee','purchaser','vendor','customer','contractor','manager','board']);
const VENTURE_COOWNED_RE =
  /([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){1,3})\s+(?:is|was)?\s*[^.]{0,60}?[Cc]o-owned/g;
const SKU_PREFIX_RE =
  /\bSKUs?\s*[:—–-]?\s*((?:[A-Z][A-Za-z'&-]+)(?:\s+[A-Z][A-Za-z'&-]+){1,3})/g;
const SKU_SUFFIX_RE =
  /([A-Z][A-Za-z'&-]*(?:\s+[A-Z][A-Za-z'&-]*){1,3})[^.\n]{0,30}?SKUs?\b/g;

// Structural document labels sit next to "SKU" wording and were captured as
// products on real PDFs ("SCHEDULE A", "Wholesale List Price"). A heading is
// a label, not a product: never tag a captured span that is one.
const SKU_LABEL_RE =
  /^(?:schedule|appendix|exhibit|annex|attachment|article|section|clause|part|item|table|figure|form|page)\s+[a-z0-9ivxlc]+$/i;
const SKU_LABEL_PHRASES: ReadonlySet<string> = new Set([
  'wholesale list price',
  'standard list price',
  'list price',
  'price list',
]);

function isSkuLabel(value: string): boolean {
  const t = value.trim();
  return SKU_LABEL_RE.test(t) || SKU_LABEL_PHRASES.has(t.toLowerCase());
}

// Legal-entity suffixes (real PDFs, 2026-11-25): "Atelier Emily LLC" was
// captured as SKU "Atelier Emily" + loose "LLC". A name ending in one of
// these suffixes is a VENTURE, whole span including the suffix; and a SKU
// capture that is immediately followed by such a suffix is rejected.
// Case-sensitive on purpose: 'Inc\.?' must not fire on "included".
const ENTITY_SUFFIX = String.raw`LLC|L\.L\.C\.|Inc\.?|Ltd\.?|Pte\.?\s+Ltd\.?|AB|GmbH|PT|Corp\.?|Co\.|S\.A\.|B\.V\.`;
const SUFFIX_AFTER_RE = new RegExp(String.raw`^\s*(?:${ENTITY_SUFFIX})(?![A-Za-z])`);
// A SKU capture whose own tail is the suffix ("The Willowmere Holdings LLC"
// greedily before "SKUs") is the company, not a product.
const SUFFIX_VALUE_RE = new RegExp(String.raw`(?:${ENTITY_SUFFIX})$`);
const VENTURE_SUFFIX_RE = new RegExp(
  // (?!The |A |An ) — the greedy name part must not swallow a leading
  // article: "The Willowmere Holdings LLC" must capture "Willowmere Holdings LLC".
  String.raw`\b((?!The[ \t]|An?[ \t])[A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){1,5}\s+(?:${ENTITY_SUFFIX}))(?![A-Za-z])`,
  'g',
);

// Person names in prose and signature blocks (real PDFs, 2026-11-25): names
// without a role keyword leaked ("...sign-off from Emily Vance...").
// Context-sensitive on purpose — a bare First Last sweep would tag addresses,
// headings and company names. Names stay capitalized words (see the
// PARTNER_WITH_RE note above). People detected here are tagged PARTNER:
// types.ts is a frozen contract and has no PERSON type, and the PARTNER
// first/last-word sweep plus gate check gives the strongest coverage.
const PERSON_NAME = String.raw`([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)`;
const PERSON_SEP = String.raw`(?:[ \t]+|[ \t]*[:—–-][*"'’\s]*)`;
const PERSON_PROSE_RE = new RegExp(
  String.raw`\b(?:[Mm]anaging [Mm]ember|[Mm]ember|[Dd]irector|[Pp]resident|CEO|CFO|COO|[Ff]rom|[Tt]o|[Ww]ith|[Bb]y)${PERSON_SEP}${PERSON_NAME}`,
  'g',
);
const PERSON_BLOCK_RE = new RegExp(
  String.raw`\b(?:By|Name|Title|Chair)[ \t]*:[ \t*"'\s]*${PERSON_NAME}`,
  'g',
);
const PERSON_HONORIFIC_RE = new RegExp(
  String.raw`\b(?:Mr|Mrs|Ms|Dr|Prof)\.?[ \t]+${PERSON_NAME}`,
  'g',
);

// A captured "name" made only of structural/role words is a title, not a
// person ("Title: Managing Member"), and function words after to/from/by are
// prose, not names ("from the current supplier" is already safe via case,
// this guards the capitalized edges).
const PERSON_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'this', 'that', 'these', 'those', 'current', 'new', 'sole', 'only',
  'same', 'other', 'others', 'both', 'each', 'every', 'any', 'all', 'now',
  'here', 'above', 'below', 'following', 'company', 'business', 'partnership',
  'venture', 'agreement', 'contract', 'invoice', 'order', 'payment',
  'account', 'client', 'customer', 'buyer', 'seller', 'supplier', 'product',
  'price', 'cost', 'rate', 'fee', 'month', 'months', 'day', 'days', 'week',
  'weeks', 'year', 'years', 'section', 'clause', 'schedule', 'page', 'form',
  'table', 'figure', 'managing', 'member', 'director', 'president', 'chief',
  'officer', 'head', 'lead', 'manager', 'chair', 'chairperson', 'witness',
  'founder', 'owner', 'partner', 'ceo', 'cfo', 'coo',
]);

function isPersonStop(value: string): boolean {
  return value
    .trim()
    .split(/\s+/)
    .some((word) => PERSON_STOP_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, '')));
}

// Spelled-out amounts (real PDFs, 2026-11-25): "Two Hundred Fifty Thousand
// Dollars ([COST_3])" — the digits got a token, the phrase did not. A number
// word run counts as an amount only with a currency/percent tail or a
// parenthesised figure, so durations ("fourteen days", "sixty days") stay
// literal. The phrase and the figure share one token via Candidate.key.
const SPELL_WORD = String.raw`thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|one|two|three|four|five|six|seven|eight|nine`;
const SPELL_SEQ = String.raw`(?:${SPELL_WORD})(?:[ \t-]+(?:and[ \t-]+)?(?:${SPELL_WORD}))*`;
const SPELL_TAIL = String.raw`us dollars?|dollars?|usd|rupiahs?|euros?|pounds?|percent|persen`;
const SPELL_AMOUNT_RE = new RegExp(
  String.raw`\b(${SPELL_SEQ})(?=[ \t]+(?:${SPELL_TAIL})(?![a-z])|[ \t]*\()([ \t]+(?:${SPELL_TAIL})(?![A-Za-z]))?([ \t]*\(\s*(?:usd|idr|eur|gbp|sgd|rupiah|rp\.?)?\s*[\d,.]+%?\s*\))?`,
  'gi',
);

const MONEY_CONTEXT_RE =
  /(cost|cogs|modal|harga|retail|price|sell|jual|rate|fee|budget|spend|profit|revenue|margin)/;

function pushRanges(ranges: Range[], text: string, re: RegExp): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

function collectExclusions(text: string): Range[] {
  const ranges: Range[] = [];
  pushRanges(ranges, text, /§\s*\d+(?:\.\d+)*/g);
  pushRanges(ranges, text, /\bSection\s+\d+(?:\.\d+)*/gi);
  pushRanges(ranges, text, /-{3,}\s*page\s+\d+\s*-{3,}/gi);
  pushRanges(ranges, text, /^[ \t]*page[ \t]+\d+[ \t]*$/gim);
  pushRanges(ranges, text, /\bpage[ \t]+\d+[ \t]+of[ \t]+\d+\b/gi);
  pushRanges(ranges, text, /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g);
  pushRanges(ranges, text, /\b\d[\d,]*\s?(?:units?|pcs|pieces|items|orders)\b/gi);

  // Document identifiers: alnum-hyphen codes with letters AND digits
  // ("NS-MSA-7-V2") are structure, not business figures.
  pushRanges(
    ranges,
    text,
    /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
  );

  // Years used as dates (month-name nearby, or glued to a date preposition:
  // "dated in 2019") are not money.
  const months =
    /(January|February|March|April|May|June|July|August|September|October|November|December)/i;
  const yearLead =
    /\b(?:in|since|during|until|through|from|to|effective|before|after|late|early|year)[ \t]+$/i;
  const yearRe = /\b(?:19|20)\d{2}\b/g;
  yearRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = yearRe.exec(text))) {
    const from = Math.max(0, match.index - 12);
    const to = Math.min(text.length, match.index + match[0].length + 12);
    const lead = text.slice(Math.max(0, match.index - 16), match.index);
    if (months.test(text.slice(from, to)) || yearLead.test(lead)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function overlapsAny(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function addRegexMatches(
  out: Candidate[],
  text: string,
  re: RegExp,
  kind: SpanKind,
  chunkIdx: number,
  exclusions: Range[],
  type?: EntityType,
): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsAny(start, end, exclusions)) continue;
    out.push({ chunkIdx, start, end, text: match[0], kind, type });
  }
}

function addCaptureMatches(
  out: Candidate[],
  text: string,
  re: RegExp,
  kind: SpanKind,
  chunkIdx: number,
  exclusions: Range[],
  type: EntityType,
  reject?: (value: string, after: string) => boolean,
): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = match[1];
    const offset = match[0].indexOf(value ?? '');
    if (!value || offset < 0) continue;
    const start = match.index + offset;
    const end = start + value.length;
    if (overlapsAny(start, end, exclusions)) continue;
    const after = text.slice(end, Math.min(text.length, end + 24));
    if (reject !== undefined && reject(value, after)) continue;
    out.push({ chunkIdx, start, end, text: value, kind, type });
  }
}

function addBareIntegerMoney(
  out: Candidate[],
  text: string,
  chunkIdx: number,
  exclusions: Range[],
  percentSpans: Candidate[],
): void {
  BARE_INT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_INT_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsAny(start, end, exclusions)) continue;
    if (overlapsAny(start, end, [...percentSpans, ...out])) continue;

    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).toLowerCase();
    // In markdown tables the money keyword lives in the column HEADER, not the
    // row, so accept when the table column is typed COST/PRICE (Patch 5).
    if (!MONEY_CONTEXT_RE.test(line) && !tableColumnType(text, start)) continue;

    const following = text.slice(end, Math.min(text.length, end + 24));
    if (/^\s*(?:units?|pcs|pieces|items|pages|orders)\b/i.test(following)) continue;
    // Quantities glued to a measurement unit ("40 kg", "5-kilogram",
    // "14 days") are physical amounts, not business figures — even when the
    // line happens to carry a money keyword. A currency marker glued to the
    // number never reaches here (the money regexes own that span).
    if (
      /^\s*-?\s*(?:km|kg|kilograms?|kilos?|cm|mm|mg|ml|cl|grams?|g|liters?|litres?|metres?|meters?|m|months?|weeks?|days?|hours?|minutes?|seconds?)(?![a-z])/i.test(
        following,
      )
    ) {
      continue;
    }

    out.push({ chunkIdx, start, end, text: match[0], kind: 'MONEY' });
  }
}

// Spelled-out amount phrase + its parenthesised figure -> TWO candidates
// (phrase span, figure span) sharing Candidate.key, so assignTokens mints
// ONE token for both and the digits stay a real numeric span for the Pass C
// collision closure. Runs BEFORE the numeric regexes: on an identical range
// the figure candidate here wins dedupe and carries the key.
function collectSpelledAmounts(
  out: Candidate[],
  text: string,
  chunkIdx: number,
  exclusions: Range[],
): void {
  SPELL_AMOUNT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPELL_AMOUNT_RE.exec(text))) {
    const seq = match[1];
    const tail = match[2] ?? '';
    const paren = match[3] ?? '';
    if (seq === '') continue;
    if (tail === '') {
      // No currency/percent word: "fifteen (15) days", "thirty-six (36)
      // monthly installments" are durations/counts, not amounts. Tokenizing
      // them registered bare words ("fifteen", "two") as known values and the
      // gate then flagged every other "two"/"five" in the document.
      if (!/%|usd|idr|eur|gbp|sgd|rupiah|rp/i.test(paren)) continue;
      // Amount whose unit lives only in the parenthesis ("fifteen (15%)"):
      // blind words + figure as ONE span so the known value is the whole
      // phrase, never a bare number word.
      const end = match.index + match[0].length;
      const digitsOnly = paren.match(/\d[\d,.]*%?/)?.[0];
      if (!overlapsAny(match.index, end, exclusions) && !overlapsAny(match.index, end, out)) {
        out.push({
          chunkIdx,
          start: match.index,
          end,
          text: text.slice(match.index, end),
          kind: paren.includes('%') ? 'PERCENT' : 'MONEY',
          key: digitsOnly === undefined ? undefined : normalizeValue(digitsOnly),
        });
      }
      continue;
    }
    const isPercent = /(?:percent|persen)[ \t]*$/i.test(tail);
    const kind: SpanKind = isPercent ? 'PERCENT' : 'MONEY';
    const phraseEnd = match.index + seq.length + tail.length;
    const digits = paren.match(/\d[\d,.]*%?/)?.[0];
    const key = digits === undefined ? undefined : normalizeValue(digits);

    if (
      !overlapsAny(match.index, phraseEnd, exclusions) &&
      !overlapsAny(match.index, phraseEnd, out)
    ) {
      out.push({
        chunkIdx,
        start: match.index,
        end: phraseEnd,
        text: text.slice(match.index, phraseEnd),
        kind,
        key,
      });
    }
    if (digits === undefined) continue;

    const figureStart = match.index + seq.length + tail.length + paren.lastIndexOf(digits);
    const figureEnd = figureStart + digits.length;
    if (
      !overlapsAny(figureStart, figureEnd, exclusions) &&
      !overlapsAny(figureStart, figureEnd, out)
    ) {
      out.push({
        chunkIdx,
        start: figureStart,
        end: figureEnd,
        text: digits,
        kind: digits.endsWith('%') ? 'PERCENT' : kind,
        key,
      });
    }
  }
}

function detectInChunk(chunk: DocChunk, chunkIdx: number): Candidate[] {
  const text = chunk.text;
  const exclusions = collectExclusions(text);
  const out: Candidate[] = [];

  // Percent first: bare-money detection must not swallow the digits in `55%`.
  addRegexMatches(out, text, PERCENT_RE, 'PERCENT', chunkIdx, exclusions);
  const percentSpans = out.slice();

  // Spelled amounts before the numeric regexes: the figure candidate claims
  // its range (with the shared key) before the numeric scanners see it.
  collectSpelledAmounts(out, text, chunkIdx, exclusions);

  const money: Candidate[] = [];
  addRegexMatches(money, text, SYMBOL_MONEY_RE, 'MONEY', chunkIdx, exclusions);
  addRegexMatches(money, text, CODE_MONEY_RE, 'MONEY', chunkIdx, exclusions);
  addRegexMatches(money, text, THOUSANDS_RE, 'MONEY', chunkIdx, exclusions);
  addRegexMatches(money, text, ID_THOUSANDS_RE, 'MONEY', chunkIdx, exclusions);
  addRegexMatches(money, text, DECIMAL_RE, 'MONEY', chunkIdx, exclusions);
  addBareIntegerMoney(money, text, chunkIdx, exclusions, percentSpans);
  out.push(...money);

  addCaptureMatches(out, text, PARTNER_WITH_RE, 'NAME', chunkIdx, exclusions, 'PARTNER');
  addCaptureMatches(out, text, PARTNER_ROLE_RE, 'NAME', chunkIdx, exclusions, 'PARTNER');
  addCaptureMatches(out, text, PARTNER_AND_RE, 'NAME', chunkIdx, exclusions, 'PARTNER');
  addCaptureMatches(out, text, VENTURE_PAREN_RE, 'NAME', chunkIdx, exclusions, 'VENTURE');
  addCaptureMatches(out, text, VENTURE_THE_RE, 'NAME', chunkIdx, exclusions, 'VENTURE');
  addCaptureMatches(out, text, VENTURE_COOWNED_RE, 'NAME', chunkIdx, exclusions, 'VENTURE');
  addCaptureMatches(out, text, VENTURE_ALIAS_RE, 'NAME', chunkIdx, exclusions, 'VENTURE', (v) =>
    VENTURE_ALIAS_GENERIC.has(v.trim().toLowerCase()),
  );
  // Before the SKU scanners: on the same range (and the suffix-bearing name
  // wins overlap against any shorter SKU capture inside it).
  addCaptureMatches(out, text, VENTURE_SUFFIX_RE, 'NAME', chunkIdx, exclusions, 'VENTURE');
  // People who sign/approve are PARTNER; the frozen EntityType contract has
  // no PERSON type, so prose persons get PARTNER too (strongest sweep:
  // Pass A full name + Pass B first/last word, mirrored by the gate).
  addCaptureMatches(out, text, PERSON_PROSE_RE, 'NAME', chunkIdx, exclusions, 'PARTNER', isPersonStop);
  addCaptureMatches(out, text, PERSON_BLOCK_RE, 'NAME', chunkIdx, exclusions, 'PARTNER', isPersonStop);
  addCaptureMatches(out, text, PERSON_HONORIFIC_RE, 'NAME', chunkIdx, exclusions, 'PARTNER', isPersonStop);
  addCaptureMatches(
    out,
    text,
    SKU_PREFIX_RE,
    'NAME',
    chunkIdx,
    exclusions,
    'SKU',
    (value, after) =>
      isSkuLabel(value) || SUFFIX_AFTER_RE.test(after) || SUFFIX_VALUE_RE.test(value),
  );
  addCaptureMatches(
    out,
    text,
    SKU_SUFFIX_RE,
    'NAME',
    chunkIdx,
    exclusions,
    'SKU',
    (value, after) =>
      isSkuLabel(value) || SUFFIX_AFTER_RE.test(after) || SUFFIX_VALUE_RE.test(value),
  );

  return out;
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byRange = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.chunkIdx}|${candidate.start}|${candidate.end}`;
    const existing = byRange.get(key);
    if (!existing) {
      byRange.set(key, candidate);
    } else if (!existing.type && candidate.type) {
      existing.type = candidate.type;
    }
  }
  return [...byRange.values()];
}

// ---------------------------------------------------------- model + heuristics

function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as string[]).includes(value);
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redact timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function buildWindow(
  text: string,
  target: Candidate,
  chunkCandidates: Candidate[],
  ids: Map<Candidate, string>,
): string {
  let start = Math.max(0, target.start - 55);
  let end = Math.min(text.length, target.end + 55);

  const overlapping = chunkCandidates
    .filter((candidate) => candidate.start < end && candidate.end > start)
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  if (overlapping.length > 0) {
    start = Math.min(start, overlapping[0].start);
    end = Math.max(end, overlapping[overlapping.length - 1].end);
  }

  let out = '';
  let cursor = start;
  for (const candidate of overlapping) {
    if (candidate.start < cursor) continue;
    out += text.slice(cursor, candidate.start) + `[${ids.get(candidate) ?? 'SPAN'}]`;
    cursor = candidate.end;
  }
  out += text.slice(cursor, end);
  return out;
}

async function tagWithModel(
  ambiguous: Candidate[],
  chunks: DocChunk[],
  all: Candidate[],
): Promise<void> {
  const targets = ambiguous.filter((c) => c.kind === 'MONEY' || c.kind === 'PERCENT');
  if (targets.length === 0) return;

  const ids = new Map<Candidate, string>();
  all.forEach((candidate, index) => ids.set(candidate, `SPAN_${index}`));

  const byChunk = new Map<number, Candidate[]>();
  for (const candidate of all) {
    const list = byChunk.get(candidate.chunkIdx) ?? [];
    list.push(candidate);
    byChunk.set(candidate.chunkIdx, list);
  }

  const lines: string[] = [];
  for (const target of targets) {
    const chunk = chunks[target.chunkIdx];
    if (!chunk) continue;
    const window = buildWindow(
      chunk.text,
      target,
      byChunk.get(target.chunkIdx) ?? [],
      ids,
    ).replace(/\s+/g, ' ').trim();
    lines.push(`[${ids.get(target)}]: "${window}"`);
  }
  if (lines.length === 0) return;

  const prompt = [
    'Tag each placeholder with its business entity type.',
    `Allowed types: ${MODEL_ENTITY_TYPES.join(', ')}.`,
    'Return JSON: {"assignments":[{"id":"SPAN_0","type":"COST"}]}',
    'Contexts:',
    ...lines,
  ].join('\n');

  try {
    const result = await withTimeout(generate('redact', prompt, REDACT_SCHEMA), 8000);
    const parsed = JSON.parse(stripFences(result.text)) as { assignments?: unknown };
    if (!Array.isArray(parsed.assignments)) return;
    for (const entry of parsed.assignments) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const rawId = String(record.id ?? '');
      const type = record.type;
      if (!isEntityType(type) || type === 'VALUE') continue;
      const digits = rawId.replace(/[^0-9]/g, '');
      if (!digits) continue;
      const index = Number(digits);
      if (!Number.isInteger(index) || index < 0 || index >= all.length) continue;
      const candidate = all[index];
      if (targets.includes(candidate)) candidate.type = type;
    }
  } catch {
    // Stub / no on-device model / bad output: heuristics take over.
  }
}

interface ContextWindow {
  text: string;
  start: number;
  window: string;
  from: number;
  center: number;
}

function windowFor(text: string, start: number, end: number): ContextWindow {
  const from = Math.max(0, start - 160);
  const to = Math.min(text.length, end + 160);
  return {
    text,
    start,
    window: text.slice(from, to).toLowerCase(),
    from,
    center: (start + end) / 2,
  };
}

/** Minimum distance from the span centre to a keyword match, or undefined if absent. */
function nearestDistance(
  window: string,
  from: number,
  center: number,
  re: RegExp,
): number | undefined {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  let best: number | undefined;
  while ((match = re.exec(window))) {
    const distance = Math.abs(from + match.index + match[0].length - center);
    if (best === undefined || distance < best) best = distance;
  }
  return best;
}

/** In a markdown table, the nearest keyword is the header above the same column. */
function tableColumnType(text: string, start: number): EntityType | undefined {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = text.length;
  const row = text.slice(lineStart, lineEnd);
  if (!/^\s*\|/.test(row)) return undefined;

  const column = (row.slice(0, start - lineStart).match(/\|/g) ?? []).length - 1;
  if (column < 0) return undefined;

  let cursor = lineStart - 1;
  while (cursor >= 0) {
    const prevStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const candidate = text.slice(prevStart, cursor);
    if (!/^\s*\|/.test(candidate)) return undefined; // not a contiguous table (review F2)
    if (/^\s*\|[\s|:-]+\|\s*$/.test(candidate)) {
      // The header is the line directly above the markdown separator row.
      const headerEnd = prevStart - 1;
      const headerStart = text.lastIndexOf('\n', headerEnd - 1) + 1;
      const header = text.slice(headerStart, headerEnd);
      const cell = (header.split('|')[column + 1] ?? '').trim().toLowerCase();
      // Word-boundary keywords (review F3): 'rate' must not match 'Corporate'.
      if (/\b(cost|cogs|modal|harga)\b/.test(cell)) return 'COST';
      if (/\b(retail|price|sell|jual|rate|fee|invoice|charge)\b/.test(cell)) return 'PRICE';
      return undefined;
    }
    if (prevStart === 0) break;
    cursor = prevStart - 1;
  }
  return undefined;
}

function classifyPercent(context: ContextWindow): EntityType {
  const { window, from, center } = context;
  const floor = nearestDistance(window, from, center, /(margin\s+floor|floor)/g);
  const discount = nearestDistance(window, from, center, /(discount|cap)/g);
  if (floor !== undefined && discount !== undefined) {
    return floor <= discount ? 'MARGIN_FLOOR' : 'DISCOUNT_CAP';
  }
  if (floor !== undefined) return 'MARGIN_FLOOR';
  if (discount !== undefined) return 'DISCOUNT_CAP';
  return /margin/.test(window) ? 'MARGIN_FLOOR' : 'DISCOUNT_CAP';
}

function classifyMoney(context: ContextWindow): EntityType | undefined {
  const { text, start, window, from, center } = context;
  const columnType = tableColumnType(text, start);
  if (columnType) return columnType;
  const cost = nearestDistance(window, from, center, /(cost|cogs|modal|harga)/g);
  const price = nearestDistance(
    window,
    from,
    center,
    /(retail|price|sell|jual|rate|fee|invoice|charge)/g,
  );
  if (cost !== undefined && price !== undefined) return cost <= price ? 'COST' : 'PRICE';
  if (cost !== undefined) return 'COST';
  if (price !== undefined) return 'PRICE';
  return undefined;
}

function normalizeValue(text: string): string {
  return text
    .toLowerCase()
    .replace(/[$€£¥₹]/g, '')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// --------------------------------------------------------------- tokenisation

function assignTokens(candidates: Candidate[]): Record<string, string> {
  const counters = new Map<EntityType, number>();
  const tokens = new Map<string, string>();
  const tokenMap: Record<string, string> = {};

  for (const candidate of candidates) {
    const type = candidate.type ?? 'COST';
    const key = `${type}|${candidate.key ?? normalizeValue(candidate.text)}`;
    let token = tokens.get(key);
    if (!token) {
      const next = (counters.get(type) ?? 0) + 1;
      counters.set(type, next);
      token = `[${type}_${next}]`;
      tokens.set(key, token);
      tokenMap[token] = candidate.text;
    }
    candidate.token = token;
  }
  return tokenMap;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sweptEntityType(token: string): EntityType | undefined {
  const match = /^\[([A-Z]+)_\d+\]$/.exec(token);
  if (!match) return undefined;
  const type = match[1];
  return type === 'PARTNER' || type === 'VENTURE' || type === 'SKU' ? type : undefined;
}

/** Redact further occurrences of full entity values, then partner first/last names. */
function sweepValues(
  chunks: DocChunk[],
  candidates: Candidate[],
  tokenMap: Record<string, string>,
): void {
  const rangesByChunk: Range[][] = chunks.map(() => []);
  for (const candidate of candidates) {
    rangesByChunk[candidate.chunkIdx]?.push({
      start: candidate.start,
      end: candidate.end,
    });
  }

  const add = (
    chunkIdx: number,
    start: number,
    end: number,
    text: string,
    token: string,
    type: EntityType,
  ): void => {
    if (overlapsAny(start, end, rangesByChunk[chunkIdx])) return;
    rangesByChunk[chunkIdx].push({ start, end });
    candidates.push({ chunkIdx, start, end, text, kind: 'NAME', type, token });
  };

  // Pass A: every full PARTNER/VENTURE/SKU value at EVERY occurrence across
  // all chunks, with the same token (longest phrase first). Case-insensitive
  // because the gate matches text values with 'i': a value detected once
  // ("SCHEDULE A", "Sari Dewi") that survives as "Schedule A" elsewhere both
  // trips the gate and leaves the blinded text inconsistent. Numbers keep
  // their own path (Pass C, numeric-form closure).
  const phrases: { value: string; token: string; type: EntityType }[] = [];
  for (const [token, value] of Object.entries(tokenMap)) {
    const type = sweptEntityType(token);
    if (!type || value.trim().length < 2) continue;
    phrases.push({ value: value.trim(), token, type });
  }
  phrases.sort((a, b) => b.value.length - a.value.length);

  for (const { value, token, type } of phrases) {
    const re = new RegExp(`\\b${escapeRegExp(value)}\\b`, 'gi');
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
      const text = chunks[chunkIdx].text;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        add(chunkIdx, match.index, match.index + match[0].length, match[0], token, type);
      }
    }
  }

  // Pass B: standalone first/last names for PARTNER tokens only.
  const sweptNames = new Set<string>();
  for (const [token, value] of Object.entries(tokenMap)) {
    if (sweptEntityType(token) !== 'PARTNER') continue;
    const words = value.trim().split(/\s+/);
    if (words.length < 2) continue;
    for (const word of [words[0], words[words.length - 1]]) {
      if (word.length < 2) continue;
      const key = `${token}|${word}`;
      if (sweptNames.has(key)) continue;
      sweptNames.add(key);
      // 'gi' mirrors the gate's PARTNER first/last-word matcher (case-insensitive).
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
        const text = chunks[chunkIdx].text;
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text))) {
          add(chunkIdx, match.index, match.index + match[0].length, match[0], token, 'PARTNER');
        }
      }
    }
  }

  // Pass C: numeric collision sweep. The fail-closed pre-send gate (findLeakedValues)
  // flags any known token value's numeric forms appearing verbatim in an outbound
  // prompt — e.g. known '[DISCOUNT_CAP_2]' = '60%' collides with a bare '60 units'
  // no detector tagged. Blind each collision occurrence with a NEUTRAL '[VALUE_x]'
  // token: it claims no semantic type (so the cloud extractor and the local Deal
  // Simulator cannot bind it to a deal rule), and is minted per exact matched
  // form (so one token always maps to one literal value). Index numbers skip
  // known collision forms so token text cannot re-trip the numeric gate.
  // Boundary regex is shared with the gate (splitNumber/numericForms/escapeRe) so
  // sweep and gate cannot drift apart.
  // Seed from ALL pre-sweep candidate texts (what the gate later knows via
  // chunk.detected — which keeps every distinct raw span text, while tokenMap
  // keeps only one format per token), then CLOSE the form set under
  // splitNumber -> numericForms: each swept form becomes a registered known
  // value at gate time, and the gate re-expands every known value's numeric
  // forms (e.g. VALUE '1250' re-adds forms '1,250' / '1.250'), so the sweep
  // set must contain the full closure or Pass C self-blocks the payload.
  const collisionForms = new Set<string>();
  const formQueue: string[] = [];
  const expand = (value: string): void => {
    const num = splitNumber(value);
    if (num === null || num.int.length < 2) return;
    for (const form of numericForms(num.int, num.dec)) {
      if (!collisionForms.has(form)) formQueue.push(form);
    }
  };
  for (const candidate of candidates) expand(candidate.text);
  while (formQueue.length > 0) {
    const form = formQueue.pop()!;
    if (collisionForms.has(form)) continue;
    collisionForms.add(form);
    expand(form);
  }
  const valueTokenForForm = new Map<string, string>();
  // Start indices high (9001+): if a downstream digit-parser (e.g. qtyOf on a
  // blinded min_qty_condition) ever reads a VALUE token index as a number, the
  // threshold degrades conservatively (unreachable) instead of eagerly (2, 4...).
  // Indices also skip numbers that are themselves known collision forms so the
  // token text can never re-trip the numeric gate (e.g. [VALUE_28] vs '28').
  let valueIndex = 9000;
  // Longest forms first for deterministic token assignment. Boundaries are
  // DIGIT-ONLY here (stricter than the gate's): the gate also skips matches
  // preceded by digit+separator (e.g. '55' in '10.55'), but blinding a NEIGHBOR
  // of that match flips its boundary post-blinding ('10.55' -> '[VALUE_A].55'
  // now trips the gate on '55'). Sweeping the superset leaves no gate-visible
  // literal anywhere and can only over-blind (safe direction).
  for (const form of [...collisionForms].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![0-9])${escapeRe(form)}(?![0-9])`, 'g');
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
      const text = chunks[chunkIdx].text;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        if (overlapsAny(match.index, match.index + match[0].length, rangesByChunk[chunkIdx])) {
          // A skipped overlapping match must not advance lastIndex past its
          // interior: self-overlapping forms ('100.100' inside '§500.100.100')
          // can start a DISJOINT blindable occurrence inside the skipped span.
          // Monotonic +1 keeps termination.
          re.lastIndex = match.index + 1;
          continue;
        }
        let token = valueTokenForForm.get(form);
        if (!token) {
          do {
            valueIndex += 1;
          } while (collisionForms.has(String(valueIndex)));
          token = `[VALUE_${valueIndex}]`;
          valueTokenForForm.set(form, token);
        }
        add(chunkIdx, match.index, match.index + match[0].length, match[0], token, 'VALUE');
      }
    }
  }
  for (const [form, token] of valueTokenForForm) tokenMap[token] = form;
}

// ------------------------------------------------------------------- blinding

function overlaps(a: Candidate, b: Candidate): boolean {
  return a.start < b.end && a.end > b.start;
}

function resolveOverlaps(chunkCandidates: Candidate[]): Candidate[] {
  const longestFirst = [...chunkCandidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const accepted: Candidate[] = [];
  for (const candidate of longestFirst) {
    if (!accepted.some((other) => overlaps(candidate, other))) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

// ----------------------------------------------------------------------- main

export async function anonymizeChunks(chunks: DocChunk[]): Promise<AnonymizeResult> {
  const all = dedupeCandidates(
    chunks.flatMap((chunk, chunkIdx) => detectInChunk(chunk, chunkIdx)),
  );
  all.sort(
    (a, b) =>
      a.chunkIdx - b.chunkIdx ||
      a.start - b.start ||
      b.end - b.start - (a.end - a.start),
  );

  // Entity reading beats person reading: a value detected as VENTURE/SKU
  // anywhere ("Bright Sprouts" with a company keyword in one chunk) must not
  // get a second PARTNER token where a person-context regex happens to
  // precede it ("referring again to Bright Sprouts"). One value, one token.
  const nameTypes = new Map<string, EntityType>();
  for (const candidate of all) {
    if (candidate.kind !== 'NAME' || !candidate.type) continue;
    const value = normalizeValue(candidate.text);
    if (!nameTypes.has(value) || nameTypes.get(value) === 'PARTNER') {
      nameTypes.set(value, candidate.type);
    }
  }
  for (const candidate of all) {
    if (candidate.kind === 'NAME' && candidate.type) {
      candidate.type = nameTypes.get(normalizeValue(candidate.text)) ?? candidate.type;
    }
  }

  const ambiguous = all.filter((candidate) => !candidate.type);
  await tagWithModel(ambiguous, chunks, all);

  // Deterministic heuristics fill anything the model did not tag.
  const typedByValue = new Map<string, EntityType>();
  const valueKey = (candidate: Candidate): string =>
    `${candidate.kind}|${candidate.key ?? normalizeValue(candidate.text)}`;
  for (const candidate of all) {
    if (!candidate.type) continue;
    typedByValue.set(valueKey(candidate), candidate.type);
  }

  for (const candidate of all) {
    if (candidate.type) continue;
    const chunk = chunks[candidate.chunkIdx];
    if (!chunk) continue;
    const context = windowFor(chunk.text, candidate.start, candidate.end);

    if (candidate.kind === 'PERCENT') {
      candidate.type = typedByValue.get(valueKey(candidate)) ?? classifyPercent(context);
    } else if (candidate.kind === 'MONEY') {
      const moneyType = classifyMoney(context);
      candidate.type =
        moneyType ?? typedByValue.get(valueKey(candidate)) ?? 'COST';
    }
    if (candidate.type) {
      const key = valueKey(candidate);
      if (!typedByValue.has(key)) typedByValue.set(key, candidate.type);
    }
  }
  for (const candidate of all) {
    if (!candidate.type) candidate.type = 'COST';
  }

  // Resolve per-chunk span overlaps BEFORE token assignment and sweeps: a
  // candidate that later loses to a longer overlapping span must not reserve a
  // range in sweepValues — otherwise Pass C skips the dropped span's uncovered
  // prefix/suffix and a known numeric value can leak into the blinded text
  // ('15.20' losing to '20.50%' would leave literal '15'). This also stops
  // dropped sub-matches from getting phantom tokenMap entries.
  const resolved: Candidate[] = [];
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
    resolved.push(...resolveOverlaps(all.filter((candidate) => candidate.chunkIdx === chunkIdx)));
  }

  const tokenMap = assignTokens(resolved);
  sweepValues(chunks, resolved, tokenMap);

  const blinded: AnonymizedChunk[] = chunks.map((chunk, chunkIdx) => {
    const chunkCandidates = resolved.filter((candidate) => candidate.chunkIdx === chunkIdx);
    const accepted = resolveOverlaps(chunkCandidates);
    const detected: DetectedSpan[] = [];

    let text = '';
    let cursor = 0;
    for (const candidate of accepted) {
      if (candidate.start < cursor || !candidate.token || !candidate.type) continue;
      text += chunk.text.slice(cursor, candidate.start) + candidate.token;
      cursor = candidate.end;
      detected.push({
        text: candidate.text,
        token: candidate.token,
        type: candidate.type,
      });
    }
    text += chunk.text.slice(cursor);

    return {
      docName: chunk.docName,
      page: chunk.page,
      index: chunk.index,
      text,
      detected,
    };
  });

  return { blinded, tokenMap };
}
