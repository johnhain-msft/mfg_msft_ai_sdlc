// A hermetic stand-in for experiences/pipeline-showcase/capture/fetch-run-data.mjs of the downstream (SPEC-03 F14, F23-F26). It has the shape that the router depends
// on and no network: a RUNS array of the eleven run ids of F24, an output file beside the script (../content/run-data.json), and a `snapshotAt` that is the wall-clock
// time of every run. What it "captures" is the answer.json that stands beside it; a test chooses what that is, in the downstream repository it builds.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const OUT = fileURLToPath(new URL("../content/run-data.json", import.meta.url));
const ANSWER = fileURLToPath(new URL("./answer.json", import.meta.url));

/** The runs the walkthrough tells its story with. Every one is a completed or waiting public run. */
const RUNS = [
  { key: "ci", id: 39781079785, story: "Push to main runs the CI gate." },
  { key: "codeql", id: 39781079636, story: "CodeQL analyses the same push." },
  { key: "dependency-review", id: 39780778851, story: "Dependency review checks the pull request." },
  { key: "container-scan", id: 39780778886, story: "Trivy scans the built image." },
  { key: "scorecard", id: 40446543496, story: "Scorecard grades the repository on a schedule." },
  { key: "dependabot", id: 40573274820, story: "Dependabot opens grouped pull requests." },
  { key: "cd", id: 39443641702, story: "Build once, then promote the same digest." },
  { key: "cd-initial", id: 39440423127, story: "The first CD run." },
  { key: "rollback", id: 39445050929, story: "Manual rollback re-deploys the earlier digest." },
  { key: "cd-waiting", id: 39449984245, story: "A manual CD run waiting for a reviewer." },
  { key: "cd-queued", id: 39781079595, story: "A newer CD run queued behind the waiting one." },
];

const answer = JSON.parse(readFileSync(ANSWER, "utf8"));
if (answer.fixtureBehaviour === "exit") {
  process.stderr.write(`${answer.message ?? "the capture failed"}\n`);
  process.exit(answer.code ?? 1);
}
if (answer.fixtureBehaviour === "write-nothing") process.exit(0);
const { fixtureBehaviour, ...content } = answer;
const snapshot = { snapshotAt: new Date().toISOString(), ...content, runs: content.runs ?? RUNS.map((run) => ({ key: run.key, id: run.id })) };
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`wrote ${OUT} (${snapshot.runs.length} runs)\n`);
