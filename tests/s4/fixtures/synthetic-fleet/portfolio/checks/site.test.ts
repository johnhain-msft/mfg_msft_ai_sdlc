import { describe, expect, it } from 'vitest';
import { MAX_LINES } from '../kernel/limits';

describe("site guard rails", () => {
  it('keeps the kernel limits', () => {
    expect(MAX_LINES).toBe(12);
  });
});

describe('site extras', () => {
  it('may be edited', () => {
    expect(1).toBe(1);
  });
});
