import { describe, expect, it } from 'vitest';
import { STAGE_HEIGHT, STAGE_WIDTH, computeScale } from '../src/shell/fit';
import { canonicalHash, deckHash, parseHash, resolveSlideRef, scriptHash, speakerHash } from '../src/shell/router';

const ids = ['m1-cover', 'm1-vibe-cliff', 'm1-attention-economy', 'm2-hero-trap'] as const;

describe('hash routing', () => {
  it('reaches slide 3 by id, number, s<n>, and #s<n>', () => {
    for (const h of ['#/3', '#/s3', '#s3', '#/m1-attention-economy', '/3', 's3']) {
      expect(parseHash(h, ids), h).toEqual({ kind: 'deck', id: 'm1-attention-economy', step: 0 });
    }
  });

  it('an empty hash is slide 1', () => {
    expect(parseHash('', ids)).toEqual({ kind: 'deck', id: 'm1-cover', step: 0 });
    expect(parseHash('#', ids)).toEqual({ kind: 'deck', id: 'm1-cover', step: 0 });
    expect(parseHash('#/', ids)).toEqual({ kind: 'deck', id: 'm1-cover', step: 0 });
  });

  it('carries a stage step', () => {
    expect(parseHash('#/m2-hero-trap/2', ids)).toEqual({ kind: 'deck', id: 'm2-hero-trap', step: 2 });
    expect(parseHash('#/4/3', ids)).toEqual({ kind: 'deck', id: 'm2-hero-trap', step: 3 });
    expect(parseHash('#/4/x', ids)).toEqual({ kind: 'deck', id: 'm2-hero-trap', step: 0 });
  });

  it('unknown or out-of-range refs fall back to slide 1 and say so', () => {
    expect(parseHash('#/nonsense', ids)).toEqual({ kind: 'deck', id: 'm1-cover', step: 0, unknown: 'nonsense' });
    expect(parseHash('#/0', ids)).toMatchObject({ id: 'm1-cover', unknown: '0' });
    expect(parseHash('#/5', ids)).toMatchObject({ id: 'm1-cover', unknown: '5' });
    expect(parseHash('#s99', ids)).toMatchObject({ id: 'm1-cover', unknown: 's99' });
  });

  it('speaker and script routes, with the #/book alias', () => {
    expect(parseHash('#/speaker', ids)).toEqual({ kind: 'speaker', id: 'm1-cover' });
    expect(parseHash('#/speaker/m2-hero-trap', ids)).toEqual({ kind: 'speaker', id: 'm2-hero-trap' });
    expect(parseHash('#/speaker/2', ids)).toEqual({ kind: 'speaker', id: 'm1-vibe-cliff' });
    expect(parseHash('#/speaker/zzz', ids)).toMatchObject({ kind: 'speaker', id: 'm1-cover', unknown: 'zzz' });
    expect(parseHash('#/script', ids)).toEqual({ kind: 'script', id: null });
    expect(parseHash('#/script/m1-vibe-cliff', ids)).toEqual({ kind: 'script', id: 'm1-vibe-cliff' });
    expect(parseHash('#/book/s4', ids)).toEqual({ kind: 'script', id: 'm2-hero-trap' });
    expect(parseHash('#/script/zzz', ids)).toMatchObject({ kind: 'script', id: null, unknown: 'zzz' });
  });

  it('tolerates malformed percent-encoding instead of throwing', () => {
    expect(() => parseHash('#/%E0%A4%A', ids)).not.toThrow();
  });

  it('round-trips canonical hashes', () => {
    expect(deckHash('m2-hero-trap')).toBe('#/m2-hero-trap');
    expect(deckHash('m2-hero-trap', 2)).toBe('#/m2-hero-trap/2');
    expect(speakerHash(null)).toBe('#/speaker');
    expect(scriptHash('m1-cover')).toBe('#/script/m1-cover');
    for (const h of ['#/m1-cover', '#/m2-hero-trap/3', '#/speaker/m1-vibe-cliff', '#/script/m2-hero-trap', '#/script']) {
      expect(canonicalHash(parseHash(h, ids))).toBe(h);
    }
  });

  it('resolveSlideRef never accepts 0, negatives or overflow', () => {
    for (const bad of ['0', '-1', '5', 's0', 's5', '']) expect(resolveSlideRef(bad, ids), bad).toBeNull();
  });
});

describe('stage fitting', () => {
  it('scales the 1920x1080 stage exactly at the design size and the common laptop sizes', () => {
    expect(computeScale(1920, 1080)).toBe(1);
    expect(computeScale(1536, 864)).toBeCloseTo(0.8, 6);
    expect(computeScale(1366, 768)).toBeCloseTo(768 / 1080, 6);
  });

  it('letterboxes: the scale is the smaller axis, so the stage never clips', () => {
    for (const [w, h] of [
      [1100, 900],
      [900, 1100],
      [3840, 2160],
      [640, 360],
      [2560, 1080],
    ] as const) {
      const s = computeScale(w, h);
      expect(STAGE_WIDTH * s).toBeLessThanOrEqual(w + 1e-9);
      expect(STAGE_HEIGHT * s).toBeLessThanOrEqual(h + 1e-9);
      expect(Math.min(Math.abs(STAGE_WIDTH * s - w), Math.abs(STAGE_HEIGHT * s - h)), 'one axis fits exactly').toBeLessThan(1e-6);
    }
  });

  it('upscales on large displays and never returns zero or NaN for a collapsed box', () => {
    expect(computeScale(3840, 2160)).toBe(2);
    for (const [w, h] of [
      [0, 0],
      [-5, 100],
      [100, 0],
      [Number.NaN, 10],
    ] as const) {
      const s = computeScale(w, h);
      expect(Number.isFinite(s) && s > 0).toBe(true);
    }
  });
});
