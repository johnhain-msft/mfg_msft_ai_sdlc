import { describe, expect, it } from 'vitest';
import { deck } from '../src/content';
import { fixLabel, neutralizeHeadings, plain, slideAlt } from '../scripts/handout/compose.mjs';
import { GLOSSARY_CATEGORIES, NOTES } from '../scripts/handout/notes.mjs';
import { BANNED, checkDocumentText, checkNotes, digitNumbers, findBanned, presenterRules, spelledNumbers, termRules } from '../scripts/handout/verify.mjs';

/**
 * The customer handout (docs/Scaling-the-Agentic-SDLC.pdf) is authored from the presenter script,
 * so these tests pin the three promises its generator makes: every slide has notes, no presenter-only
 * content leaks, and no number is introduced that the slide, its script or the glossary does not carry.
 * The PDF itself is built and gated by `npm run build:handout`; nothing here needs a browser.
 */

describe('handout notes against the live deck', () => {
  it('cover every slide, leak nothing, and ground every number', () => {
    const { errors } = checkNotes({ deck, notes: NOTES, sourceLabel: fixLabel });
    expect(errors).toEqual([]);
  });

  it('have exactly one entry per slide and no stray ones', () => {
    expect(Object.keys(NOTES).sort()).toEqual(deck.slides.map((s) => s.id).sort());
  });

  it('put every glossary term into one of the six reader-facing categories', () => {
    expect(GLOSSARY_CATEGORIES.map((c) => c.title)).toEqual([
      'PROSE & Context',
      'Primitives & Supply Chain',
      'Operating Model & Governance',
      'Metrics & Quality Gates',
      'Process & Prompt Economics',
      'Security & Guardrails',
    ]);
    const orphans = deck.glossary.filter((e) => !GLOSSARY_CATEGORIES.some((c) => c.groups.includes(e.group)));
    expect(orphans.map((e) => e.id)).toEqual([]);
  });

  it('rewrite the one source label that names the presenter', () => {
    const slide = deck.slides.find((s) => s.id === 'm4-prompt-debugger');
    const raw = slide?.sources.find((s) => /Ch 7/.test(s.label))?.label ?? '';
    expect(raw).toMatch(/presenter/);
    expect(fixLabel(raw)).toBe('Handbook Ch 7: the agentic SDLC bill (with illustrative lever model)');
  });
});

describe('banned-phrase guard', () => {
  const leaks: Array<[string, string]> = [
    ['stage direction', 'POINT: Point at the glyph.'],
    ['UI mechanic', 'Press Space three times as you name the levers.'],
    ['UI mechanic', 'Hover or tab onto a layer to light it.'],
    ['room polling', 'Quick hands, or chat: who has seen this?'],
    ['room polling', "Call out a number. I'll wait."],
    ['room polling', "Don't be generous. This is for you, not for me."],
    ['room polling', "I'll tally."],
    ['story slot', 'STORY SLOT: one real, anonymized example.'],
    ['speaker tag', '[Alex] Good morning, everyone.'],
    ['room greeting', 'Welcome, everyone, and thanks for joining.'],
    ['hand-off', 'Alex takes the rest.'],
    ['hand-off', 'Over to you for what all of this costs.'],
    ['meta commentary', 'Your team asked us for real stories about early metrics.'],
    ['confidential anecdote', 'your sister company, ContosoInternalSync, pulled six people into a group'],
    ['confidential anecdote', 'a customer-sync detail that was never published'],
    ['pre-flight note', 'Pre-flight before delivery. Re-check both statuses.'],
    ['other session', "the bottleneck conversation on Friday's panel"],
    ['time-bound reference', 'We will pick this up next week.'],
    ['ledger code', 'supports claim C07'],
    ['editing note', 'Check Chapter 13 wording before the script is final.'],
    ['sourcing note', 'No source we hold prescribes a head count.'],
    ['sourcing note', 'We hold no benchmark.'],
    ['local path', 'C:\\Users\\user\\notes.md'],
  ];

  it.each(leaks)('catches %s: %s', (_kind, text) => {
    expect(findBanned(text).length).toBeGreaterThan(0);
  });

  const legitimate = [
    'The monolithic prompt is number one in the Handbook.',
    'The agent harness is layer 4 of the supply chain.',
    'Programmatic-internal gates run inside the agent process.',
    "In the Handbook's illustrative run one path cost $41.01 and the other $4.81.",
    'Handbook Chapter 16 argues that the placement of the seam matters most.',
    'Which gap feels sharpest for 2027?',
    "QA triage that eats a senior engineer's Monday.",
  ];
  it.each(legitimate)('leaves the subject matter alone: %s', (text) => {
    expect(findBanned(text)).toEqual([]);
  });
});

describe('presenter and confidential-term guards', () => {
  const presenter = deck.meta.presenters.John.name;
  const [first = ''] = presenter.split(/\s+/);
  const withPresenter = [...BANNED, ...presenterRules(deck)];

  it('read the presenter names from the deck, so no name is typed into the guard', () => {
    expect(findBanned(`${presenter} will share a story.`, withPresenter).map((h) => h.why)).toContain('presenter name in notes');
    expect(findBanned(`Thanks, ${first}.`, withPresenter).map((h) => h.why)).toContain('presenter name in notes');
    expect(findBanned(`Thanks, ${first}.`)).toEqual([]);
  });

  it('flag a confidential term only when it is supplied at run time', () => {
    const text = 'The ContosoInternalSync pilot cut review time.';
    expect(findBanned(text)).toEqual([]);
    expect(findBanned(text, [...BANNED, ...termRules(['ContosoInternalSync'])]).map((h) => h.why)).toEqual(['confidential term']);
    expect(termRules(['', '   '])).toEqual([]);
    expect(findBanned('The R+D Labs team', termRules(['R+D Labs']))).toHaveLength(1);
  });

  it('fail the notes check when a supplied term, or the presenter, appears in a note', () => {
    const entry = NOTES['m1-vibe-cliff']!;
    const withTerm = { ...NOTES, 'm1-vibe-cliff': { ...entry, body: [...(entry.body ?? []), 'A ContosoInternalSync pilot saw the same drop.'] } };
    expect(checkNotes({ deck, notes: withTerm, sourceLabel: fixLabel }).errors).toEqual([]);
    const flagged = checkNotes({ deck, notes: withTerm, sourceLabel: fixLabel, terms: ['ContosoInternalSync'] }).errors.join('\n');
    expect(flagged).toMatch(/m1-vibe-cliff: banned phrase "ContosoInternalSync" \(confidential term\)/);
    const named = { ...NOTES, 'm1-vibe-cliff': { ...entry, body: [...(entry.body ?? []), `${presenter} reviews every note.`] } };
    expect(checkNotes({ deck, notes: named, sourceLabel: fixLabel }).errors.join('\n')).toMatch(/\(presenter name in notes\)/);
  });

  it('ban the presenter outside the slides, where the cover byline is allowed, and a supplied term everywhere', () => {
    expect(checkDocumentText({ textOutsideSlides: `Written by ${presenter}.`, textInSlides: '', deck }).join('\n')).toMatch(/presenter name in notes/);
    expect(checkDocumentText({ textOutsideSlides: 'Clean text.', textInSlides: presenter, deck })).toEqual([]);
    const secret = checkDocumentText({ textOutsideSlides: 'Clean text.', textInSlides: 'ContosoInternalSync', deck, terms: ['ContosoInternalSync'] });
    expect(secret.join('\n')).toMatch(/slides: banned phrase "ContosoInternalSync" \(confidential term\)/);
  });
});

describe('number grounding', () => {
  const base = NOTES['m1-vibe-cliff'];
  const slide = deck.slides.find((s) => s.id === 'm1-vibe-cliff');

  it('rejects a figure that is not in the slide, its script or the glossary', () => {
    expect(base && slide).toBeTruthy();
    const mutated = { ...NOTES, 'm1-vibe-cliff': { ...base!, body: [...(base!.body ?? []), 'Rework runs about 97% on legacy code.'] } };
    const { errors } = checkNotes({ deck, notes: mutated, sourceLabel: fixLabel });
    expect(errors.join('\n')).toMatch(/m1-vibe-cliff: number\(s\) not found.*97/);
  });

  it('accepts the same figure once it is explicitly allowed', () => {
    const mutated = {
      ...NOTES,
      'm1-vibe-cliff': { ...base!, body: [...(base!.body ?? []), 'Rework runs about 97% on legacy code.'], allowNumbers: ['97'] },
    };
    expect(checkNotes({ deck, notes: mutated, sourceLabel: fixLabel }).errors).toEqual([]);
  });

  it('reports a slide with no notes, and notes for a slide that does not exist', () => {
    const { 'm1-cover': _dropped, ...rest } = NOTES;
    const lost = checkNotes({ deck, notes: rest, sourceLabel: fixLabel }).errors.join('\n');
    expect(lost).toMatch(/m1-cover has no companion notes/);
    const extra = checkNotes({ deck, notes: { ...NOTES, 'm9-ghost': NOTES['m1-cover']! }, sourceLabel: fixLabel }).errors.join('\n');
    expect(extra).toMatch(/"m9-ghost" is not a slide in the deck/);
  });

  it('reads spelled-out numbers the way the script writes them', () => {
    expect([...spelledNumbers('forty-one dollars and one cent')].sort()).toEqual(['1', '41']);
    expect(spelledNumbers('about two hundred forty-nine thousand dollars').has('249000')).toBe(true);
    expect([...spelledNumbers('the first sixty and ninety days')].sort()).toEqual(['60', '90']);
    expect([...spelledNumbers('number eight: two agents')].sort()).toEqual(['2', '8']);
    expect(spelledNumbers('a hundred').has('100')).toBe(true);
  });

  it('reads digits without commas, and does not treat slide cross-references as claims', () => {
    expect(digitNumbers('150,000 credits and 55.8% less time')).toEqual(['150000', '55.8']);
    expect(digitNumbers('Slides 11–15 return to it; see slide 13.')).toEqual([]);
  });
});

describe('markup helpers', () => {
  it('turn markup into plain text and escape everything else', () => {
    expect(plain('**Bold** and *italic* and `code`')).toBe('Bold and italic and code');
  });

  it('keep the slides out of the PDF outline without touching their selectors', () => {
    expect(neutralizeHeadings('<h1>Title</h1><h3 class="x">Card</h3><header>')).toBe(
      '<h1 role="presentation">Title</h1><h3 role="presentation" class="x">Card</h3><header>',
    );
  });

  it('describe each slide for a reader who cannot see it', () => {
    const slide = deck.slides[6]!;
    const alt = slideAlt(slide, 7);
    expect(alt).toMatch(/^Slide 7: Governance readiness scorecard\./);
    expect(alt).toMatch(/Audit trails/);
    expect(alt).not.toMatch(/\u25cb/);
  });
});
