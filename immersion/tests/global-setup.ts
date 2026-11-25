import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Rebuild `dist/index.html` and `docs/SPEAKER-SCRIPT.md` before the e2e suite runs. */
export default function globalSetup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
}
