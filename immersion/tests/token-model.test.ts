import { describe, expect, it } from 'vitest';
import { deck, promptModel } from '../src/content';
import { TOKEN_LEVERS, type TokenModelParams } from '../src/content/types';
import {
  ALL_OFF,
  ALL_ON,
  BAR_WIDTH,
  barLayout,
  bitsFromLevers,
  calibrate,
  costOf,
  describeAssumptions,
  formatUsd,
  leversFromBits,
  readoutText,
} from '../src/widgets/tokenModel';

const model = calibrate(promptModel);
const states = Array.from({ length: 16 }, (_, bits) => leversFromBits(bits));

describe('slide 14 token model: calibrated corners', () => {
  it('lands exactly on the Handbook run: $41.01 with every lever off, $4.81 with every lever on', () => {
    expect(costOf(model, ALL_OFF).total).toBeCloseTo(41.01, 9);
    expect(costOf(model, ALL_ON).total).toBeCloseTo(4.81, 9);
    expect(formatUsd(costOf(model, ALL_OFF).total)).toBe('$41.01');
    expect(formatUsd(costOf(model, ALL_ON).total)).toBe('$4.81');
  });

  it('solves a sensible mid-tier price (a quarter of frontier, not a free or inverted tier)', () => {
    expect(model.midRatio).toBeGreaterThan(0.15);
    expect(model.midRatio).toBeLessThan(0.4);
    expect(model.usdPerToken).toBeGreaterThan(0);
  });

  it('is the same model the committed slide shows: stat equals the static readout', () => {
    const slide = deck.slides.find((s) => s.id === 'm4-prompt-debugger');
    expect(slide?.stat).toBe(readoutText(model));
    expect(readoutText(model)).toBe('$41.01 \u2192 $4.81 per run');
  });

  it('rejects inputs that cannot be calibrated rather than inventing numbers', () => {
    const bad: TokenModelParams = { ...promptModel, targets: { off: 41.01, on: 40.5 } };
    expect(() => calibrate(bad)).toThrow(/cannot be calibrated/);
    const inverted: TokenModelParams = { ...promptModel, targets: { off: 4.81, on: 0.0001 } };
    expect(() => calibrate(inverted)).toThrow(/cannot be calibrated/);
  });
});

describe('slide 14 token model: intermediate states are sane model outputs', () => {
  it('turning any lever on never raises the cost, and every lever lowers it from the all-off state', () => {
    for (const s of states) {
      for (const k of TOKEN_LEVERS) {
        if (s[k]) continue;
        const withLever = { ...s, [k]: true };
        expect(costOf(model, withLever).total, `${JSON.stringify(s)} + ${k}`).toBeLessThanOrEqual(costOf(model, s).total + 1e-12);
      }
    }
    for (const k of TOKEN_LEVERS) {
      expect(costOf(model, { ...ALL_OFF, [k]: true }).total).toBeLessThan(41.01);
    }
  });

  it('components always add up to the total, and the task work is the floor', () => {
    for (const s of states) {
      const c = costOf(model, s);
      expect(c.context + c.tools + c.work).toBeCloseTo(c.total, 9);
      expect(c.work).toBeGreaterThan(0);
    }
    const on = costOf(model, ALL_ON);
    expect(on.work / on.total, 'the inherent work dominates once the levers are on').toBeGreaterThan(0.9);
  });

  it('the cost values are deterministic and bit-addressable', () => {
    expect(states).toHaveLength(16);
    for (let bits = 0; bits < 16; bits++) expect(bitsFromLevers(leversFromBits(bits))).toBe(bits);
    expect(costOf(model, leversFromBits(0b0001)).total.toFixed(2)).toBe('25.46');
    expect(costOf(model, leversFromBits(0b0011)).total.toFixed(2)).toBe('20.68');
    expect(costOf(model, leversFromBits(0b0111)).total.toFixed(2)).toBe('19.72');
    expect(costOf(model, leversFromBits(0b1000)).total.toFixed(2)).toBe('7.29');
  });
});

describe('slide 14 stacked bar geometry', () => {
  it('the all-off bar fills the track exactly; the all-on bar ends at the floor marker', () => {
    const off = barLayout(model, ALL_OFF);
    const sum = (segs: typeof off.segs) => segs.reduce((n, g) => n + g.width, 0);
    expect(sum(off.segs)).toBeCloseTo(BAR_WIDTH, 6);
    const on = barLayout(model, ALL_ON);
    expect(sum(on.segs)).toBeCloseTo((4.81 / 41.01) * BAR_WIDTH, 6);
    expect(on.floorX).toBeCloseTo(sum(on.segs), 6);
  });

  it('segments are contiguous from the left edge, in a fixed order', () => {
    for (const s of states) {
      const { segs } = barLayout(model, s);
      expect(segs.map((g) => g.key)).toEqual(['context', 'tools', 'work']);
      expect(segs[0]?.x).toBe(0);
      expect((segs[1] as { x: number }).x).toBeCloseTo((segs[0] as { width: number }).width, 9);
      expect((segs[2] as { x: number }).x).toBeCloseTo((segs[0] as { width: number }).width + (segs[1] as { width: number }).width, 9);
    }
  });
});

describe('speaker assumptions drawer text', () => {
  const text = describeAssumptions(model);
  it('lists every token count and relative unit cost, and says it is not vendor pricing', () => {
    for (const needle of ['3,800', '450', '12 tokens per line', '2,000', '0% \u2192 80%', '65 \u2192 6', '150 tokens each', '15 frontier', '1 frontier planner + 3 mid-tier', '450,000', '56,000']) {
      expect(text).toContain(needle);
    }
    expect(text).toMatch(/not vendor pricing/i);
    expect(text).toContain(`Mid tier ${model.midRatio.toFixed(2)}`);
    expect(text).toContain('$41.01');
    expect(text).toContain('$4.81');
  });
});
