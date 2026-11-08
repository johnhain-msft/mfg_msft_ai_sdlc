// A gh for the hermetic run of the S4 suite (AC76): it records every call in the log that SDLC_S4_SHIM_LOG names, refuses every write (a pull request, an issue, a comment, a label, a
// workflow dispatch, a variable, a release, a gh api call with a method other than GET), and answers every read with `null`.
import fs from "node:fs";

const args = process.argv.slice(2);
const joined = args.join(" ");
const WRITE_VERBS = [
  /^pr (create|merge|edit|comment|close|review|ready|reopen)\b/,
  /^issue (create|edit|comment|close|reopen|delete|transfer|lock|pin)\b/,
  /^workflow (run|enable|disable)\b/,
  /^release (create|edit|delete|upload)\b/,
  /^label (create|edit|delete|clone)\b/,
  /^(secret|variable) (set|delete|remove)\b/,
  /^repo (create|delete|edit|fork|rename|archive|sync)\b/,
  /^run (rerun|cancel|delete)\b/,
];

let write;
if (args[0] === "api") {
  const method = (/(?:-X|--method)[ =]?(\w+)/.exec(joined)?.[1] ?? (/(?:^| )(?:-f|-F|--field|--raw-field|--input)\b/.test(joined) ? "POST" : "GET")).toUpperCase();
  write = method !== "GET";
} else {
  write = WRITE_VERBS.some((pattern) => pattern.test(joined));
}

if (process.env.SDLC_S4_SHIM_LOG) fs.appendFileSync(process.env.SDLC_S4_SHIM_LOG, `${JSON.stringify({ tool: "gh", args, write, cwd: process.cwd() })}\n`);
if (write) {
  process.stderr.write("stub gh: a write is refused\n");
  process.exit(98);
}
process.stdout.write("null\n");
