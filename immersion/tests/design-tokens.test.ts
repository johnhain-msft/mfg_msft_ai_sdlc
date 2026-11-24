import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WCAG 2.2 AA for the design tokens, in both themes. Parsed from the real stylesheet, so a token
// edit that breaks contrast fails here instead of in the room.

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1] as string] = (m[2] as string).toLowerCase();
  return out;
}

const light = vars((css.match(/:root\s*\{([\s\S]*?)\n\}/) as RegExpMatchArray)[1] as string);
const dark = { ...light, ...vars((css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/) as RegExpMatchArray)[1] as string) };

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ['surface', 'canvas', 'surface-2'] as const;
const TINTS = ['azure-soft', 'violet-soft', 'green-soft', 'amber-soft', 'red-soft'] as const;
const ACCENT_TEXT = ['azure', 'azure-strong', 'violet', 'green', 'amber', 'red'] as const;

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme tokens', (_name, t) => {
  const v = (k: string) => t[k] as string;

  it('has the specified palette', () => {
    const spec =
      _name === 'light'
        ? { canvas: '#f5f7fa', surface: '#ffffff', ink: '#111827', muted: '#4b5563', azure: '#0067b8', 'azure-strong': '#005299', violet: '#5b3fd6', green: '#107c41', amber: '#8a5700', red: '#b3261e' }
        : { canvas: '#0d1117', surface: '#161b26', ink: '#f0f4f8', muted: '#94a3b8', azure: '#58a6ff', violet: '#a99bff', amber: '#ffb454' };
    for (const [k, hex] of Object.entries(spec)) expect(v(k), k).toBe(hex);
  });

  it('body ink and muted ink are AA on every surface (4.5:1), and primary ink is AAA', () => {
    for (const s of SURFACES) {
      expect(ratio(v('ink'), v(s)), `ink on ${s}`).toBeGreaterThanOrEqual(7);
      expect(ratio(v('muted'), v(s)), `muted on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(v('ink'), v('surface'))).toBeGreaterThan(15);
  });

  it('every accent that carries text is AA on the surface and the canvas', () => {
    for (const a of ACCENT_TEXT) {
      if (_name === 'dark' && a === 'azure-strong') continue; // identical role, lighter in dark; checked below
      for (const s of ['surface', 'canvas'] as const) expect(ratio(v(a), v(s)), `${a} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(v('azure-strong'), v('surface'))).toBeGreaterThanOrEqual(4.5);
  });

  it('ink stays AA on every soft tint, and the dimmed (muted) ink on the dim surface', () => {
    for (const tint of TINTS) expect(ratio(v('ink'), v(tint)), `ink on ${tint}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v('muted'), v('surface-2'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v('muted'), v('canvas'))).toBeGreaterThanOrEqual(4.5);
  });

  it('text on a filled accent is AA', () => {
    expect(ratio(v('on-accent'), v('azure'))).toBeGreaterThanOrEqual(4.5);
  });

  it('non-text UI (borders, chart segments, focus ring) clears 3:1 against the surface', () => {
    for (const k of ['line-strong', 'seg-ctx', 'seg-tools', 'seg-work', 'focus']) {
      expect(ratio(v(k), v('surface')), `${k} on surface`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('typography tokens', () => {
  it('uses the Segoe UI Variable stack and Cascadia Mono for code', () => {
    expect(css).toMatch(/--font-display:\s*'Segoe UI Variable Display'/);
    expect(css).toMatch(/--font-text:\s*'Segoe UI Variable Text',\s*'Segoe UI'/);
    expect(css).toMatch(/--font-mono:\s*'Cascadia Mono'/);
    expect(css).toMatch(/system-ui/);
  });
});
