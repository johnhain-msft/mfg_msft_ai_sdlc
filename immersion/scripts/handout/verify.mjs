/**
 * Guards for the customer handout. Pure functions (no I/O) so the build and the tests share them.
 *
 * The handout is authored in scripts/handout/notes.mjs from the presenter script. These guards make
 * three promises the author cannot keep by eye alone:
 *
 *   1. COVERAGE   every slide has notes, and no notes exist for a slide that does not.
 *   2. NO LEAKS   no stage direction, room mechanic, speaker tag, hand-off, presenter name, confidential
 *                 term, internal preparation note, ledger code or time-bound room reference survives into
 *                 the reader-facing text.
 *   3. GROUNDED   every number in the notes also appears in the slide, its script, its sources or the
 *                 glossary (digits or spelled out). A figure cannot be introduced by the editing pass.
 *
 * The repository carries no customer, engagement or person names. Presenter names are read from the deck
 * itself (presenterRules), and any confidential term a maintainer knows of is supplied at run time
 * (termRules; the build reads HANDOUT_CONFIDENTIAL_TERMS), so the guard stays strict without storing a name.
 */

import { plain } from './compose.mjs';

// --------------------------------------------------------------------------- banned phrases

/** [pattern, why]. Applied to authored notes, source labels and (outside the slides) the final document text. */
export const BANNED = [
  // stage directions and room mechanics
  [/\b(?:SHOW|POINT|CLICK|WAIT|SWITCH|ASK|POLL|NEXT|NOTE)\s*:/, 'stage direction cue'],
  [/story\s*slot/i, 'story-slot placeholder'],
  [/\bpress (?:space|enter|the)\b/i, 'UI mechanic'],
  [/\b(?:hover|tab onto)\b/i, 'UI mechanic'],
  [/\b(?:tap|click) (?:the|a|each)\b/i, 'UI mechanic'],
  [/\bcall out\b/i, 'room polling'],
  [/\bquick hands\b|\bhands,? or\b|\braise[d]? (?:your )?hands?\b/i, 'room polling'],
  [/\bin chat\b|\bteams chat\b|\bby voice\b/i, 'room polling'],
  [/\btally\b|\btallies\b/i, 'room polling'],
  [/i['\u2019]ll wait\b|don['\u2019]t be generous|this is for you, not for (?:us|me)/i, 'room polling'],
  // speakers and hand-offs (the presenter's own name is added per deck by presenterRules)
  [/^\s*\[[A-Z][\w'\u2019. -]{0,30}\]/m, 'speaker tag'],
  [/\bover to you\b|\btakes? it from here\b/i, 'presenter hand-off'],
  [/\bi['\u2019]ll take\b|\btakes the (?:rest|next|first|last)\b/i, 'presenter hand-off'],
  [/\bgood (?:morning|afternoon|evening)\b|\bwelcome,? everyone\b/i, 'room greeting'],
  [/\b(?:you|they|your (?:team|organi[sz]ation)|the (?:team|audience)) (?:asked|requested) us\b|i['\u2019]ll give you the pattern/i, 'meta commentary about the audience'],
  // confidential preparation notes and internal references
  [/sister[\s-]*compan|customer[\s-]*sync/i, 'customer-sync anecdote (confidential)'],
  [/\bpre-?flight\b/i, 'internal pre-flight note'],
  [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:['\u2019]s)?\s+(?:panel|session|workshop|keynote|talk)\b/i, 'reference to another session'],
  [/\bthis morning\b|\blater today\b|\bthe break runs\b|\bnext week\b/i, 'time-bound room reference'],
  [/\bledger\b/i, 'internal claim ledger'],
  [/\bC(?:0[1-9]|1[0-9])\b/, 'claim ledger code'],
  [/\bpresenter\b|\bspeaker\b/i, 'presenter-only language'],
  [/before the script is final|\bparaphrases?\b/i, 'internal editing note'],
  [/no source we|we hold no|we hold a\b|\bwe hold\b/i, 'internal sourcing note'],
  [/\bTODO\b|\bTBD\b|\bFIXME\b|\blorem\b|\bplaceholder\b/i, 'scaffolding marker'],
  [/[A-Za-z]:\\Users\\|\/Users\/|\/home\//i, 'absolute local path'],
];

/**
 * The same list for the deck's own slide markup. A slide legitimately carries the presenter byline, which is why
 * presenterRules (per deck) is applied outside the slides only; confidential terms apply everywhere.
 */
export const BANNED_IN_SLIDES = BANNED;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One rule per presenter the deck declares: the full name and each name part. Read from the deck, never typed here. */
export function presenterRules(deck) {
  return Object.values(deck.meta.presenters).map(({ name }) => {
    const alternatives = [name, ...name.split(/\s+/).filter((part) => part.length >= 3)].map(reEscape);
    return [new RegExp(`\\b(?:${alternatives.join('|')})\\b`, 'i'), 'presenter name in notes'];
  });
}

/** One rule per confidential term supplied at run time. The repository stores none; whoever knows a term passes it in. */
export function termRules(terms = []) {
  return terms
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => [new RegExp(`\\b${reEscape(term)}\\b`, 'i'), 'confidential term']);
}

export function findBanned(text, list = BANNED) {
  const hits = [];
  for (const [rx, why] of list) {
    const m = rx.exec(text);
    if (m) hits.push({ match: m[0], why });
  }
  return hits;
}

// --------------------------------------------------------------------------- numbers

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Numbers spelled out in prose ("forty-one", "two hundred forty-nine thousand", "a hundred") as digit strings. */
export function spelledNumbers(text) {
  const out = new Set();
  const toks = text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let part = 0;
  let last = null; // null | 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand'
  const flush = () => {
    if (last) out.add(String(total + part));
    total = 0;
    part = 0;
    last = null;
  };
  const after = (...kinds) => kinds.includes(last);
  for (const t of toks) {
    if (t in UNITS) {
      const n = UNITS[t];
      const kind = n >= 10 ? 'teen' : 'unit';
      // "forty nine", "two hundred five": a unit continues a number only after tens, hundred or thousand
      if (!(kind === 'unit' && after('tens', 'hundred', 'thousand')) && !(kind === 'teen' && after('hundred', 'thousand'))) flush();
      part += n;
      last = kind;
    } else if (t in TENS) {
      if (!after('hundred', 'thousand')) flush();
      part += TENS[t];
      last = 'tens';
    } else if (t === 'hundred') {
      if (!after('unit')) flush();
      part = (part || 1) * 100;
      last = 'hundred';
    } else if (t === 'thousand') {
      if (!after('unit', 'teen', 'tens', 'hundred')) flush();
      total += (part || 1) * 1000;
      part = 0;
      last = 'thousand';
    } else if (t === 'and' && after('hundred', 'thousand')) {
      // "two hundred and five"
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Digit numbers in text, commas removed ("150,000" -> "150000"). Slide cross-references are not claims. */
export function digitNumbers(text) {
  const cleaned = text.replace(/\bslides?\s+\d+(?:\s*[\u2013-]\s*\d+)?/gi, ' ');
  return [...cleaned.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, '').replace(/\.$/, ''));
}

const svgText = (svg = '') => [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1]).join(' ');

/** Every string a slide (and its supporting content) says: the corpus its notes may draw numbers from. */
export function corpusFor(slide, deck) {
  const parts = [slide.kicker, slide.title, slide.lead, slide.stat, slide.note, slide.purpose, slide.roomSees];
  for (const b of slide.blocks) {
    if (b.kind === 'table') parts.push(...b.rows.flat());
    else if (b.kind === 'chip' || b.kind === 'label') parts.push(b.text);
    else parts.push(b.head, b.body);
  }
  if (slide.diagram) parts.push(svgText(slide.diagram.svg), slide.diagram.title);
  for (const b of slide.script) parts.push(b.text, b.code);
  for (const s of slide.sources) parts.push(s.label, s.url);
  for (const g of deck.glossary) if ((g.slides ?? []).includes(slide.id)) parts.push(g.term, g.definition);
  const { meta } = deck;
  parts.push(meta.title, meta.subtitle, meta.event, meta.session);
  return parts.filter(Boolean).join(' \n ');
}

/** All authored strings of one notes entry, for scanning. */
export function authoredStrings(entry) {
  const out = [entry.summary, entry.reflect, ...(entry.body ?? [])];
  const x = entry.extra;
  if (x) {
    out.push(x.title, x.foot);
    for (const r of x.rows ?? []) out.push(...r);
    out.push(...(x.head ?? []));
    for (const it of x.items ?? []) {
      if (Array.isArray(it)) out.push(...it);
      else out.push(it.tag, it.title, it.body, it.explain, ...(it.options ?? []), ...(it.bullets ?? []));
    }
  }
  return out.filter(Boolean).map(plain);
}

// --------------------------------------------------------------------------- the checks

/**
 * `terms` are confidential terms supplied at run time (see termRules); the deck's own presenter names are always banned.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function checkNotes({ deck, notes, sourceLabel = (l) => l, terms = [] }) {
  const errors = [];
  const banned = [...BANNED, ...presenterRules(deck), ...termRules(terms)];
  const ids = new Set(deck.slides.map((s) => s.id));
  for (const id of Object.keys(notes)) if (!ids.has(id)) errors.push(`notes: "${id}" is not a slide in the deck`);

  for (const slide of deck.slides) {
    const entry = notes[slide.id];
    if (!entry) {
      errors.push(`notes: slide ${slide.id} has no companion notes`);
      continue;
    }
    if (!entry.summary) errors.push(`${slide.id}: missing summary`);
    if (!entry.body?.length && !entry.extra) errors.push(`${slide.id}: needs a body or an extra block`);

    const strings = authoredStrings(entry);
    for (const s of strings) {
      for (const h of findBanned(s, banned)) errors.push(`${slide.id}: banned phrase "${h.match}" (${h.why}) in: ${s.slice(0, 90)}`);
    }

    // numbers must come from the slide, its script or its glossary entries
    const corpus = corpusFor(slide, deck);
    const known = new Set([...digitNumbers(corpus), ...spelledNumbers(corpus), ...(entry.allowNumbers ?? [])]);
    const used = new Set(strings.flatMap((s) => digitNumbers(s)));
    const stray = [...used].filter((n) => !known.has(n));
    if (stray.length) errors.push(`${slide.id}: number(s) not found in the slide, its script or glossary: ${stray.join(', ')} (add to allowNumbers only if sourced)`);

    for (const src of slide.sources) {
      for (const h of findBanned(sourceLabel(src.label), banned)) errors.push(`${slide.id}: source label "${src.label}" has banned phrase "${h.match}" (${h.why})`);
    }
  }
  return { errors, warnings: [] };
}

/**
 * Final-document text check, with the slide markup removed (it is scanned separately). The presenter's name is
 * banned outside the slides only, because the cover slide carries the byline; confidential terms are banned everywhere.
 */
export function checkDocumentText({ textOutsideSlides, textInSlides, deck, terms = [] }) {
  const errors = [];
  const confidential = termRules(terms);
  const outside = [...BANNED, ...(deck ? presenterRules(deck) : []), ...confidential];
  for (const h of findBanned(textOutsideSlides, outside)) errors.push(`document: banned phrase "${h.match}" (${h.why})`);
  for (const h of findBanned(textInSlides, [...BANNED_IN_SLIDES, ...confidential])) errors.push(`slides: banned phrase "${h.match}" (${h.why})`);
  return errors;
}
