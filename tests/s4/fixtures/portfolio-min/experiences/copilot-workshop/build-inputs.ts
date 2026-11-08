// A fingerprint of everything the Teaching SPA bundle is built from.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const INPUTS = ['content', 'src', 'public', 'index.html', 'provenance.json', 'source-inputs.json', 'build-inputs.ts', 'vite.config.ts', 'tsconfig.json'];

function walk(dir: string, root: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(abs, root) : [path.relative(root, abs).split(path.sep).join('/')];
  });
}

/** SHA-256 over the names and LF-normalised text of every build input, in sorted order. */
export function hashBuildInputs(root: string): { sha256: string; files: number } {
  const files = INPUTS.flatMap((input) => (statSync(path.join(root, input)).isDirectory() ? walk(path.join(root, input), root) : [input])).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return { sha256: hash.digest('hex'), files: files.length };
}
