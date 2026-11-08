// CODEOWNERS parsing for the onboarding inspection (AC45, AC46, AC49). Reviewers of a pull request must be
// individual accounts: a team (@org/team) and an e-mail owner cannot be requested through the reviewers list of
// safe-outputs.create-pull-request, so only `@login` owners count.

const INDIVIDUAL = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;

/**
 * @param {string} text the content of .github/CODEOWNERS
 * @returns {{ individuals: string[], teams: string[] }} logins without the leading "@" (first appearance order, no duplicates)
 *   and team handles (with "@")
 */
export function parseCodeowners(text) {
  const individuals = [];
  const teams = [];
  const seen = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const owners = line.split(/\s+/).slice(1);
    for (const owner of owners) {
      const match = INDIVIDUAL.exec(owner);
      if (match) {
        if (!seen.has(match[1].toLowerCase())) {
          seen.add(match[1].toLowerCase());
          individuals.push(match[1]);
        }
      } else if (/^@[^/\s]+\/[^/\s]+$/.test(owner) && !teams.includes(owner)) {
        teams.push(owner);
      }
    }
  }
  return { individuals, teams };
}

/** The individual (non-team) owners of a CODEOWNERS file; the one function that AC46 and AC49 both use for reviewers. */
export const individualOwners = (text) => (text === null || text === undefined ? [] : parseCodeowners(text).individuals);
