import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Ask git itself, so the guard follows whatever the repo's ignore rules are today. This project may be the repository
 * root or a folder inside a larger repository, so ask git whether ROOT is in a work tree rather than looking for `.git`.
 * `null` when there is no git work tree to ask (a tarball, an export).
 */
function ignoredProjectFiles(): string[] | null {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const r = spawnSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'src', 'tests', 'scripts', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
}

describe('repository hygiene', () => {
  // The repo ignores `TEMP*` (scratch planning files). On Windows git matches that case-insensitively, so a source file
  // named `template.ts` is silently dropped from `git add` and a fresh clone would not build.
  it('no source, test, script or config file is hidden by a .gitignore rule', () => {
    const ignored = ignoredProjectFiles();
    if (ignored === null) return; // no git repo (tarball, export): nothing to ask
    expect(ignored, 'rename these: a .gitignore rule matches them, so they would never be committed').toEqual([]);
  });
});
