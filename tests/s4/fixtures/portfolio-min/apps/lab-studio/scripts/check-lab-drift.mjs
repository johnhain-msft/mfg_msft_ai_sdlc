#!/usr/bin/env node
// Drift detector between the workshop's lab markdown (labs/*.md) and Lab
// Studio's adapted content (client/src/labs/*.tsx).
//
//   npm run drift            report drift, exit 1 when any source changed
//   npm run drift:accept     record current source hashes as in-sync
//
//   --source <dir>           read labs/labNN.md from <dir>, a checkout of the
//                            workshop repository (default: this studio's
//                            parent directory, where the upstream repo keeps it)
//   --commit <sha>           with --accept: the source revision being recorded
//                            (kept from the manifest's _provenance when omitted)
//
// A hash is sha256, first 16 hex chars, over LF-normalised bytes: a Windows
// checkout turns the markdown into CRLF, and the recorded hashes are LF hashes.
// Keys that start with "_" in lab-sources.json (the _provenance block) are
// metadata, not labs: they are skipped when comparing and kept on --accept.
//
// Detection is deterministic; the repair is judgment work — do it with the
// lab-studio-maintainer agent (it follows .github/skills/lab-studio-sync).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(here, "..");
const manifestPath = join(studioRoot, "lab-sources.json");

const SOURCE_REPOSITORY = "ms-mfg-community/day-in-the-life-copilot-lab";
const HASHING = "sha256, first 16 hex chars, over LF-normalised bytes";

const args = process.argv.slice(2);
const accept = args.includes("--accept");
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const sourceRoot = resolve(option("--source") ?? resolve(studioRoot, ".."));

const LABS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, "0"));

function sha256(path) {
  const normalised = Buffer.from(readFileSync(path).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

function currentState() {
  const state = {};
  for (const n of LABS) {
    const source = join(sourceRoot, "labs", `lab${n}.md`);
    const studio = join(studioRoot, "client", "src", "labs", `lab${n}.tsx`);
    state[`lab${n}`] = {
      source: `labs/lab${n}.md`,
      sourceHash: existsSync(source) ? sha256(source) : null,
      studio: `client/src/labs/lab${n}.tsx`,
      studioExists: existsSync(studio),
    };
  }
  return state;
}

const state = currentState();
const recorded = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;

if (accept) {
  const commit = option("--commit") ?? recorded?._provenance?.commit;
  if (!commit) {
    console.error("No source revision to record. Pass --commit <sha> (the workshop commit the labs were read from).");
    process.exit(1);
  }
  const provenance = {
    repository: recorded?._provenance?.repository ?? SOURCE_REPOSITORY,
    commit,
    hashing: HASHING,
  };
  writeFileSync(manifestPath, JSON.stringify({ _provenance: provenance, ...state }, null, 2) + "\n");
  console.log(`Recorded ${LABS.length} source hashes in lab-sources.json (source ${commit}) — studio marked in sync.`);
  process.exit(0);
}

if (!recorded) {
  console.error("No lab-sources.json baseline. Run `npm run drift:accept` once the studio matches the labs.");
  process.exit(1);
}

const drifted = [];
const missing = [];
for (const n of LABS) {
  const key = `lab${n}`;
  const now = state[key];
  const was = recorded[key];
  if (!now.studioExists) missing.push(now.studio);
  if (!was || was.sourceHash !== now.sourceHash) drifted.push(now.source);
}

if (drifted.length === 0 && missing.length === 0) {
  const commit = recorded._provenance?.commit;
  console.log(`✓ Lab Studio content is in sync with labs/*.md (per recorded baseline${commit ? `, source ${commit}` : ""}).`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`✗ Studio content missing for: ${missing.join(", ")}`);
}
if (drifted.length > 0) {
  console.error("✗ Lab markdown changed since the studio content was last synced:");
  for (const file of drifted) console.error(`    ${file}`);
  console.error("\n  Update the matching client/src/labs/*.tsx (and any verify checks or");
  console.error("  template files it depends on) — the lab-studio-maintainer agent with the");
  console.error("  lab-studio-sync skill is built for this:");
  console.error('    copilot --agent lab-studio-maintainer -p "Sync Lab Studio with the lab markdown changes" --allow-all-tools');
  console.error("\n  When the studio matches again: npm run drift:accept");
}
process.exit(1);
