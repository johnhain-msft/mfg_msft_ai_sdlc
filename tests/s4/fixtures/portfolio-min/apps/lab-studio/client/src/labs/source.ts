/**
 * The curriculum revision these lessons were synchronised to. Every link to a
 * source lab goes through this module, so a re-sync changes one place (and
 * lab-sources.json, which a test keeps equal to it).
 */
export const SOURCE_REPOSITORY = "ms-mfg-community/day-in-the-life-copilot-lab";
export const SOURCE_COMMIT = "2108ac9a1e9eff96e97b500117b0de4a546768c3";

/** A file in the source repository, pinned to SOURCE_COMMIT rather than a branch. */
export function sourceUrl(path: string): string {
  return `https://github.com/${SOURCE_REPOSITORY}/blob/${SOURCE_COMMIT}/${path}`;
}

export const SOURCE_SHORT_COMMIT = SOURCE_COMMIT.slice(0, 7);
