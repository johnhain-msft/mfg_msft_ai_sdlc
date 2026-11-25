/**
 * Content rules for the AI-DLC Immersion deck: the static twin of the deck-density and slide-review gates.
 *
 * Everything here measures the way `deck-density.py` measures, so a deck that passes
 * `node scripts/build.mjs --strict` is counted identically by the real tool:
 *
 *   words()      [A-Za-z0-9][A-Za-z0-9\-\u2019'.]*  (global)   visible-word budget, anchors, overlap
 *   bodyWords()  [A-Za-z0-9_\u2019'\-]+             (global)   hollow-container floor (slide-review's tokenizer)
 *
 * Rules
 *   words.target / words.ceiling   <= 58 visible words (warning), <= 90 (error)
 *   anchors.max                    <= 14 competing blocks
 *   container.hollow / .overfull   7-14 body words under BOTH tokenizers, so hollow_container is 0%
 *   seen-said.verbatim / .shingle  0% 8-word lift and < 10% 5-word shingle overlap, ON SCREEN vs `say` beats
 *   diagram.font                   every SVG text at least 22px, each with its own explicit font-size
 *   art.text                       container art (decorative SVG inside a card or tile) carries no text
 *   structure.*                    ids, modules, voices, scripts, widget wiring
 *   twin.*                         the rendered HTML and generated markdown agree with the model
 *
 * Pure functions only: no DOM, no filesystem, no clock.
 *
 * PACING IS DELIBERATELY ABSENT. Per John's explicit direction there is no words-per-minute math,
 * no minutes budget and no countdown anywhere in this module. Humans manage pacing in the room.
 */

import {
  LAYOUT_ARCHETYPES,
  isChip,
  isContainer,
  isLabel,
  isTable,
  type Container,
  type Deck,
  type Slide,
} from './types';
import { validateWidget } from '../widgets/validate';

// --------------------------------------------------------------------------- limits

export const LIMITS = {
  /** Visible words per slide: above this is a warning. */
  wordsTarget: 58,
  /** Hard ceiling: above this is an error. */
  wordsCeiling: 90,
  /** Competing content anchors per slide. */
  anchorsMax: 14,
  /** Hollow-container floor and ceiling, in non-heading body words. */
  bodyMin: 7,
  bodyMax: 14,
  /** Seen/said: percent of spoken words inside shared 5-word runs (exclusive upper bound). */
  lift5MaxPct: 10,
  /** Seen/said: percent of spoken words inside verbatim 8-word runs lifted from the slide. */
  lift8MaxPct: 0,
  /** Minimum SVG text size in px, so glyphs stay >= 18px at laptop sizes. */
  diagramMinFontPx: 22,
} as const;

// --------------------------------------------------------------------------- tokenizers

export const WORDS_RE = /[A-Za-z0-9][A-Za-z0-9\-\u2019'.]*/g;
export const BODY_WORDS_RE = /[A-Za-z0-9_\u2019'-]+/g;

/** deck-density `words()`: the visible-word budget tokenizer. */
export function words(text: string): string[] {
  return text.match(WORDS_RE) ?? [];
}

/** deck-density `body_words()`: slide-review's tokenizer, used for the hollow floor. */
export function bodyWords(text: string): string[] {
  return text.match(BODY_WORDS_RE) ?? [];
}

const lower = (tokens: string[]): string[] => tokens.map((t) => t.toLowerCase());

// --------------------------------------------------------------------------- findings

export type Severity = 'error' | 'warning';

export type RuleId =
  | 'words.target'
  | 'words.ceiling'
  | 'anchors.max'
  | 'container.hollow'
  | 'container.overfull'
  | 'seen-said.verbatim'
  | 'seen-said.shingle'
  | 'diagram.font'
  | 'art.text'
  | 'structure.id'
  | 'structure.duplicate-id'
  | 'structure.module'
  | 'structure.layout'
  | 'structure.voices'
  | 'structure.script'
  | 'structure.widget'
  | 'twin.words'
  | 'twin.anchors'
  | 'twin.containers'
  | 'twin.overlap'
  | 'twin.missing';

export interface Finding {
  /** Slide id, or `deck`. */
  slide: string;
  rule: RuleId;
  severity: Severity;
  message: string;
}

export function formatFinding(f: Finding): string {
  return `${f.severity === 'error' ? 'ERROR' : 'warn '} [${f.rule}] ${f.slide}: ${f.message}`;
}

// --------------------------------------------------------------------------- on-screen text

/** Text of every `<text>` element in an SVG fragment (LABELs). `<title>` and `<desc>` are not visible. */
export function diagramLabels(svg: string): string[] {
  const out: string[] = [];
  const re = /<text(?=[\s>/])[^>]*>([\s\S]*?)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    const inner = decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (inner) out.push(inner);
  }
  return out;
}

/**
 * Every visible chunk of a slide, in the order the renderer emits it:
 * kicker, title, lead, blocks, diagram labels, stat, note.
 * Diagram (SVG) labels are included even though deck-density.py skips SVG: stricter on purpose.
 */
export function screenChunks(slide: Slide): string[] {
  const c: string[] = [];
  const add = (t?: string) => {
    if (t && t.trim()) c.push(t.trim());
  };
  add(slide.kicker);
  add(slide.title);
  add(slide.lead);
  for (const b of slide.blocks) {
    if (isContainer(b)) {
      add(b.head);
      add(b.body);
    } else if (isTable(b)) {
      for (const row of b.rows) for (const cell of row) add(cell);
    } else if (isChip(b) || isLabel(b)) {
      add(b.text);
    }
  }
  if (slide.diagram) for (const l of diagramLabels(slide.diagram.svg)) add(l);
  add(slide.stat);
  add(slide.note);
  return c;
}

export const screenText = (slide: Slide): string => screenChunks(slide).join(' ');

/** Lower-cased `words()` tokens of everything the room can see. */
export const screenTokens = (slide: Slide): string[] => lower(words(screenText(slide)));

export const visibleWordCount = (slide: Slide): number => words(screenText(slide)).length;

/** Words in SVG labels only (these are not in the DOM text deck-density reads). */
export function svgLabelWordCount(slide: Slide): number {
  return slide.diagram ? diagramLabels(slide.diagram.svg).reduce((n, l) => n + words(l).length, 0) : 0;
}

/**
 * Competing anchors, the way deck-density counts block-level elements that carry text:
 * kicker, title, lead, stat and note one each; heading + body two per container; one per table.
 * Chips and labels are zero.
 */
export function anchorCount(slide: Slide): number {
  let n = 0;
  for (const t of [slide.kicker, slide.title, slide.lead, slide.stat, slide.note]) if (t && t.trim()) n += 1;
  for (const b of slide.blocks) {
    if (isContainer(b)) n += (b.head.trim() ? 1 : 0) + (b.body.trim() ? 1 : 0);
    else if (isTable(b)) n += 1;
  }
  return n;
}

// --------------------------------------------------------------------------- seen / said

const stripMarks = (t: string): string => t.replace(/[*_`]/g, '');

/**
 * What the presenter says. `say` beats only, because that is what survives in the markdown
 * script: cues are blockquotes and deck-density.py strips them. Pass `includeCues` for the
 * stricter measure (asks, polls and transitions are spoken too).
 */
export function spokenText(slide: Slide, opts: { includeCues?: boolean } = {}): string {
  const parts: string[] = [];
  for (const b of slide.script) {
    if (b.t === 'say') parts.push(b.text);
    else if (opts.includeCues) parts.push(b.text);
  }
  return parts.join(' ');
}

/** Port of deck-density `verbatim_overlap`: percent of script words inside verbatim n-word runs from the slide. */
export function verbatimOverlapPct(scriptTokens: string[], slideTokens: string[], n: number): number {
  if (scriptTokens.length < n || slideTokens.length < n) return 0;
  const grams = new Set<string>();
  for (let j = 0; j <= slideTokens.length - n; j++) grams.add(slideTokens.slice(j, j + n).join('\u0000'));
  const covered = new Array<boolean>(scriptTokens.length).fill(false);
  for (let j = 0; j <= scriptTokens.length - n; j++) {
    if (grams.has(scriptTokens.slice(j, j + n).join('\u0000'))) for (let k = j; k < j + n; k++) covered[k] = true;
  }
  return (100 * covered.filter(Boolean).length) / scriptTokens.length;
}

/** Percent of the script's distinct n-word shingles that also occur on the slide (the `set5` measure). */
export function shingleSetOverlapPct(scriptTokens: string[], slideTokens: string[], n: number): number {
  const shingles = (t: string[]) => {
    const s = new Set<string>();
    for (let i = 0; i <= t.length - n; i++) s.add(t.slice(i, i + n).join('\u0000'));
    return s;
  };
  const sp = shingles(scriptTokens);
  if (sp.size === 0) return 0;
  const sl = shingles(slideTokens);
  let shared = 0;
  for (const g of sp) if (sl.has(g)) shared += 1;
  return (100 * shared) / sp.size;
}

export interface SeenSaid {
  spokenWords: number;
  /** Percent of spoken words inside verbatim 8-word runs lifted from the slide. */
  lift8: number;
  /** Percent of spoken words inside shared 5-word runs. */
  lift5: number;
  /** Percent of distinct spoken 5-word shingles that appear on the slide. */
  set5: number;
}

export function seenSaid(slide: Slide, opts: { includeCues?: boolean } = {}): SeenSaid {
  const spoken = lower(words(stripMarks(spokenText(slide, opts))));
  const seen = screenTokens(slide);
  return {
    spokenWords: spoken.length,
    lift8: verbatimOverlapPct(spoken, seen, 8),
    lift5: verbatimOverlapPct(spoken, seen, 5),
    set5: shingleSetOverlapPct(spoken, seen, 5),
  };
}

// --------------------------------------------------------------------------- per-slide rules

function diagramFontFindings(slide: Slide): Finding[] {
  if (!slide.diagram) return [];
  const out: Finding[] = [];
  const re = /font-size\s*[:=]\s*["']?\s*([0-9]*\.?[0-9]+)\s*(px|pt)?/gi;
  for (const m of slide.diagram.svg.matchAll(re)) {
    const px = parseFloat(m[1]) * (m[2]?.toLowerCase() === 'pt' ? 4 / 3 : 1);
    if (px < LIMITS.diagramMinFontPx) {
      out.push({
        slide: slide.id,
        rule: 'diagram.font',
        severity: 'error',
        message: `SVG text at ${px.toFixed(1)}px is under the ${LIMITS.diagramMinFontPx}px minimum (diagram "${slide.diagram.id}")`,
      });
    }
  }
  // Every <text> must carry its own explicit size: an inherited or stylesheet size could silently
  // shrink a label below the legibility floor and this check would never see it.
  for (const m of slide.diagram.svg.matchAll(/<text(?=[\s>/])([^>]*)>/g)) {
    if (!/font-size\s*[:=]/i.test(m[1] ?? '')) {
      out.push({
        slide: slide.id,
        rule: 'diagram.font',
        severity: 'error',
        message: `an SVG <text> has no explicit font-size (diagram "${slide.diagram.id}"): ${(m[0] as string).slice(0, 60)}`,
      });
    }
  }
  return out;
}

/** Container art is decorative and must be word-free: any <text>, <tspan>, <title> or <desc> would escape the budget. */
function artFindings(slide: Slide): Finding[] {
  const out: Finding[] = [];
  for (const b of slide.blocks) {
    if (!isContainer(b) || !b.art) continue;
    if (/<(text|tspan|title|desc|foreignObject)(?=[\s>/])/i.test(b.art.svg)) {
      out.push({
        slide: slide.id,
        rule: 'art.text',
        severity: 'error',
        message: `${b.kind} [${b.head}] art carries text (<text>, <tspan>, <title>, <desc> or <foreignObject>); container art must be word-free`,
      });
    }
  }
  return out;
}

function containerFindings(slide: Slide): Finding[] {
  const out: Finding[] = [];
  for (const b of slide.blocks) {
    if (!isContainer(b)) continue;
    const w = words(b.body).length;
    const t = bodyWords(b.body).length;
    const lo = Math.min(w, t);
    const hi = Math.max(w, t);
    const label = `${b.kind} [${b.head}]`;
    if (lo < LIMITS.bodyMin) {
      out.push({
        slide: slide.id,
        rule: 'container.hollow',
        severity: 'error',
        message: `${label} has ${lo} body words (words()=${w}, body_words()=${t}); need ${LIMITS.bodyMin}-${LIMITS.bodyMax}`,
      });
    } else if (hi > LIMITS.bodyMax) {
      out.push({
        slide: slide.id,
        rule: 'container.overfull',
        severity: 'error',
        message: `${label} has ${hi} body words (words()=${w}, body_words()=${t}); need ${LIMITS.bodyMin}-${LIMITS.bodyMax}`,
      });
    }
  }
  return out;
}

/** Content rules for one slide. Structure rules need the whole deck: see `checkDeck`. */
export function checkSlide(slide: Slide): Finding[] {
  const out: Finding[] = [...diagramFontFindings(slide), ...artFindings(slide)];

  // A declared exemption covers the word budget AND the hollow floor, exactly as in deck-density.
  if (!slide.exempt) {
    const w = visibleWordCount(slide);
    if (w > LIMITS.wordsCeiling) {
      out.push({
        slide: slide.id,
        rule: 'words.ceiling',
        severity: 'error',
        message: `${w} visible words is over the ${LIMITS.wordsCeiling}-word ceiling`,
      });
    } else if (w > LIMITS.wordsTarget) {
      out.push({
        slide: slide.id,
        rule: 'words.target',
        severity: 'warning',
        message: `${w} visible words is over the ${LIMITS.wordsTarget}-word target`,
      });
    }
    const a = anchorCount(slide);
    if (a > LIMITS.anchorsMax) {
      out.push({
        slide: slide.id,
        rule: 'anchors.max',
        severity: 'error',
        message: `${a} competing anchors is over ${LIMITS.anchorsMax}`,
      });
    }
    out.push(...containerFindings(slide));
  }

  const ss = seenSaid(slide);
  if (ss.lift8 > LIMITS.lift8MaxPct) {
    out.push({
      slide: slide.id,
      rule: 'seen-said.verbatim',
      severity: 'error',
      message: `${ss.lift8.toFixed(1)}% of the spoken words sit inside verbatim 8-word runs lifted from the slide (limit ${LIMITS.lift8MaxPct}%)`,
    });
  }
  if (ss.lift5 >= LIMITS.lift5MaxPct || ss.set5 >= LIMITS.lift5MaxPct) {
    out.push({
      slide: slide.id,
      rule: 'seen-said.shingle',
      severity: 'error',
      message: `5-word overlap between slide and script is too high (lift ${ss.lift5.toFixed(1)}%, shingles ${ss.set5.toFixed(1)}%; limit < ${LIMITS.lift5MaxPct}%)`,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- structure rules

const RESERVED_IDS = new Set(['speaker', 'script', 'book']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function structureFindings(deck: Deck): Finding[] {
  const out: Finding[] = [];
  const err = (slide: string, rule: RuleId, message: string) => out.push({ slide, rule, severity: 'error', message });
  const moduleCodes = new Set(deck.modules.map((m) => m.code));
  const seen = new Set<string>();

  for (const s of deck.slides) {
    if (!ID_RE.test(s.id) || RESERVED_IDS.has(s.id) || /^s?\d+$/.test(s.id)) {
      err(s.id || '(empty id)', 'structure.id', 'id must be kebab-case and must not look like a slide number or a reserved route');
    }
    if (seen.has(s.id)) err(s.id, 'structure.duplicate-id', 'duplicate slide id');
    seen.add(s.id);
    if (!moduleCodes.has(s.moduleCode)) err(s.id, 'structure.module', `module ${s.moduleCode} is not defined`);
    if (!(LAYOUT_ARCHETYPES as readonly string[]).includes(s.layout)) {
      err(s.id, 'structure.layout', `unknown layout archetype "${s.layout}"`);
    }

    const says = s.script.filter((b) => b.t === 'say');
    if (says.length === 0) err(s.id, 'structure.script', 'the script needs at least one spoken (say) beat');
    // The markdown script reads a paragraph, so a line that looks like a quote, a heading or a bare [tag]
    // would be dropped as a direction and the spoken words would silently shrink.
    for (const b of says) {
      if (/^\s*(?:>|#{1,6}\s|\[[^\]]*\]\s*$)/m.test(b.text)) {
        err(s.id, 'structure.script', `a say beat has a line starting with ">", "#" or a bare [tag], which the script parser drops: "${b.text.slice(0, 40)}"`);
      }
    }

    // One presenter: every slide must name a presenter that the deck defines (name and organization).
    if (!deck.meta.presenters[s.presenter]) {
      err(s.id, 'structure.voices', `presenter "${s.presenter}" is not defined in deck.meta.presenters`);
    }

    for (const problem of validateWidget(s)) err(s.id, 'structure.widget', problem);
  }
  return out;
}

// --------------------------------------------------------------------------- deck check

export interface SlideMetrics {
  id: string;
  n: number;
  words: number;
  anchors: number;
  containers: number;
  spokenWords: number;
  lift8: number;
  lift5: number;
  set5: number;
  exempt: boolean;
}

export interface Report {
  findings: Finding[];
  errors: number;
  warnings: number;
  metrics: SlideMetrics[];
}

export function summarize(findings: Finding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
}

export function checkDeck(deck: Deck): Report {
  const findings: Finding[] = [...structureFindings(deck)];
  const metrics: SlideMetrics[] = [];
  deck.slides.forEach((s, i) => {
    findings.push(...checkSlide(s));
    const ss = seenSaid(s);
    metrics.push({
      id: s.id,
      n: i + 1,
      words: visibleWordCount(s),
      anchors: anchorCount(s),
      containers: s.blocks.filter(isContainer).length,
      spokenWords: ss.spokenWords,
      lift8: ss.lift8,
      lift5: ss.lift5,
      set5: ss.set5,
      exempt: Boolean(s.exempt),
    });
  });
  return { findings, ...summarize(findings), metrics };
}

// --------------------------------------------------------------------------- static twin: HTML

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'head']);
const RAW_TEXT = new Set(['script', 'style']);
const CONTAINER_CLASSES = new Set(['card', 'step', 'band', 'nopub', 'tile', 'panel', 'box']);
const BLOCK = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'dt', 'dd', 'caption']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '\u00b7', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', rarr: '\u2192', larr: '\u2190', times: '\u00d7', dagger: '\u2020',
  rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export interface ContainerAnalysis {
  cls: string;
  /** Non-heading words under `words()`. */
  words: number;
  /** Non-heading tokens under `bodyWords()`. */
  bodyTokens: number;
}

export interface SlideAnalysis {
  id: string;
  n: number | null;
  ariaLabel: string;
  words: number;
  anchors: number;
  tokens: string[];
  /** Heading-bearing containers only (these are what the hollow floor scores). */
  containers: ContainerAnalysis[];
  /** Containers with fewer than `hollowMin` body tokens. */
  hollow: number;
  exempt: string | null;
}

interface Frame {
  depth: number;
  hasHeading: boolean;
  words: number;
  bodyTokens: number;
  cls: string;
}

/**
 * Scan HTML the way deck-density.py's `SlideParser` does: only `<section class="slide">` content,
 * skipping script/style/svg/noscript/head, counting block-level anchors, a table as one anchor,
 * exact-token container classes, and unwinding the open-tag stack like a browser.
 * `hollowMin` mirrors the Python constant (6); the deck's own floor is `LIMITS.bodyMin`.
 */
export function analyzeDeckHtml(html: string, hollowMin = 6): SlideAnalysis[] {
  const slides: SlideAnalysis[] = [];

  let cur: (SlideAnalysis & { text: string[] }) | null = null;
  let stack: string[] = [];
  let skipDepth = 0;
  let blockDepth = 0;
  let tableDepth = 0;
  let blockHasText = false;
  let headingDepth = 0;
  let open: Frame[] = [];
  let closed: Frame[] = [];

  const finish = () => {
    if (!cur) return;
    for (const f of [...closed, ...open]) {
      if (!f.hasHeading) continue;
      cur.containers.push({ cls: f.cls, words: f.words, bodyTokens: f.bodyTokens });
      if (f.bodyTokens < hollowMin) cur.hollow += 1;
    }
    const flat = cur.text.join(' ').replace(/\s+/g, ' ').trim();
    cur.tokens = lower(words(flat));
    cur.words = cur.tokens.length;
    slides.push({
      id: cur.id,
      n: cur.n,
      ariaLabel: cur.ariaLabel,
      words: cur.words,
      anchors: cur.anchors,
      tokens: cur.tokens,
      containers: cur.containers,
      hollow: cur.hollow,
      exempt: cur.exempt,
    });
    cur = null;
    open = [];
    closed = [];
  };

  const closeDepth = (tag: string) => {
    if (VOID.has(tag) || skipDepth) return;
    if (cur && HEADING.has(tag) && headingDepth) headingDepth -= 1;
    const idx = stack.lastIndexOf(tag);
    if (idx === -1) return;
    stack.length = idx;
    while (open.length && open[open.length - 1].depth > stack.length) closed.push(open.pop() as Frame);
  };

  const onStart = (tag: string, attrs: string) => {
    if (SKIP.has(tag)) {
      skipDepth += 1;
      return;
    }
    const cls = (/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)?.slice(1).find((x) => x !== undefined) ?? '').trim();
    if (tag === 'section' && cls.split(/\s+/).includes('slide')) {
      const grab = (name: string) =>
        decodeEntities((new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs)?.slice(1).find((x) => x !== undefined)) ?? '');
      const rawId = grab('id');
      const id = rawId || `slide-${slides.length + 1}`;
      const num = /(\d+)/.exec(id);
      cur = {
        id,
        n: num ? parseInt(num[1], 10) : null,
        ariaLabel: grab('aria-label').slice(0, 60),
        words: 0,
        anchors: 0,
        tokens: [],
        containers: [],
        hollow: 0,
        exempt: /\bdata-density-exempt\s*=/i.test(attrs) ? grab('data-density-exempt') : null,
        text: [],
      };
      stack = [];
      headingDepth = 0;
      open = [];
      closed = [];
      return;
    }
    if (!VOID.has(tag) && skipDepth === 0) stack.push(tag);
    if (cur && skipDepth === 0) {
      if (HEADING.has(tag)) headingDepth += 1;
      if (!VOID.has(tag) && cls.split(/\s+/).some((c) => CONTAINER_CLASSES.has(c))) {
        open.push({ depth: stack.length, hasHeading: false, words: 0, bodyTokens: 0, cls });
      }
    }
    if (tag === 'table' && cur && skipDepth === 0) {
      tableDepth += 1;
      if (tableDepth === 1) cur.anchors += 1;
      return;
    }
    if (cur && skipDepth === 0 && tableDepth === 0 && BLOCK.has(tag)) {
      blockDepth += 1;
      blockHasText = false;
    }
  };

  const onEnd = (tag: string) => {
    if (SKIP.has(tag)) {
      if (skipDepth) skipDepth -= 1;
      return;
    }
    if (tag === 'table' && tableDepth) {
      tableDepth -= 1;
      closeDepth(tag);
      return;
    }
    if (cur && BLOCK.has(tag) && blockDepth && tableDepth === 0) {
      blockDepth -= 1;
      if (blockHasText) cur.anchors += 1;
      blockHasText = false;
    }
    if (tag === 'section' && cur) {
      finish();
      return;
    }
    closeDepth(tag);
  };

  const onText = (raw: string) => {
    if (!cur || skipDepth !== 0) return;
    const data = decodeEntities(raw);
    if (!data.trim()) return;
    cur.text.push(data);
    blockHasText = true;
    if (open.length) {
      const w = words(data).length;
      const t = bodyWords(data).length;
      for (const f of open) {
        if (headingDepth) f.hasHeading = true;
        else {
          f.words += w;
          f.bodyTokens += t;
        }
      }
    }
  };

  // Hand-rolled scanner: handles comments, doctype, quoted attributes containing ">", and raw-text
  // elements (script/style), which a global regex over a 200 KB inline bundle would mangle.
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      onText(html.slice(i));
      break;
    }
    if (lt > i) onText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(html.slice(lt, lt + 4096));
    if (!m) {
      onText('<');
      i = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosed = /\/\s*$/.test(attrs);
    i = lt + m[0].length;
    if (closing) onEnd(tag);
    else {
      onStart(tag, attrs);
      if (selfClosed && !VOID.has(tag)) onEnd(tag);
      else if (RAW_TEXT.has(tag) && !selfClosed) {
        const close = new RegExp(`</${tag}\\s*>`, 'i');
        const rest = html.slice(i);
        const cm = close.exec(rest);
        i += cm ? cm.index : rest.length;
      }
    }
  }
  return slides;
}

/** Analyze a single `<section class="slide">` fragment. */
export function analyzeSectionHtml(html: string, hollowMin = 6): SlideAnalysis {
  const [first] = analyzeDeckHtml(html, hollowMin);
  if (!first) throw new Error('no <section class="slide"> found');
  return first;
}

// --------------------------------------------------------------------------- static twin: script

/**
 * Port of deck-density `parse_script`: `{slide number -> spoken text}` from `### [SLIDE n]` sections.
 * Strips blockquotes (cues, sources, badges), headings, whole-line `[tags]`, and markdown marks.
 */
export function parseScriptMarkdown(md: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = md.split(/^#{1,6}\s*\[SLIDE (\d+)\][^\n]*$/gm);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1]
      .replace(/^>.*$/gm, '')
      .replace(/^\[.*?\]\s*$/gm, '')
      .replace(/^#{1,6} .*$/gm, '')
      .replace(/[*_`]/g, '');
    out.set(parseInt(parts[i], 10), body.replace(/\s+/g, ' ').trim());
  }
  return out;
}

// --------------------------------------------------------------------------- artifact check

/**
 * The shipped artifacts agree with the model: the rendered `<section>`s carry exactly the words,
 * anchors and containers the model declares (no widget or renderer injected prose), and the
 * generated markdown script passes the same overlap limits deck-density.py applies to it.
 */
export function checkArtifacts(deck: Deck, html: string, scriptMd: string): Finding[] {
  const out: Finding[] = [];
  const err = (slide: string, rule: RuleId, message: string) => out.push({ slide, rule, severity: 'error', message });
  const rendered = analyzeDeckHtml(html);
  const spoken = parseScriptMarkdown(scriptMd);

  if (rendered.length !== deck.slides.length) {
    err('deck', 'twin.missing', `rendered ${rendered.length} slide sections for ${deck.slides.length} slides`);
  }
  deck.slides.forEach((s, i) => {
    const r = rendered[i];
    if (!r) return;
    const expectWords = visibleWordCount(s) - svgLabelWordCount(s);
    if (r.words !== expectWords) {
      err(s.id, 'twin.words', `rendered section has ${r.words} words but the model declares ${expectWords} (SVG labels excluded)`);
    }
    if (r.anchors !== anchorCount(s)) {
      err(s.id, 'twin.anchors', `rendered section has ${r.anchors} anchors but the model declares ${anchorCount(s)}`);
    }
    const model = s.blocks.filter(isContainer) as Container[];
    if (r.containers.length !== model.length) {
      err(s.id, 'twin.containers', `rendered ${r.containers.length} heading-bearing containers for ${model.length} in the model`);
    } else {
      model.forEach((c, k) => {
        const rc = r.containers[k];
        if (rc.words !== words(c.body).length || rc.bodyTokens !== bodyWords(c.body).length) {
          err(s.id, 'twin.containers', `${c.kind} [${c.head}] renders ${rc.words}/${rc.bodyTokens} body words but the model has ${words(c.body).length}/${bodyWords(c.body).length}`);
        }
      });
    }
    const script = spoken.get(i + 1);
    if (script === undefined) {
      err(s.id, 'twin.missing', `no "### [SLIDE ${i + 1}]" section in the markdown script`);
    } else {
      const sp = lower(words(script));
      const l8 = verbatimOverlapPct(sp, r.tokens, 8);
      const l5 = verbatimOverlapPct(sp, r.tokens, 5);
      if (l8 > LIMITS.lift8MaxPct || l5 >= LIMITS.lift5MaxPct) {
        err(s.id, 'twin.overlap', `markdown script repeats the rendered slide (8-word lift ${l8.toFixed(1)}%, 5-word lift ${l5.toFixed(1)}%)`);
      }
    }
  });
  return out;
}
