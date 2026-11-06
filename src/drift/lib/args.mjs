// Command-line parsing for the drift scripts (SPEC-02).
//
// A value-taking option always consumes the next argument, even when that argument starts with a dash,
// because the workflow passes free text such as extra instructions ("- do this first") on the same command line.
// An unknown option is an error, so that a typo can never be read as "not set".

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * @param {string[]} argv the arguments after the script name
 * @param {Record<string, { type: "string" | "boolean" }>} spec option names without the leading dashes
 * @returns {Record<string, string | boolean | undefined>} only the options that were given
 */
export function parseFlags(argv, spec) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--") || token === "--") {
      throw new UsageError(`unexpected argument '${token}'`);
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const definition = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (definition === undefined) throw new UsageError(`unknown option '--${name}'`);
    if (definition.type === "boolean") {
      if (equals !== -1) values[name] = parseBoolean(token.slice(equals + 1), `--${name}`);
      else values[name] = true;
      continue;
    }
    if (equals !== -1) {
      values[name] = token.slice(equals + 1);
    } else {
      if (index + 1 >= argv.length) throw new UsageError(`option '--${name}' needs a value`);
      index += 1;
      values[name] = argv[index];
    }
  }
  return values;
}

/** `true` and `false` in any case; the empty string means false (a schedule run has no inputs). */
export function parseBoolean(value, label) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false" || text === "") return false;
  throw new UsageError(`${label} must be true or false, got '${String(value).slice(0, 40)}'`);
}

/** A repository slug as the manifest schema defines it: <owner>/<name>. */
export const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export function requireSlug(value, label) {
  const text = String(value ?? "").trim();
  if (!REPO_SLUG.test(text)) throw new UsageError(`${label} must be an <owner>/<repository> slug, got '${text.slice(0, 80)}'`);
  return text;
}

/** The repository-name segment of a slug; it is the checkout directory that the renderer uses. */
export const repoName = (slug) => slug.slice(slug.indexOf("/") + 1);
