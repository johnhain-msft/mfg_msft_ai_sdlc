/** Types for `scripts/build.mjs` (so tests can import `build` under strict TypeScript). */

export interface BuildOptions {
  /** Project root. Defaults to the repository root. */
  root?: string;
  /** Fail on any content finding, warnings included. Structural findings always fail. */
  strict?: boolean;
  /** Alternative content module with the same exports as `src/content/index.ts`. */
  contentEntry?: string;
  /** Defaults to `<root>/dist/index.html`. */
  outHtml?: string;
  /** Defaults to `<root>/docs/SPEAKER-SCRIPT.md`. */
  outScript?: string;
  /** `false` builds in memory only. */
  write?: boolean;
  /** Suppress the per-slide table and summary (findings are still reported). */
  quiet?: boolean;
}

export interface BuildFinding {
  slide: string;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface BuildResult {
  ok: boolean;
  findings: BuildFinding[];
  failures: BuildFinding[];
  html: string;
  script: string;
  wrote: string[];
}

export function build(options?: BuildOptions): Promise<BuildResult>;
