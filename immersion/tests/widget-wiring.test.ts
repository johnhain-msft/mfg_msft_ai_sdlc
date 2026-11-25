import { describe, expect, it } from 'vitest';
import { deck } from '../src/content';
import { checkDeck } from '../src/content/rules';
import { isTable, type Slide } from '../src/content/types';
import { renderSlideSection } from '../src/shell/render';
import { validateWidget } from '../src/widgets/validate';

// Fixtures are copies of the real authored content, not an invented widget schema.
const copySlide = (id: string): Slide => {
  const slide = deck.slides.find((s) => s.id === id);
  if (!slide) throw new Error(`Missing fixture slide: ${id}`);
  return structuredClone(slide);
};

const expectStructuralFailure = (slide: Slide, message: RegExp): void => {
  expect(validateWidget(slide)).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  expect(checkDeck({ ...deck, slides: [slide] }).findings).toEqual(
    expect.arrayContaining([expect.objectContaining({ slide: slide.id, rule: 'structure.widget', severity: 'error' })]),
  );
};

describe('Authored widget wiring', () => {
  it('rejects a stage that no container or diagram can activate', () => {
    const steppers = deck.slides.filter((s) => s.widget?.kind === 'staged' && s.widget.mode === 'steps');
    expect(steppers).toHaveLength(5);
    for (const slide of steppers) expect(validateWidget(slide), slide.id).toEqual([]);
    const broken = copySlide('m2-hero-trap');
    if (broken.widget?.kind !== 'staged' || broken.widget.mode !== 'steps') throw new Error('Expected steps');
    broken.widget.stages[1]!.key = 'unreachable-stage';
    expectStructuralFailure(broken, /stage "unreachable-stage" is not used/);
  });

  it('rejects a scorecard whose row or tier inventory no longer matches its table', () => {
    const broken = copySlide('m2-governance-matrix');
    expect(validateWidget(broken)).toEqual([]);
    const table = broken.blocks.find(isTable);
    if (!table || broken.widget?.kind !== 'staged' || broken.widget.mode !== 'place') throw new Error('Expected scorecard');
    table.rows.pop();
    broken.widget.tiers.pop();
    expectStructuralFailure(broken, /rows must be the slugs/);
    expect(validateWidget(broken)).toEqual(expect.arrayContaining([expect.stringMatching(/tiers .* must match/)]));
  });

  it('rejects gate chips with missing routes and routes to a removed gate', () => {
    const broken = copySlide('m3-gate-matrix');
    expect(validateWidget(broken)).toEqual([]);
    if (broken.widget?.kind !== 'decision-tree') throw new Error('Expected decision tree');
    delete broken.widget.map['schema-break'];
    broken.blocks = broken.blocks.filter((b) => b.key !== 'programmatic-external');
    expectStructuralFailure(broken, /chip "schema-break" has no entry/);
    expect(validateWidget(broken)).toEqual(expect.arrayContaining([expect.stringMatching(/no container has that key/)]));
  });

  it('rejects a quiz answer outside its options and a question with no card', () => {
    const broken = copySlide('m7-quiz');
    expect(validateWidget(broken)).toEqual([]);
    if (broken.widget?.kind !== 'quiz') throw new Error('Expected quiz');
    broken.widget.questions[0]!.answer = broken.widget.questions[0]!.options;
    broken.widget.questions[1]!.key = 'missing-card';
    expectStructuralFailure(broken, /answer 3 is out of range/);
    expect(validateWidget(broken)).toEqual(expect.arrayContaining([expect.stringMatching(/matches no container key/)]));
  });

  it('renders both prompt-model aliases identically and rejects a stale static cost readout', () => {
    const slide = copySlide('m4-prompt-debugger');
    expect(validateWidget(slide)).toEqual([]);
    if (slide.widget?.kind !== 'prompt-debugger') throw new Error('Expected prompt debugger');
    const alias = structuredClone(slide);
    if (!alias.widget) throw new Error('Expected widget');
    alias.widget.kind = 'token-model';
    expect(validateWidget(alias)).toEqual([]);
    expect(renderSlideSection(alias, 14)).toBe(renderSlideSection(slide, 14));
    slide.stat = '$0.00 per run';
    expectStructuralFailure(slide, /stat must equal the model's static readout/);
  });
});
