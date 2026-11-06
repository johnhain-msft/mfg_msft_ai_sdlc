// Pure validators shared by the flag parsers and the onboarding synthesis: five-field cron
// expressions (AC47), watch URLs (AC48), repository slugs and the projectKey derivation (AC46).

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 6, names: WEEKDAYS, nameBase: 0 },
];

function cronValue(token, field) {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value >= field.min && value <= field.max ? value : null;
  }
  if (field.names) {
    const index = field.names.indexOf(token.toUpperCase());
    if (index !== -1) return index + field.nameBase;
  }
  return null;
}

function validCronItem(item, field) {
  const [range, step, ...extra] = item.split("/");
  if (extra.length > 0) return false;
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return false;
  if (range === "*") return true;
  const bounds = range.split("-");
  if (bounds.length > 2 || bounds.some((bound) => bound === "")) return false;
  const values = bounds.map((bound) => cronValue(bound, field));
  if (values.some((value) => value === null)) return false;
  return values.length === 1 || values[0] <= values[1];
}

/** True when the text is a five-field cron expression that GitHub Actions accepts (`*`, lists, ranges, steps, month and weekday names). */
export function isValidCron(text) {
  if (typeof text !== "string" || text !== text.trim()) return false;
  const fields = text.split(" ");
  if (fields.length !== 5) return false;
  return fields.every((field, index) => field !== "" && field.split(",").every((item) => validCronItem(item, CRON_FIELDS[index])));
}

/** The watch-URL kind rules of AC48; the first rule that matches wins. */
export function inferWatchKind(url) {
  if (/changelog|release-notes|releases/i.test(url)) return "changelog";
  if (/blog/i.test(url)) return "blog";
  if (/\.(rss|atom|xml)$/i.test(url)) return "feed";
  return "docs";
}

/**
 * Validates a --watch-url value (an https URL with an exact hostname: no wildcard, no embedded
 * credentials, no IP literal) and returns the watchUrls entry { url, label, kind }.
 * @throws {Error} with the reason when the value is not acceptable
 */
export function parseWatchUrl(value) {
  if (typeof value !== "string" || value === "" || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`watch URL ${JSON.stringify(value)} must be a non-empty URL without whitespace`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`watch URL '${value}' is not an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`watch URL '${value}' is not an https URL`);
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`watch URL '${value}' embeds credentials`);
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/)[0];
  if (parsed.hostname === "" || /[*]/.test(authority) || parsed.hostname.includes("*") || /%2a/i.test(authority)) {
    throw new Error(`watch URL '${value}' needs an exact hostname without a wildcard`);
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.startsWith("[")) {
    throw new Error(`watch URL '${value}' uses an IP literal; give a hostname`);
  }
  return { url: value, label: `${parsed.hostname}${parsed.pathname}`, kind: inferWatchKind(value) };
}

export const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export const isRepoSlug = (value) => typeof value === "string" && REPO_SLUG.test(value);

/** `owner/repo` as { owner, repo }. */
export function splitSlug(slug) {
  const index = slug.indexOf("/");
  return { owner: slug.slice(0, index), repo: slug.slice(index + 1) };
}

/** ASCII case-insensitive owner comparison (toLowerCase on both sides), as AC19 and AC49 require. */
export const sameOwner = (a, b) => a.toLowerCase() === b.toLowerCase();

/** projectKey of a repository name (AC46): lower-cased, runs outside [a-z0-9] become one "-", trimmed, at most 63 characters. */
export function deriveProjectKey(repoName) {
  return String(repoName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** upstreamSlug of a project key: upper-cased with "-" replaced by "_" (AC49). */
export const slugOf = (projectKey) => projectKey.toUpperCase().replace(/-/g, "_");
