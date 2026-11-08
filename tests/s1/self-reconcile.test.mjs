// AC57: self-reconciliation — one run with the same request makes every generated file match the manifest.
import assert from "node:assert/strict";
import test from "node:test";
import { clone, edgeOf, parseWorkflow, presetManifest, projectOf, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();

function listing(workspace) {
  const map = new Map();
  for (const line of workspace.hash([".github", ".gitattributes"]).split("\n").filter(Boolean)) {
    const at = line.lastIndexOf(":");
    map.set(line.slice(0, at), line.slice(at + 1));
  }
  return map;
}

function changes(before, after) {
  const created = [...after.keys()].filter((file) => !before.has(file)).sort();
  const removed = [...before.keys()].filter((file) => !after.has(file)).sort();
  const changed = [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort();
  return { created, changed, removed };
}

const NEW_PROJECT = {
  projectKey: "docs-site",
  repo: "acme-labs/docs-site",
  defaultBranch: "main",
  deconflictInRepoSchedules: "none",
  deconflictWorkflowIds: [],
  driftAudit: {
    enabled: true,
    schedule: "0 7 * * 3",
    upkeepStrategy: "content-and-docs-sync",
    instructions: "Keep the docs site current.",
    instructionsFile: null,
    knowledgeSources: { watchUrls: [{ url: "https://example.org/changelog", label: "Changelog", kind: "changelog" }], packageManifests: [], mcpServers: {} },
    buildCommands: [],
    verifyCommands: ["npm test"],
    draft: false,
    reviewers: ["docs-reviewer"],
  },
};

function newEdge() {
  return {
    ...clone(edgeOf(presetManifest(), "ghec-admin")),
    edgeId: "docs-sync",
    upstreamRepo: "acme-labs/docs-site",
    upstreamKey: "docs-site",
    upstreamSlug: "DOCS_SITE",
    stateVariable: "SDLC_SYNC_STATE_DOCS_SITE",
    branchName: "sdlc/cascade-docs-sync",
    closeOlderKey: "sdlc-cascade-docs-sync",
    provenanceFile: "public/docs/source.json",
    allowedFiles: ["public/docs/**"],
  };
}

test("AC57: every change of the manifest is applied by one run, and an immediate second run changes nothing", async () => {
  const workspace = createWorkspace();
  try {
    const manifest = presetManifest();
    const write = (value) => workspace.write("sdlc.yaml", toYaml(value));
    const compileCount = () => workspace.shims.compileCalls().length;
    const reconcileTwice = async (label) => {
      const before = listing(workspace);
      const compilesBefore = compileCount();
      const first = await workspace.reconcile(request);
      assert.equal(first.status, "ok", `${label}: ${JSON.stringify(first.validationResults)}`);
      const middle = listing(workspace);
      const status = workspace.status();
      const second = await workspace.reconcile(request);
      assert.equal(second.status, "ok", `${label} (second run)`);
      assert.deepEqual(changes(middle, listing(workspace)), { created: [], changed: [], removed: [] }, `${label}: the second run changes nothing`);
      assert.equal(workspace.status(), status, `${label}: git status --porcelain is unchanged by the second run`);
      assert.equal(compileCount() - compilesBefore, 2, `${label}: every run recompiles, even when nothing changed`);
      return changes(before, middle);
    };

    const baseline = await reconcileTwice("baseline");
    assert.equal(baseline.created.length, 18, "eight pairs, the router and aw.json");

    manifest.projects.push(NEW_PROJECT);
    write(manifest);
    assert.deepEqual(await reconcileTwice("add a project"), {
      created: [`${W}/drift-docs-site.lock.yml`, `${W}/drift-docs-site.md`],
      changed: [],
      removed: [],
    });

    manifest.projects.pop();
    write(manifest);
    assert.deepEqual(await reconcileTwice("remove the project"), {
      created: [],
      changed: [],
      removed: [`${W}/drift-docs-site.lock.yml`, `${W}/drift-docs-site.md`],
    });

    edgeOf(manifest, "ghec-admin").allowedFiles.push("public/ghec-admin-extra/**");
    write(manifest);
    assert.deepEqual(await reconcileTwice("change an edge's allowedFiles"), {
      created: [],
      changed: [`${W}/cascade-mechanical-ghec-admin.lock.yml`, `${W}/cascade-mechanical-ghec-admin.md`],
      removed: [],
    });

    const bodyBefore = parseWorkflow(workspace.read(`${W}/drift-gh-admin-msft.md`));
    projectOf(manifest, "gh-admin-msft").driftAudit.instructions = "Only the instructions string changed.";
    write(manifest);
    assert.deepEqual(await reconcileTwice("edit only an instructions string"), {
      created: [],
      changed: [`${W}/drift-gh-admin-msft.lock.yml`, `${W}/drift-gh-admin-msft.md`],
      removed: [],
    });
    const bodyAfter = parseWorkflow(workspace.read(`${W}/drift-gh-admin-msft.md`));
    assert.equal(bodyAfter.frontmatterText, bodyBefore.frontmatterText, "only the Markdown body changed");
    assert.notEqual(bodyAfter.body, bodyBefore.body);
    assert.ok(bodyAfter.body.includes("Only the instructions string changed."));

    manifest.projects.push(NEW_PROJECT);
    manifest.dependencyEdges.push(newEdge());
    write(manifest);
    assert.deepEqual(await reconcileTwice("add a project and an edge"), {
      created: [`${W}/cascade-mechanical-docs-sync.lock.yml`, `${W}/cascade-mechanical-docs-sync.md`, `${W}/drift-docs-site.lock.yml`, `${W}/drift-docs-site.md`],
      changed: [`${W}/cascade-router.yml`],
      removed: [],
    });

    manifest.dependencyEdges.pop();
    write(manifest);
    assert.deepEqual(await reconcileTwice("remove the edge"), {
      created: [],
      changed: [`${W}/cascade-router.yml`],
      removed: [`${W}/cascade-mechanical-docs-sync.lock.yml`, `${W}/cascade-mechanical-docs-sync.md`],
    });
  } finally {
    workspace.cleanup();
  }
});

test("AC57: a change to protectedFilesExclude updates aw.json and every handler that depends on it in the same run", async () => {
  const workspace = createWorkspace();
  try {
    assert.equal((await workspace.reconcile(request)).status, "ok");
    const before = listing(workspace);
    const manifest = presetManifest();
    manifest.protectedFilesExclude = ["CHANGELOG.md"];
    workspace.write("sdlc.yaml", toYaml(manifest));
    assert.equal((await workspace.reconcile(request)).status, "ok");
    const delta = changes(before, listing(workspace));
    assert.ok(delta.changed.includes(`${W}/aw.json`));
    assert.ok(delta.changed.includes(`${W}/drift-gh-admin-msft.md`));
    assert.ok(delta.changed.includes(`${W}/sdlc-onboard.md`));
    assert.equal(delta.changed.includes(`${W}/cascade-router.yml`), false, "the router is unaffected");
    assert.deepEqual(delta.created, []);
    assert.deepEqual(delta.removed, []);
  } finally {
    workspace.cleanup();
  }
});

test("AC57: sources that match a managed pattern but are no longer rendered are removed; other workflows are left alone", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write(`${W}/drift-obsolete.md`, "---\non: workflow_dispatch\n---\n\n# obsolete\n");
    workspace.write(`${W}/drift-obsolete.lock.yml`, "# lock of an obsolete workflow\n");
    workspace.write(`${W}/cascade-mechanical-old.md`, "---\non: workflow_dispatch\n---\n\n# old\n");
    workspace.write(`${W}/cascade-ai-old.md`, "---\non: workflow_dispatch\n---\n\n# old\n");
    workspace.write(`${W}/cascade-router.yml`, "name: stale router\n");
    workspace.write(`${W}/ci.yml`, "name: operator workflow\non: push\n");
    workspace.write(`${W}/notes.md`, "---\non: workflow_dispatch\n---\n\n# a hand-written workflow\n");
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    for (const gone of ["drift-obsolete.md", "drift-obsolete.lock.yml", "cascade-mechanical-old.md", "cascade-ai-old.md"]) {
      assert.equal(workspace.exists(`${W}/${gone}`), false, gone);
    }
    assert.equal(workspace.read(`${W}/ci.yml`), "name: operator workflow\non: push\n");
    assert.ok(workspace.exists(`${W}/notes.md`), "a workflow that is not a managed name stays");
    assert.ok(workspace.read(`${W}/cascade-router.yml`).includes("SDLC cascade router"), "the router is rewritten");
  } finally {
    workspace.cleanup();
  }
});

test("AC57: when the manifest no longer has any edge the stale router is removed", async () => {
  const workspace = createWorkspace();
  try {
    assert.equal((await workspace.reconcile(request)).status, "ok");
    assert.ok(workspace.exists(`${W}/cascade-router.yml`));
    const manifest = presetManifest();
    manifest.dependencyEdges = [];
    workspace.write("sdlc.yaml", toYaml(manifest));
    assert.equal((await workspace.reconcile(request)).status, "ok");
    assert.equal(workspace.exists(`${W}/cascade-router.yml`), false);
    assert.equal(workspace.list(W).some((file) => /cascade-(mechanical|ai)-/.test(file)), false);
  } finally {
    workspace.cleanup();
  }
});

test("AC57: the compiler is always run — no freshness decision is made from lock files", async () => {
  const workspace = createWorkspace();
  try {
    for (let run = 1; run <= 3; run += 1) {
      assert.equal((await workspace.reconcile(request)).status, "ok");
      assert.equal(workspace.shims.compileCalls().length, run);
    }
  } finally {
    workspace.cleanup();
  }
});
