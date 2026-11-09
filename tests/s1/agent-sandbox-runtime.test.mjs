// Execute the new pre-agent install against a real, local npm dependency, not an npm double.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { minimalManifest, parseWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

test("the opt-in pre-agent step installs the target's dependencies without lifecycle scripts, repeats cleanly, and propagates an unusable lockfile", () => {
  const manifest = minimalManifest();
  // The repository name, not the unrelated project key, determines the checkout directory.
  manifest.projects[0].repo = "acme-labs/audit-target";
  manifest.projects[0].driftAudit.agentSandbox = { installDependencies: true };
  manifest.dependencyEdges[0].upstreamRepo = manifest.projects[0].repo;
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const target = {
      name: "sandbox-install-fixture", version: "1.0.0", private: true,
      dependencies: { "fixture-dependency": "file:./fixture-dependency" },
      scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'unsafe\')"' },
    };
    workspace.write("audit-target/package.json", JSON.stringify(target));
    workspace.write("audit-target/fixture-dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.cjs" }));
    workspace.write("audit-target/fixture-dependency/index.cjs", 'module.exports = "sandbox-ready";\n');
    const env = {
      ...process.env, npm_config_cache: path.join(workspace.root, "npm-cache"),
      npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
    };
    const execute = (command, cwd) => spawnSync(command, { cwd, env, shell: true, encoding: "utf8", timeout: 60_000 });
    const checkout = workspace.path("audit-target");
    // Let npm itself construct its lockfile contract. No package registry or external service is needed.
    const locked = execute("npm install --package-lock-only --ignore-scripts", checkout);
    assert.equal(locked.status, 0, `${locked.error ?? ""}\n${locked.stderr}`);
    assert.equal(fs.existsSync(path.join(checkout, "node_modules", "fixture-dependency")), false);

    const result = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const step = parseWorkflow(result.files.get(".github/workflows/drift-alpha-service.md")).frontmatter["pre-agent-steps"].at(-1);
    assert.equal(step.name, "Install target checkout dependencies for in-sandbox validation");
    assert.equal(step["working-directory"], "audit-target");
    assert.equal("continue-on-error" in step, false);
    assert.equal("if" in step, false);
    for (let run = 0; run < 2; run++) {
      const installed = execute(step.run, workspace.path(step["working-directory"]));
      assert.equal(installed.status, 0, `${installed.error ?? ""}\n${installed.stderr}`);
      const consumer = spawnSync(process.execPath, ["-e", "process.stdout.write(require('fixture-dependency'))"], { cwd: checkout, env, encoding: "utf8" });
      assert.equal(consumer.status, 0, consumer.stderr);
      assert.equal(consumer.stdout, "sandbox-ready");
      assert.equal(fs.existsSync(path.join(checkout, "lifecycle-ran")), false, "target lifecycle scripts must not run outside the sandbox");
      assert.equal(fs.existsSync(workspace.path("node_modules")), false, "the install must not run in the orchestrator checkout");
    }

    // An operator can omit or corrupt a lockfile; the pre-agent step must fail, not silently continue to the agent.
    workspace.write("audit-target/package-lock.json", "{ not valid JSON\n");
    const refused = execute(step.run, checkout);
    assert.equal(typeof refused.status, "number", `${refused.error ?? ""}`);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.signal, null, "this is an npm refusal, not a timeout");
    assert.equal(fs.existsSync(path.join(checkout, "lifecycle-ran")), false);
  } finally {
    workspace.cleanup();
  }
});
