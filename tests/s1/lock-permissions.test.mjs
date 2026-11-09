// The compiler adds `permission-checks: read` to the token step of the safe-outputs job. The App holds six permissions and no Checks permission, so a token
// that asks for it cannot be minted: after every compile the reconciler removes the line from the lock of each workflow that it generated.
import assert from "node:assert/strict";
import test from "node:test";
import { referenceRequest } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();
const W = ".github/workflows";
const STEP = [
  "      - name: Generate GitHub App token",
  "        id: safe-outputs-app-token",
  "        uses: actions/create-github-app-token@v3",
  "        with:",
  "          client-id: ${{ vars.APP_CLIENT_ID }}",
  "          private-key: ${{ secrets.APP_PRIVATE_KEY }}",
  "          permission-checks: read",
  "          permission-contents: write",
  "          permission-issues: write",
  "          permission-pull-requests: write",
  "      - name: Download agent output artifact",
];
const lock = (lines, eol = "\n") => `# compiled by the stub\n${lines.join(eol)}${eol}`;
const WITHOUT = STEP.filter((line) => !line.includes("permission-checks"));

test("the lock of every generated workflow loses its permission-checks: read line and keeps every other line, in order", async () => {
  const workspace = createWorkspace({ compile: { mode: "ok", lockContent: lock(STEP) } });
  try {
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.generatedWorkflows.length, 9);
    for (const pair of result.generatedWorkflows) {
      const text = workspace.read(pair.lockYml);
      assert.equal(text.includes("permission-checks"), false, `${pair.lockYml} still asks for the Checks permission`);
      assert.equal(text, lock(WITHOUT), `${pair.lockYml}: only the one line is removed`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("a lock that the compiler wrote with CRLF line endings loses the line as well, and a lock without the line is not rewritten", async () => {
  const workspace = createWorkspace({ compile: { mode: "ok", lockContent: lock(STEP, "\r\n") } });
  try {
    assert.equal((await workspace.reconcile(request)).status, "ok");
    for (const file of workspace.list(W).filter((name) => name.endsWith(".lock.yml"))) assert.equal(workspace.read(file), lock(WITHOUT, "\r\n"), file);
    const clean = lock(WITHOUT);
    workspace.shims.compile({ mode: "ok", lockContent: clean });
    assert.equal((await workspace.reconcile(request)).status, "ok");
    for (const file of workspace.list(W).filter((name) => name.endsWith(".lock.yml"))) assert.equal(workspace.read(file), clean, file);
  } finally {
    workspace.cleanup();
  }
});

test("a second run changes nothing, and the lock of a workflow that is not a generated one is left as the compiler wrote it", async () => {
  const workspace = createWorkspace({ compile: { mode: "ok", lockContent: lock(STEP) } });
  try {
    workspace.write(`${W}/notes.md`, "---\non: workflow_dispatch\n---\n\n# a hand-written workflow\n");
    assert.equal((await workspace.reconcile(request)).status, "ok");
    const settled = workspace.hash();
    assert.equal((await workspace.reconcile(request)).status, "ok");
    assert.equal(workspace.hash(), settled, "the second run is byte-identical");
    assert.equal(workspace.read(`${W}/notes.lock.yml`), lock(STEP), "not a managed workflow: the reconciler does not edit its lock");
    assert.equal(workspace.read(`${W}/drift-gh-admin-msft.lock.yml`), lock(WITHOUT));
  } finally {
    workspace.cleanup();
  }
});

test("a failed compile restores the workflows and leaves no lock to strip", async () => {
  const workspace = createWorkspace({ compile: { mode: "crash" } });
  try {
    const before = workspace.hash();
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "error");
    assert.equal(workspace.hash(), before);
  } finally {
    workspace.cleanup();
  }
});
