/**
 * Hash routing. Pure: no `window`, so it is unit-testable in Node.
 *
 *   Audience deck   #/<slide-id>   #/<n>   #/s<n>   #s<n>      optional step: #/<ref>/<step>
 *   Speaker view    #/speaker      #/speaker/<ref>
 *   Script Book     #/script       #/script/<ref>              (#/book is an alias)
 *
 * `<ref>` is a slide id, a 1-based number, or `s<n>` (the pre-rendered section id).
 * Anything unrecognised falls back to slide 1 and says so, so a typo never shows a blank screen.
 */

export type Route =
  | { kind: 'deck'; id: string; step: number; unknown?: string }
  | { kind: 'speaker'; id: string; unknown?: string }
  | { kind: 'script'; id: string | null; unknown?: string };

/** Resolve `m1-attention-economy`, `3`, `s3` to a slide id, or null. */
export function resolveSlideRef(ref: string, ids: readonly string[]): string | null {
  if (ids.includes(ref)) return ref;
  const m = /^s?(\d+)$/i.exec(ref);
  if (m) {
    const n = parseInt(m[1] as string, 10);
    if (n >= 1 && n <= ids.length) return ids[n - 1] as string;
  }
  return null;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseHash(hash: string, ids: readonly string[]): Route {
  const first = ids[0] as string;
  const raw = safeDecode(hash.replace(/^#/, ''));
  if (raw === '' || raw === '/') return { kind: 'deck', id: first, step: 0 };

  // `#s3` (no slash) is a legacy section anchor.
  const bare = /^s(\d+)$/i.exec(raw);
  if (bare) {
    const id = resolveSlideRef(raw, ids);
    return id ? { kind: 'deck', id, step: 0 } : { kind: 'deck', id: first, step: 0, unknown: raw };
  }

  const parts = raw.replace(/^\//, '').split('/').filter((p) => p !== '');
  const head = (parts[0] ?? '').toLowerCase();

  if (head === 'speaker') {
    const ref = parts[1];
    if (!ref) return { kind: 'speaker', id: first };
    const id = resolveSlideRef(ref, ids);
    return id ? { kind: 'speaker', id } : { kind: 'speaker', id: first, unknown: ref };
  }
  if (head === 'script' || head === 'book') {
    const ref = parts[1];
    if (!ref) return { kind: 'script', id: null };
    const id = resolveSlideRef(ref, ids);
    return id ? { kind: 'script', id } : { kind: 'script', id: null, unknown: ref };
  }

  const id = resolveSlideRef(parts[0] as string, ids);
  if (!id) return { kind: 'deck', id: first, step: 0, unknown: parts[0] as string };
  const step = parts[1] && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
  return { kind: 'deck', id, step };
}

export const deckHash = (id: string, step = 0): string => `#/${id}${step > 0 ? `/${step}` : ''}`;
export const speakerHash = (id: string | null): string => (id ? `#/speaker/${id}` : '#/speaker');
export const scriptHash = (id: string | null): string => (id ? `#/script/${id}` : '#/script');

/** Hash of the same view as `route`, in canonical form. */
export function canonicalHash(route: Route): string {
  switch (route.kind) {
    case 'deck':
      return deckHash(route.id, route.step);
    case 'speaker':
      return speakerHash(route.id);
    case 'script':
      return scriptHash(route.id);
  }
}
