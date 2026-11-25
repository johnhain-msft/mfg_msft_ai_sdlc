/**
 * The illustrative per-run cost model behind slide 14 (`m4-prompt-debugger`).
 *
 * Inputs come from the slide's tiles (3,800 -> 450 lines, 0% -> 80% cache hits, 65 -> 6 tools,
 * 15 frontier retries -> plan + execute with a two-round cap). The remaining constants are
 * illustrative and chosen so the closed-form calibration lands the mid-tier price near a quarter
 * of the frontier price. Nothing here is vendor pricing.
 */

import type { TokenModelParams } from './types';

export const promptModel: TokenModelParams = {
  targets: { off: 41.01, on: 4.81 },
  contextLines: { off: 3800, on: 450 },
  tokensPerLine: 12,
  systemTokens: 2000,
  cacheHit: { off: 0, on: 0.8 },
  cachedPriceRatio: 0.1,
  tools: { off: 65, on: 6 },
  tokensPerTool: 150,
  turns: { off: 15, plan: 1, exec: 3 },
  work: { inputTokens: 450_000, outputTokens: 56_000 },
  outputPriceRatio: 5,
};
