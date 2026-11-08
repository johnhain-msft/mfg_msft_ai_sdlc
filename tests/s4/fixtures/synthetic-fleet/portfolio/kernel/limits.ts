export const MAX_LINES = 12;
export const FORBIDDEN = { words: ['hush'] };

export function verifyPages(pages: { lines: string[] }[]): { rule: string; where: string }[] {
  return pages.flatMap((page, index) => (page.lines.length > MAX_LINES ? [{ rule: 'too-long', where: `page ${index}` }] : []));
}
