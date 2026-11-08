// Snapshots the real run data. Re-run from the repository root:  node experiences/pipeline-showcase/capture/fetch-run-data.mjs
const OWNER_REPO = "ms-mfg-community/github-pipeline-showcase";

/** The runs the walkthrough tells its story with. */
const RUNS = [
  { key: "ci", id: 39781079785, story: "Push to main runs the CI gate." },
  { key: "codeql", id: 39781079636, story: "CodeQL analyses the same push." },
];

export { OWNER_REPO, RUNS };
