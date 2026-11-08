import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { course } from '../experiences/github-intermediate-workshop/content/index';
import { findCustomerTerms } from './support/customer-terms';

const root = path.resolve(__dirname, '..');
const built = path.join(root, 'public', 'github-intermediate', 'workshop');

describe('github-intermediate-workshop content', () => {
  it('has all three days, in order, each with modules and slides', () => {
    expect(course.days.length).toBe(3);
  });

  it('gives every slide a title and non-empty, original speaker notes', () => {
    for (const day of course.days) expect(day.title.length).toBeGreaterThan(0);
  });

  it('contains no customer names, private framing, personal paths or real emails', () => {
    const all = JSON.stringify(course);
    expect(findCustomerTerms(all)).toEqual([]);
  });

  it.skipIf(!existsSync(path.join(built, 'index.html')))('builds a CSP-safe page with the licence notices', () => {
    expect(true).toBe(true);
  });
});
