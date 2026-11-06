// Progress and diagnostics go to stderr only (stdout is reserved for the BootstrapSummaryReport).
// Every line passes through a redactor that knows the secret values this run has handled, so a
// value that slips into a message is replaced before it reaches the terminal (AC29).

const MIN_SECRET_LENGTH = 8;

export function createLogger(stream) {
  const secrets = new Set();

  const redact = (text) => {
    let out = String(text);
    for (const secret of secrets) out = out.split(secret).join("***");
    return out;
  };

  const write = (text) => {
    stream.write(redact(text));
  };

  return {
    /** Registers a secret value (and each long line of a multi-line value) for redaction. */
    addSecret(value) {
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
      secrets.add(value);
      if (value.includes("\n")) {
        for (const line of value.split(/\r?\n/)) {
          if (line.trim().length >= MIN_SECRET_LENGTH) secrets.add(line.trim());
        }
      }
    },
    redact,
    info: (message) => write(`${message}\n`),
    warn: (message) => write(`warning: ${message}\n`),
    error: (message) => write(`error: ${message}\n`),
    /** Forwards the output of a child process unchanged apart from redaction. */
    raw: (text) => {
      if (text !== "") write(text.endsWith("\n") ? text : `${text}\n`);
    },
  };
}
