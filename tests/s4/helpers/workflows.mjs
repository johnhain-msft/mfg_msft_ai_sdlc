// The three AI adaptation workflows of the preset, as the committed files, with the identities of SPEC-04 AC5 and the small readers that the static tests share.
import YAML from "yaml";
import { abs, readText } from "./fixtures.mjs";
import { customJobsOf, globMatches, parseWorkflow, presetManifest, readWorkflow, referenceRequest, stepWithRun, stepsOf } from "../../s1/helpers/fixtures.mjs";

export { customJobsOf, globMatches, parseWorkflow, presetManifest, readWorkflow, referenceRequest, stepWithRun, stepsOf };

export const WORKFLOW_DIR = ".github/workflows";
export const DOWNSTREAM = "johnhain-msft/portfolio";

export const AI = [
  {
    edgeId: "copilot-lab",
    id: "cascade-ai-copilot-lab",
    upstreamKey: "copilot-lab",
    upstreamSlug: "COPILOT_LAB",
    upstreamRepo: "ms-mfg-community/day-in-the-life-copilot-lab",
    repo: "day-in-the-life-copilot-lab",
    branchName: "sdlc/cascade-copilot-lab",
    closeOlderKey: "sdlc-cascade-copilot-lab",
    group: "sdlc-state-copilot-lab",
    scopes: ["both", "workshop-only", "studio-only"],
    provenanceFile: "experiences/copilot-workshop/source-inputs.json",
  },
  {
    edgeId: "pipeline-showcase",
    id: "cascade-ai-pipeline-showcase",
    upstreamKey: "pipeline-showcase",
    upstreamSlug: "PIPELINE_SHOWCASE",
    upstreamRepo: "ms-mfg-community/github-pipeline-showcase",
    repo: "github-pipeline-showcase",
    branchName: "sdlc/cascade-pipeline-showcase",
    closeOlderKey: "sdlc-cascade-pipeline-showcase",
    group: "sdlc-state-pipeline-showcase",
    scopes: ["showcase-runs"],
    provenanceFile: "experiences/pipeline-showcase/content/provenance.json",
  },
  {
    edgeId: "github-intermediate",
    id: "cascade-ai-github-intermediate",
    upstreamKey: "github-intermediate",
    upstreamSlug: "GITHUB_INTERMEDIATE",
    upstreamRepo: "githubschool/gh-github-intermediate-template",
    repo: "gh-github-intermediate-template",
    branchName: "sdlc/cascade-github-intermediate",
    closeOlderKey: "sdlc-cascade-github-intermediate",
    group: "sdlc-state-github-intermediate",
    scopes: ["github-intermediate"],
    provenanceFile: "experiences/github-intermediate-labs/provenance.json",
  },
];

export const WORKFLOW_IDS = AI.map((spec) => spec.id);
/** The sync scopes of this fleet: the engine has no list of them (a scope is any id that an edge declares), so these are the ones that this repository's three AI edges use. */
export const ALL_SCOPES = ["both", "workshop-only", "studio-only", "showcase-runs", "github-intermediate"];

/** The commands of the first fenced bash block of a prompt, as one script. */
export function promptBlock(body) {
  const match = /```bash\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("the prompt has no fenced bash block");
  return match[1];
}

let preset = null;
/** The preset manifest (parsed once). */
export const manifest = () => (preset ??= presetManifest());
/** The preset edge of a workflow spec. */
export const edgeOf = (spec) => manifest().dependencyEdges.find((edge) => edge.edgeId === spec.edgeId);
/** The committed workflow `.md`: parsed frontmatter, its text and the prompt body. */
export const workflowOf = (spec) => readWorkflow(`${spec.id}.md`);
/** The committed compiled workflow. */
export const lockOf = (spec) => YAML.parse(readText(abs(WORKFLOW_DIR, `${spec.id}.lock.yml`)));
export const lockTextOf = (spec) => readText(abs(WORKFLOW_DIR, `${spec.id}.lock.yml`));

/** The text of a rendered shell block of a frontmatter step list, by step name. */
export const stepNamed = (steps, name) => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step named '${name}'`);
  return step;
};

/** The custom jobs of the committed source of a workflow. */
export const customJobs = (spec) => customJobsOf(workflowOf(spec).frontmatter.jobs);
