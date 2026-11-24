/**
 * Canonical content model for the AI-DLC Immersion deck.
 *
 * One source of truth drives every surface:
 *   - the audience deck     (`dist/index.html#/<slide-id>`)      <- ON SCREEN fields
 *   - the speaker view      (`dist/index.html#/speaker/<id>`)    <- PRESENTER fields
 *   - the script book       (`dist/index.html#/script/<id>`)     <- PRESENTER fields
 *   - the markdown script   (`docs/SPEAKER-SCRIPT.md`)           <- PRESENTER fields
 *
 * ON SCREEN fields follow one element grammar, so a storyboard slide can be transcribed line
 * for line:
 *
 *   KICKER / TITLE / LEAD / NOTE / STAT   -> `kicker` / `title` / `lead` / `note` / `stat`
 *   CARD / STEP / PANEL / BOX / TILE / BAND [heading]: body   -> `Container` blocks
 *   ROW: cell // cell // cell             -> one `TableBlock` (first row is the header)
 *   CHIP: text                            -> `ChipBlock`
 *   LABEL: text                           -> `LabelBlock` (HTML) or an SVG `<text>` inside `diagram.svg`
 *
 * UNION-OF-STATES RULE: widgets may change emphasis, position, or numerals, but never add prose.
 * Every word a widget can ever show is already in the static markup, so the pre-rendered
 * `<section class="slide">` and every runtime state obey the same word budget.
 *
 * PRESENTER fields (`script`, `sources`, `purpose`, `roomSees`) are never rendered inside a
 * `<section class="slide">`.
 *
 * PACING: this model deliberately has no duration, minutes, or speaking-rate fields. Humans
 * manage pacing in the room.
 */

// --------------------------------------------------------------------------- people

/** Who presents a slide. The deck has a single presenter, so every slide is `John`. */
export type Presenter = 'John';

export const PRESENTER_NAMES: Readonly<Record<Presenter, string>> = {
  John: 'John Hain',
};

/** Display label for a slide's presenter. */
export function presenterLabel(p: Presenter): string {
  return PRESENTER_NAMES[p];
}

// --------------------------------------------------------------------------- structure

export const MODULE_CODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export interface Module {
  code: ModuleCode;
  /** Short module title, e.g. `Governance & the operating model`. */
  title: string;
  /** One line for the Overview / Module Map and the Script Book outline. */
  summary: string;
}

/** The 25 layout archetypes; no archetype repeats on consecutive slides. */
export const LAYOUT_ARCHETYPES = [
  'cover-hero-grid',
  'split-compare-gauge',
  'curve-diagram-staged',
  'stage-ladder',
  'layer-stack-diagram',
  'tabbed-roles',
  'scorecard-matrix',
  'stat-bars-traps',
  'stepper-3gen',
  'quad-decision-tree',
  'balance-compare',
  'roi-scorecard',
  'cost-bar-jcurve',
  'twin-bars',
  'token-model-sim',
  'paired-bar-chart',
  'pipeline-map',
  'evolution-rows',
  'defense-stack',
  'seam-diagram',
  'gotcha-table',
  'timeline-rail',
  'maturity-dimensions',
  'quiz-widget',
  'discussion-rail',
] as const;
export type LayoutArchetype = (typeof LAYOUT_ARCHETYPES)[number];

// --------------------------------------------------------------------------- ON SCREEN

/** Visual accent only. Never carries meaning that is not also in the words. */
export type Tone = 'azure' | 'violet' | 'green' | 'amber' | 'red' | 'neutral';

/** Decorative glyphs (aria-hidden SVG, zero words). See `ICONS` in `src/shell/render.ts`. */
export const ICON_NAMES = [
  'book',
  'compass',
  'shield',
  'person',
  'people',
  'layers',
  'gauge',
  'loop',
  'check',
  'spark',
  'clock',
  'scale',
  'funnel',
  'target',
  'lock',
  'branch',
  'flag',
  'search',
  'chat',
  'table',
  'key',
  'coin',
  'code',
  'doc',
  'eye',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Heading-bearing containers. Each needs 7-14 non-heading body words (hollow-container floor). */
export const CONTAINER_KINDS = ['card', 'step', 'panel', 'box', 'tile', 'band'] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * Text-free decorative art that lives inside a container (a gauge, a glyph strip, a pictogram).
 * Rendered as an `aria-hidden` SVG after the body. It must carry ZERO words: no `<text>`, `<title>`
 * or `<desc>` (rules.ts fails the build otherwise), so it can never smuggle prose past the budget.
 */
export interface ArtSpec {
  viewBox: string;
  /** Inner SVG markup, without the outer `<svg>` element. */
  svg: string;
}

/** An icon-only link inside a container (for example the reading rail on the open-floor slide). */
export interface LinkSpec {
  icon: IconName;
  href: string;
  /** Accessible name only; never rendered as text. */
  label: string;
}

/** CARD | STEP | PANEL | BOX | TILE | BAND `[head]: body` */
export interface Container {
  kind: ContainerKind;
  head: string;
  body: string;
  /** Text-free decorative SVG rendered inside the container, after the body. */
  art?: ArtSpec;
  /** Icon-only links, rendered as a rail inside the container. Targets are never printed on screen. */
  links?: LinkSpec[];
  /** Stable id for widgets (`data-key`). Defaults to the slug of `head`. */
  key?: string;
  /** Staged widget: the stage this container belongs to (`data-stage`). */
  stage?: string;
  /** Diagram highlight group (`data-hl`): hover or focus lights every element in the group. */
  hl?: string;
  tone?: Tone;
  icon?: IconName;
}

/** ROW lines: one table. The first row is the header row unless `header` is false. */
export interface TableBlock {
  kind: 'table';
  rows: string[][];
  header?: boolean;
  key?: string;
  /** Accessible description only (aria-label); never rendered as text. */
  label?: string;
}

/** CHIP: a short pill, usually a widget input. Zero anchors. */
export interface ChipBlock {
  kind: 'chip';
  text: string;
  key?: string;
}

/** LABEL: short HTML diagram text. Counted as visible words. Zero anchors. */
export interface LabelBlock {
  kind: 'label';
  text: string;
  key?: string;
}

export type Block = Container | TableBlock | ChipBlock | LabelBlock;

/**
 * Inline SVG diagram. `<text>` content is counted as LABEL words by `rules.ts` (stricter than
 * deck-density.py, which skips SVG). Every `<text>` must be at least 22px so on-screen glyphs
 * stay at least 18px at laptop sizes.
 */
export interface DiagramSpec {
  id: string;
  /** Accessible name. Ignored when `decorative` is true. */
  title: string;
  viewBox: string;
  /** Inner SVG markup, without the outer `<svg>` element. */
  svg: string;
  /** Icon-only art: rendered `aria-hidden`, no accessible name. */
  decorative?: boolean;
}

// --------------------------------------------------------------------------- widgets

export const TOKEN_LEVERS = ['scope', 'prefix', 'tools', 'routing'] as const;
export type TokenLever = (typeof TOKEN_LEVERS)[number];

/**
 * Parameters of the illustrative per-run cost model behind the slide 14 simulator.
 * Prices are RELATIVE (frontier input = 1.0). Two constants are calibrated at load time so the
 * all-levers-off run is exactly `targets.off` and the all-levers-on run is exactly `targets.on`:
 * the dollar value of the relative price unit, and the mid-tier price ratio.
 * Nothing here is vendor pricing.
 */
export interface TokenModelParams {
  targets: { off: number; on: number };
  /** Lever 1, Scope context: lines of context loaded per turn. */
  contextLines: { off: number; on: number };
  tokensPerLine: number;
  /** Standing system prompt tokens, always loaded. */
  systemTokens: number;
  /** Lever 2, Stable prefix: share of the repeated prefix served from cache. */
  cacheHit: { off: number; on: number };
  /** Cached input price as a fraction of full input price. */
  cachedPriceRatio: number;
  /** Lever 3, Tool subset: tool definitions loaded per turn. */
  tools: { off: number; on: number };
  tokensPerTool: number;
  /** Lever 4, Routed models + turn cap: frontier turns before; planner + mid-tier executors after. */
  turns: { off: number; plan: number; exec: number };
  /** Inherent task work, constant across all levers (read and edit the files). */
  work: { inputTokens: number; outputTokens: number };
  /** Output token price as a multiple of input token price. */
  outputPriceRatio: number;
}

export interface TokenModelSpec {
  /** `prompt-debugger` is the slide-14 flavour name from the plan; both mount the same widget. */
  kind: 'token-model' | 'prompt-debugger';
  params: TokenModelParams;
}

/**
 * Decision tree over a 2x2 gate matrix. Tiles are containers whose `key` is `<how>-<who>`
 * (e.g. `programmatic-internal`). Chips are `ChipBlock`s; `map[chipKey]` lists the tile keys
 * that chip rings. Chips answer to keys 1..N in chip order.
 */
export interface DecisionTreeSpec {
  kind: 'decision-tree';
  map: Record<string, string[]>;
}

export interface StageDef {
  /** Matches `stage` on containers and `data-stage` on diagram elements. */
  key: string;
  /** Accessible announcement only; never rendered. */
  announce?: string;
}

/**
 * Staged highlighter / stepper.
 *  - `steps`: Space / ArrowRight / PageDown advance the highlight stage by stage before the deck
 *    moves on; clicking a stage target jumps to it. Step 0 is neutral (nothing emphasised).
 *  - `place`: clicking a table cell places a row in a tier (None / Basic / Enterprise).
 * Neither mode hides or injects text.
 */
export type StagedSpec =
  | { kind: 'staged'; mode: 'steps'; stages: StageDef[] }
  | { kind: 'staged'; mode: 'place'; rows: string[]; tiers: string[] };

export interface QuizQuestion {
  /** Matches the container `key` of the question card. */
  key: string;
  /** Index (0 = A) of the correct option. */
  answer: number;
  /** Number of option chips (A, B, C ...). Letters are CSS-generated, never DOM text. */
  options: number;
}

/** Room check: keys 1..N pick an option for the active question; Enter reveals it. */
export interface QuizSpec {
  kind: 'quiz';
  questions: QuizQuestion[];
}

export type WidgetSpec = TokenModelSpec | DecisionTreeSpec | StagedSpec | QuizSpec;
export type WidgetKind = WidgetSpec['kind'];

// --------------------------------------------------------------------------- presenter fields

/**
 * Stage directions. `ask` / `poll` / `next` are SPOKEN to the room (the text is what you say);
 * every other kind is a direction that is never read aloud. All cues render as blockquotes in
 * the markdown script, so deck-density.py strips them from the spoken-word overlap check.
 */
export type CueKind =
  | 'show'
  | 'point'
  | 'click'
  | 'ask'
  | 'poll'
  | 'wait'
  | 'switch'
  | 'story'
  | 'note'
  | 'next';

export const SPOKEN_CUE_KINDS: ReadonlySet<CueKind> = new Set<CueKind>(['ask', 'poll', 'next']);

export interface SayBeat {
  t: 'say';
  /** Literal first-person spoken text. */
  text: string;
  /** Collapsed under an "If needed" drawer in the speaker view. */
  optional?: boolean;
  /** Drawer title shared by consecutive optional beats. */
  group?: string;
}

export interface CueBeat {
  t: 'cue';
  kind: CueKind;
  text: string;
  /** Copyable monospace payload (a prompt, a command, an assumptions table). */
  code?: string;
  optional?: boolean;
  group?: string;
}

export type Beat = SayBeat | CueBeat;

export interface Source {
  label: string;
  url: string;
  /** Claim id this source supports, e.g. `C07`. */
  claim?: string;
}

// --------------------------------------------------------------------------- slide, deck

export interface Slide {
  /** `m1-cover` ... `m7-open-floor`. Unique. Used in URLs (`#/<id>`) and `data-id`. */
  id: string;
  moduleCode: ModuleCode;
  presenter: Presenter;
  layout: LayoutArchetype;
  /** The ONE thing the slide accomplishes. Presenter-only. */
  purpose: string;

  // ---- ON SCREEN (every visible word counts toward the budget) ----
  kicker?: string;
  title: string;
  lead?: string;
  /** Live numeric readout, counted once at its widest state. */
  stat?: string;
  note?: string;
  /** Containers, table, chips and HTML labels, in reading order. */
  blocks: Block[];
  diagram?: DiagramSpec;
  widget?: WidgetSpec;
  /** `data-density-exempt` reason. Exempts the slide from the word budget AND the hollow floor. */
  exempt?: string;

  // ---- PRESENTER (never rendered inside the slide) ----
  /** Replaces the auto-generated "The room sees" sentence when present. */
  roomSees?: string;
  script: Beat[];
  sources: Source[];
}

export interface DeckMeta {
  title: string;
  subtitle: string;
  event: string;
  /** Human-readable session description, shown in the script header. No durations or pacing. */
  session: string;
  presenters: Record<Presenter, { name: string; org: string }>;
}

export interface Deck {
  meta: DeckMeta;
  modules: Module[];
  slides: Slide[];
  glossary: GlossaryEntry[];
}

// --------------------------------------------------------------------------- glossary

export const GLOSSARY_GROUPS = [
  'prose',
  'primitives',
  'operating-model',
  'governance',
  'metrics',
  'quality',
  'economics',
  'security',
] as const;
export type GlossaryGroup = (typeof GLOSSARY_GROUPS)[number];

export interface GlossaryEntry {
  /** Unique, kebab-case. */
  id: string;
  term: string;
  group: GlossaryGroup;
  /** Plain-language definition: one or two sentences. */
  definition: string;
  /** Extra search words (aliases, file names). */
  aliases?: string[];
  /** Slide ids where the term appears. */
  slides?: string[];
  source?: Source;
  /** Wording is a plain-language paraphrase; re-check against the source before the script is final. */
  paraphrase?: boolean;
}

// --------------------------------------------------------------------------- helpers

/** Lowercase kebab slug used for default widget keys. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isContainer(b: Block): b is Container {
  return (CONTAINER_KINDS as readonly string[]).includes(b.kind);
}
export function isTable(b: Block): b is TableBlock {
  return b.kind === 'table';
}
export function isChip(b: Block): b is ChipBlock {
  return b.kind === 'chip';
}
export function isLabel(b: Block): b is LabelBlock {
  return b.kind === 'label';
}

/** Stable key of a keyed block: explicit `key`, else the slug of its heading or text. */
export function blockKey(b: Block): string {
  if (b.key) return b.key;
  if (isContainer(b)) return slug(b.head);
  if (isChip(b) || isLabel(b)) return slug(b.text);
  return 'table';
}
