// Secrets that a script of the router holds are never printed (SPEC-03 AC69): not the App's private key, not an installation token, not the token of the
// job, not an Authorization header value. The scripts register each secret as soon as they hold it, and everything they write (standard output and
// error, the decision log, the body of an issue) passes through `redact`, whatever its source: a server that echoes a credential, a command of a
// preflight that prints its environment, an error message that quotes a request.

const MASK = "***";
const MIN_LENGTH = 6;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/;
const TOKEN = /^gh[a-z]_[A-Za-z0-9_]+$/;

/** Every spelling of a secret that could reach an output: itself, a private key's lines and its collapsed body, its JSON-escaped form, a token's basic-auth form. */
export function secretForms(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < MIN_LENGTH) return [];
  const forms = new Set([text]);
  const pem = PEM.exec(text);
  if (pem) {
    const lines = pem[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 12);
    for (const line of lines) forms.add(line);
    if (lines.length > 0) forms.add(lines.join(""));
  }
  forms.add(JSON.stringify(text).slice(1, -1));
  if (TOKEN.test(text)) forms.add(Buffer.from(`x-access-token:${text}`, "utf8").toString("base64"));
  return [...forms].filter((form) => form.length >= MIN_LENGTH);
}

/**
 * The values of an environment that are secrets by the name of their variable (a token, a private key, a password, a secret). The scripts do not name the
 * variables that they hold: whatever the workflow hands them under such a name is registered.
 * @param {Record<string, string | undefined>} env
 */
export function secretsOfEnvironment(env) {
  return Object.entries(env ?? {})
    .filter(([name, value]) => /(TOKEN|SECRET|PASSWORD|PRIVATE_?KEY|CREDENTIAL)/i.test(name) && typeof value === "string")
    .map(([, value]) => value);
}

/**
 * A set of secrets that grows as the script learns them.
 * @param {Array<string | undefined>} [initial]
 */
export function createRedactor(initial = []) {
  const forms = new Set();
  const add = (value) => {
    for (const form of secretForms(value)) forms.add(form);
  };
  initial.forEach(add);
  return {
    add,
    /** @param {unknown} text */
    redact(text) {
      let out = String(text ?? "");
      // the longest spelling first, so that a short one cannot leave a fragment of a longer one behind
      for (const form of [...forms].sort((a, b) => b.length - a.length)) if (out.includes(form)) out = out.split(form).join(MASK);
      return out;
    },
  };
}
