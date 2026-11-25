import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Beat, Container, Deck, Slide } from '../src/content/types';
import {
  LIMITS,
  analyzeDeckHtml,
  analyzeSectionHtml,
  anchorCount,
  bodyWords,
  checkArtifacts,
  checkDeck,
  checkSlide,
  diagramLabels,
  parseScriptMarkdown,
  screenTokens,
  seenSaid,
  spokenText,
  verbatimOverlapPct,
  visibleWordCount,
  words,
} from '../src/content/rules';

// ----------------------------------------------------------------------------- fixtures
// Expected tokenizer values were produced by the real deck-density.py (words / body_words),
// not by hand, so these tests pin this port to the contract the deck-density gate uses.

const base = (over: Partial<Slide> = {}): Slide => ({
  id: 'm4-prompt-debugger',
  moduleCode: 'M4',
  presenter: 'John',
  layout: 'token-model-sim',
  purpose: 'Let the room see which four levers drive the gap in prompt cost.',
  kicker: 'Live exercise',
  title: 'Debug one prompt',
  blocks: [
    { kind: 'tile', head: 'Scope context', body: '3,800 flat lines become 450 scoped lines.' },
    { kind: 'tile', head: 'Stable prefix', body: 'Cache hits rise from 0% to 80%+.' },
    { kind: 'tile', head: 'Tool subset', body: '65 tools every turn become six scoped tools.' },
    {
      kind: 'tile',
      head: 'Routed models',
      body: 'Fifteen frontier retries become plan, execute, and a two-round cap.',
    },
  ],
  stat: '$41.01 \u2192 $4.81 per run',
  note: 'Illustrative model, not vendor pricing',
  script: [{ t: 'say', text: 'Here is a model I tuned by hand, so treat it as a teaching device.' }],
  sources: [],
  ...over,
});

const tile = (body: string): Container => ({ kind: 'tile', head: 'Head', body });
const rules = (f: ReturnType<typeof checkSlide>) => f.map((x) => x.rule);

// ----------------------------------------------------------------------------- tokenizers

describe('tokenizers match deck-density.py exactly', () => {
  const W: Record<string, string[]> = {
    '$41.01 \u2192 $4.81 per run': ['41.01', '4.81', 'per', 'run'],
    'Unwritten conventions overflow any 200K\u20132M token window; rework estimated at ~30\u201360%\u2020': [
      'Unwritten', 'conventions', 'overflow', 'any', '200K', '2M', 'token', 'window',
      'rework', 'estimated', 'at', '30', '60',
    ],
    'Fifteen frontier retries become plan, execute, and a two-round cap.': [
      'Fifteen', 'frontier', 'retries', 'become', 'plan', 'execute', 'and', 'a', 'two-round', 'cap.',
    ],
    "Jane Doe \u00b7 Sam O'Brien": ['Jane', 'Doe', 'Sam', "O'Brien"],
    'Sam O\u2019Brien said 6\u201312 months': ['Sam', 'O\u2019Brien', 'said', '6', '12', 'months'],
    'Q&A on 10M-line brownfield; Cache hits rise from 0% to 80%+.': [
      'Q', 'A', 'on', '10M-line', 'brownfield', 'Cache', 'hits', 'rise', 'from', '0', 'to', '80',
    ],
    'snake_case_word and kebab-case-word': ['snake', 'case', 'word', 'and', 'kebab-case-word'],
    'Scores 1.0, and records pass.': ['Scores', '1.0', 'and', 'records', 'pass.'],
    '\u25cb \u25cb \u25cb': [],
  };
  for (const [text, expected] of Object.entries(W)) {
    it(`words(${JSON.stringify(text.slice(0, 40))})`, () => expect(words(text)).toEqual(expected));
  }

  it('bodyWords() treats "." as a separator and "_" as a word character', () => {
    expect(bodyWords('Scores 1.0, and records pass.')).toEqual(['Scores', '1', '0', 'and', 'records', 'pass']);
    expect(bodyWords('snake_case_word and kebab-case-word')).toEqual(['snake_case_word', 'and', 'kebab-case-word']);
    expect(bodyWords('$41.01 \u2192 $4.81 per run')).toEqual(['41', '01', '4', '81', 'per', 'run']);
  });

  it('exposes the documented limits and no pacing limits', () => {
    expect(LIMITS).toMatchObject({
      wordsTarget: 58,
      wordsCeiling: 90,
      anchorsMax: 14,
      bodyMin: 7,
      bodyMax: 14,
      lift5MaxPct: 10,
      lift8MaxPct: 0,
    });
    expect(Object.keys(LIMITS).join(' ')).not.toMatch(/wpm|minute|pace|countdown/i);
  });
});

// ----------------------------------------------------------------------------- visible words

describe('audience word budget', () => {
  it('counts every ON SCREEN element: slide 14 copy is 55 words under the real tokenizer', () => {
    expect(visibleWordCount(base())).toBe(55);
  });

  it('counts table cells, chips, HTML labels, lead, note and stat (slide 7 copy = 45 words)', () => {
    const s7 = base({
      id: 'm2-governance-matrix',
      kicker: 'Operating model',
      title: 'Governance readiness scorecard',
      lead: 'Where does your organization sit today? Name the sharpest gap.',
      stat: undefined,
      note: undefined,
      blocks: [
        {
          kind: 'table',
          rows: [
            ['Capability', 'None', 'Basic', 'Enterprise'],
            ['Audit trails', '\u25cb', '\u25cb', '\u25cb'],
            ['Agent access controls', '\u25cb', '\u25cb', '\u25cb'],
            ['Approval workflows', '\u25cb', '\u25cb', '\u25cb'],
            ['Data boundaries', '\u25cb', '\u25cb', '\u25cb'],
            ['Cost controls', '\u25cb', '\u25cb', '\u25cb'],
            ['Compliance reporting', '\u25cb', '\u25cb', '\u25cb'],
          ],
        },
        {
          kind: 'band',
          head: 'Start here',
          body: 'Audit trails and agent access controls unblock the other four capabilities.',
        },
      ],
    });
    expect(visibleWordCount(s7)).toBe(45);
  });

  it('counts SVG <text> as LABEL words (stricter than deck-density, which skips svg)', () => {
    const svg = '<g><text x="0" y="30" font-size="24">Head</text><text>Middle trough</text><title>Ignored</title></g>';
    expect(diagramLabels(svg)).toEqual(['Head', 'Middle trough']);
    const s = base({ diagram: { id: 'd', title: 'Curve', viewBox: '0 0 10 10', svg } });
    expect(visibleWordCount(s)).toBe(55 + 3);
  });

  it('warns above the 58-word target and errors above the 90-word ceiling', () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const warn = checkSlide(base({ lead: filler(4) }));
    expect(warn.find((f) => f.rule === 'words.target')?.severity).toBe('warning');
    expect(rules(warn)).not.toContain('words.ceiling');
    const err = checkSlide(base({ lead: filler(40) }));
    expect(err.find((f) => f.rule === 'words.ceiling')?.severity).toBe('error');
    expect(rules(err)).not.toContain('words.target');
  });

  it('a slide at exactly 58 words is clean; 59 warns', () => {
    const at = base({ lead: 'one two three' });
    expect(visibleWordCount(at)).toBe(58);
    expect(rules(checkSlide(at))).not.toContain('words.target');
    const over = base({ lead: 'one two three four' });
    expect(rules(checkSlide(over))).toContain('words.target');
  });
});

// ----------------------------------------------------------------------------- hollow floor

describe('hollow-container floor (7-14 body words under BOTH tokenizers)', () => {
  const body = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('passes 7 and 14 body words', () => {
    const f = checkSlide(base({ blocks: [tile(body(7)), tile(body(14))], stat: undefined, note: undefined }));
    expect(rules(f)).not.toContain('container.hollow');
    expect(rules(f)).not.toContain('container.overfull');
  });

  it('flags 6 words as hollow and 15 as overfull', () => {
    expect(rules(checkSlide(base({ blocks: [tile(body(6))] })))).toContain('container.hollow');
    expect(rules(checkSlide(base({ blocks: [tile(body(15))] })))).toContain('container.overfull');
  });

  it('a decimal decides: 6 under words() but 7 under bodyWords() is still hollow', () => {
    const text = 'Score 1.0 and records pass here.';
    expect(words(text)).toHaveLength(6);
    expect(bodyWords(text)).toHaveLength(7);
    expect(rules(checkSlide(base({ blocks: [tile(text)] })))).toContain('container.hollow');
  });

  it('never counts the heading toward the body', () => {
    const f = checkSlide(base({ blocks: [{ kind: 'band', head: 'A very long heading with many many words in it', body: 'Too short.' }] }));
    expect(rules(f)).toContain('container.hollow');
  });

  it('data-density-exempt slides skip the word budget and the hollow floor', () => {
    const exempt = base({ exempt: 'reference matrix', lead: 'x '.repeat(100), blocks: [tile('tiny')] });
    const r = rules(checkSlide(exempt));
    expect(r).not.toContain('words.ceiling');
    expect(r).not.toContain('container.hollow');
  });
});

// ----------------------------------------------------------------------------- anchors

describe('competing anchors (<= 14)', () => {
  it('counts p/h with text: kicker, title, lead, note, stat, 2 per container, 1 per table; chips and labels are zero', () => {
    const s = base({
      lead: 'A lead.',
      blocks: [
        tile('one two three four five six seven'),
        { kind: 'chip', text: 'Goal drift' },
        { kind: 'label', text: 'Head' },
        { kind: 'table', rows: [['a', 'b']] },
      ],
    });
    // kicker + title + lead + note + stat = 5; tile = 2; table = 1
    expect(anchorCount(s)).toBe(8);
  });

  it('errors above 14 anchors', () => {
    const many = Array.from({ length: 8 }, () => tile('one two three four five six seven'));
    const f = checkSlide(base({ blocks: many }));
    expect(f.find((x) => x.rule === 'anchors.max')?.severity).toBe('error');
  });
});

// ----------------------------------------------------------------------------- seen / said

describe('seen/said separation', () => {
  const screen = base({
    kicker: undefined,
    stat: undefined,
    note: undefined,
    title: 'Greenfield demos hit a cliff',
    blocks: [
      {
        kind: 'card',
        head: '10M-line brownfield',
        body: 'Unwritten conventions overflow any 200K\u20132M token window; rework estimated at ~30\u201360%\u2020',
      },
    ],
  });

  it('verbatimOverlapPct reproduces deck-density: 13 of 22 words = 59.09% in 8-word runs', () => {
    const slide = screenTokens({
      ...screen,
      blocks: [
        ...screen.blocks,
        { kind: 'band', head: 'Three structural properties', body: 'Context is finite and fragile; context must be explicit; output is probabilistic.' },
      ],
    });
    const lifted =
      'Take the claim that unwritten conventions overflow any 200K 2M token window; rework estimated at 30 60 and then argue with it.';
    const fresh =
      'Nothing here overlaps with that copy at all, so the lift stays at zero percent for this paragraph of spoken narration text.';
    expect(words(lifted)).toHaveLength(22);
    expect(verbatimOverlapPct(words(lifted).map((w) => w.toLowerCase()), slide, 8)).toBeCloseTo(59.0909, 3);
    expect(verbatimOverlapPct(words(fresh).map((w) => w.toLowerCase()), slide, 8)).toBe(0);
  });

  it('returns 0 when either side is shorter than the run length (deck-density behaviour)', () => {
    expect(verbatimOverlapPct(['a', 'b', 'c'], ['a', 'b', 'c'], 5)).toBe(0);
  });

  it('flags a lifted 8-word run as an error', () => {
    const lifted: Beat = {
      t: 'say',
      text: 'The slide says unwritten conventions overflow any 200K 2M token window and I will repeat it.',
    };
    const f = checkSlide({ ...screen, script: [lifted] });
    expect(f.find((x) => x.rule === 'seen-said.verbatim')?.severity).toBe('error');
  });

  it('clean narration passes; 5-word shingle overlap under 10% is tolerated, 10% or more fails', () => {
    const clean: Beat = {
      t: 'say',
      text: 'Picture a rule your best architect never wrote down. The agent will happily break it and everything still compiles, which is the danger.',
    };
    const r = seenSaid({ ...screen, script: [clean] });
    expect(r.lift8).toBe(0);
    expect(r.set5).toBe(0);
    expect(rules(checkSlide({ ...screen, script: [clean] }))).not.toContain('seen-said.shingle');

    // exactly one 5-word run shared out of a long paragraph (5 of 74 words, about 6.8%): under both limits
    const long =
      'Here is a long unrelated paragraph that keeps going for quite a while so the shared run stays small: any 200K 2M token window sometimes comes up when we talk about context, ' +
      'but mostly we discuss other topics across many many words to dilute it properly, because a presenter who narrates for a while rarely repeats the slide, and that is exactly the point ' +
      'of keeping the screen sparse while the person at the front of the room carries the argument with stories and numbers the audience cannot read anywhere else, okay.';
    const r2 = seenSaid({ ...screen, script: [{ t: 'say', text: long }] });
    expect(r2.set5).toBeGreaterThan(0);
    expect(r2.set5).toBeLessThan(LIMITS.lift5MaxPct);
    expect(r2.lift5).toBeGreaterThan(0);
    expect(r2.lift5).toBeLessThan(LIMITS.lift5MaxPct);
    expect(rules(checkSlide({ ...screen, script: [{ t: 'say', text: long }] }))).not.toContain('seen-said.shingle');

    const heavy: Beat = { t: 'say', text: 'any 200K 2M token window' };
    expect(rules(checkSlide({ ...screen, script: [heavy] }))).toContain('seen-said.shingle');
  });

  it('measures say beats only by default; cues are stripped from the script, as deck-density does', () => {
    const s = {
      ...screen,
      script: [
        { t: 'say', text: 'Plain spoken line number one.' },
        { t: 'cue', kind: 'ask', text: 'Unwritten conventions overflow any 200K 2M token window, hands up?' },
      ] as Beat[],
    };
    expect(spokenText(s)).toBe('Plain spoken line number one.');
    expect(spokenText(s, { includeCues: true })).toContain('hands up?');
    expect(seenSaid(s).lift8).toBe(0);
    expect(seenSaid(s, { includeCues: true }).lift5).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------- static twin

describe('static twin of deck-density.py (analyze rendered HTML)', () => {
  // Fixture HTML and the expected numbers come from running the real SlideParser on it.
  const html = `<!doctype html><html><head><title>Ignored head words here</title></head><body>
<header class="chrome"><span>Brand chrome words outside slide</span></header>
<div id="stage">
<section class="slide active" id="s1" data-id="demo-one">
<p class="kicker">Operating model</p>
<h1>Five layers, five owners</h1>
<p class="lead">Where does Contoso sit today?</p>
<div class="card"><h3>Greenfield demo</h3><p>No legacy to respect, so the task fits in context.</p></div>
<div class="tile tone-azure"><h3>Hollow</h3><p>Too short</p></div>
<div class="band-header"><h3>Not a band</h3><p>band-header is not a container token</p></div>
<div class="band"><h3>Start here</h3><p>Audit trails and agent access controls unblock the other four capabilities.</p></div>
<table class="grid"><thead><tr><th>Capability</th><th>None</th></tr></thead><tbody><tr><td>Audit trails</td><td>\u25cb</td></tr></tbody></table>
<button class="chip">Goal drift</button>
<span class="label">HTML label here</span>
<svg viewBox="0 0 10 10"><text>Svg text skipped</text></svg>
<script>var skipped = "script words";</script>
<p class="note">Scores 1.0, and records pass.</p>
</section>
<section class="slide" id="s2" data-id="demo-two" data-density-exempt="reference matrix">
<h1>Second slide</h1>
</section>
</div>
<footer>Footer chrome words</footer>
</body></html>`;

  it('reproduces words, anchors, containers and hollow counts of the real parser', () => {
    const [s1, s2] = analyzeDeckHtml(html);
    expect(s1).toMatchObject({ id: 's1', words: 62, anchors: 13, exempt: null });
    expect(s1.containers).toHaveLength(3);
    expect(s1.hollow).toBe(1);
    expect(s2).toMatchObject({ id: 's2', words: 2, anchors: 1, exempt: 'reference matrix' });
  });

  it('never counts chrome, <head>, <script>, <style> or <svg> text', () => {
    const a = analyzeSectionHtml('<section class="slide"><h1>Hi there</h1><svg><text>Not counted</text></svg><style>.a{}</style></section>');
    expect(a.words).toBe(2);
  });

  it('a nested, unclosed <li> does not swallow later containers (unwinds like a browser)', () => {
    const a = analyzeSectionHtml(
      '<section class="slide"><div class="card"><h3>One</h3><ul><li>a b c d e f g</div><div class="card"><h3>Two</h3><p>a b c d e f g h</p></div></section>',
    );
    expect(a.containers.map((c) => c.words)).toEqual([7, 8]);
  });
});

// ----------------------------------------------------------------------------- script parser twin

describe('parseScriptMarkdown mirrors deck-density parse_script', () => {
  const md = [
    '# Title',
    '',
    'Preamble that belongs to no slide.',
    '',
    '### [SLIDE 1] \u00b7 m1-cover \u00b7 Cover',
    '',
    '> **Presenter:** Test Presenter',
    '',
    '[Speaker]',
    'Spoken *line* with _marks_ and `code`.',
    '',
    '> **[CUE]** Point at the glyph.',
    '',
    '## Module M2',
    '',
    '### [SLIDE 2] \u00b7 m1-vibe-cliff \u00b7 Cliff',
    'Second slide words.',
  ].join('\n');

  it('keeps plain paragraphs only: strips blockquotes, headings, [tag] lines and markdown marks', () => {
    const m = parseScriptMarkdown(md);
    expect(m.get(1)).toBe('Spoken line with marks and code.');
    expect(m.get(2)).toBe('Second slide words.');
    expect(m.has(0)).toBe(false);
  });
});

// ----------------------------------------------------------------------------- structure + artifacts

const deckOf = (slides: Slide[]): Deck => ({
  meta: {
    title: 't', subtitle: 's', event: 'e', session: 'x',
    presenters: { John: { name: 'Test Presenter', org: 'Microsoft' } },
  },
  modules: [
    { code: 'M1', title: 'One', summary: '' }, { code: 'M4', title: 'Four', summary: '' },
  ],
  slides,
  glossary: [],
});

describe('structure checks', () => {
  it('rejects duplicate slide ids and unknown modules', () => {
    const a = base({ id: 'dup' });
    const b = base({ id: 'dup', moduleCode: 'M7' });
    const r = rules(checkDeck(deckOf([a, b])).findings);
    expect(r).toContain('structure.duplicate-id');
    expect(r).toContain('structure.module');
  });

  it('requires every slide to name a presenter that the deck defines', () => {
    expect(rules(checkDeck(deckOf([base()])).findings)).not.toContain('structure.voices');
    const stranger = base({ presenter: 'Nobody' as Slide['presenter'] });
    expect(rules(checkDeck(deckOf([stranger])).findings)).toContain('structure.voices');
    const undefinedPresenter = deckOf([base()]);
    undefinedPresenter.meta.presenters = {} as Deck['meta']['presenters'];
    expect(rules(checkDeck(undefinedPresenter).findings)).toContain('structure.voices');
  });

  it('requires at least one spoken beat', () => {
    const empty = base({ script: [{ t: 'cue', kind: 'next', text: 'On we go.' }] });
    expect(rules(checkDeck(deckOf([empty])).findings)).toContain('structure.script');
  });

  it('rejects a say line the markdown parser would silently drop', () => {
    for (const text of ['# Heading-looking line', '> quoted line', '[Tag]', 'a fine first line\n> but the second is quoted']) {
      const found = rules(checkDeck(deckOf([base({ script: [{ t: 'say', text }] })])).findings);
      expect(found, JSON.stringify(text)).toContain('structure.script');
    }
    const ok = base({ script: [{ t: 'say', text: 'Chapter 5 [tag] is fine mid-line, and so is a # sign in the middle.' }] });
    expect(rules(checkDeck(deckOf([ok])).findings)).not.toContain('structure.script');
  });

  it('rejects an SVG label under 22px', () => {
    const s = base({ diagram: { id: 'd', title: 'x', viewBox: '0 0 1 1', svg: '<text font-size="16">Small</text>' } });
    expect(rules(checkSlide(s))).toContain('diagram.font');
  });

  it('rejects an SVG label with no explicit font-size of its own', () => {
    const s = base({ diagram: { id: 'd', title: 'x', viewBox: '0 0 1 1', svg: '<text x="1" y="2">Inherits a size</text>' } });
    const f = checkSlide(s).filter((x) => x.rule === 'diagram.font');
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toMatch(/no explicit font-size/);
    const ok = base({ diagram: { id: 'd', title: 'x', viewBox: '0 0 1 1', svg: '<text x="1" y="2" font-size="26">Sized</text>' } });
    expect(rules(checkSlide(ok))).not.toContain('diagram.font');
  });

  it('container art must be word-free: <text>, <tspan>, <title>, <desc> and <foreignObject> are rejected', () => {
    const withArt = (svg: string) =>
      base({ blocks: [{ kind: 'card', head: 'Head', body: 'Seven body words sit under this heading here.', art: { viewBox: '0 0 10 10', svg } }] });
    for (const svg of ['<text font-size="26">Hi</text>', '<tspan>Hi</tspan>', '<title>Hi</title>', '<desc>Hi</desc>', '<foreignObject></foreignObject>']) {
      expect(rules(checkSlide(withArt(svg))), svg).toContain('art.text');
    }
    expect(rules(checkSlide(withArt('<circle cx="1" cy="1" r="1"/>')))).not.toContain('art.text');
  });

  it('a clean slide has no findings', () => {
    expect(checkDeck(deckOf([base()])).findings).toEqual([]);
  });
});

describe('artifact twin check', () => {
  it('flags rendered markup that carries more visible words than the model declares', () => {
    const s = base();
    const html = `<section class="slide" id="s1" data-id="${s.id}"><h1>Debug one prompt</h1><p>${'extra '.repeat(70)}</p></section>`;
    const f = checkArtifacts(deckOf([s]), html, '### [SLIDE 1] \u00b7 x \u00b7 y\nWords here.');
    expect(rules(f)).toContain('twin.words');
  });
});

// ----------------------------------------------------------------------------- John's rule

describe('John\u2019s rule: no pacing math, no countdown alarms anywhere in src/', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|css|mjs)$/.test(n) ? [p] : [];
    });
  const files = [...walk('src'), 'scripts/build.mjs'].filter((f) => existsSync(f));
  const banned = /\b(wpm|wordsPerMinute|words_per_minute|SPOKEN_WPM|countdown|overtime|behindSchedule|paceAlert|speakingRate)\b/i;
  it('contains no pacing identifiers', () => {
    const hits = files.filter((f) => banned.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(hits).toEqual([]);
  });
});
