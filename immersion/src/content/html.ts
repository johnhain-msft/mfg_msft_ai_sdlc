/**
 * Tiny pure HTML helpers shared by the build-time renderer and the widgets.
 * No DOM access: importable from Node.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for an HTML text node or attribute value. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] as string);

/** Serialize attributes. `undefined`, `null` and `false` are dropped; `true` renders a bare attribute. */
export function attrs(map: Record<string, string | number | boolean | null | undefined> | undefined): string {
  if (!map) return '';
  let out = '';
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null || v === false) continue;
    out += v === true ? ` ${k}` : ` ${k}="${esc(String(v))}"`;
  }
  return out;
}

/** Join class names, dropping empties. */
export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(' ');
