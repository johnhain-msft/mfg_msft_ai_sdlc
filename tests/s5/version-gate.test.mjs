// AC6 and AC7: both entry points verify that the local gh-aw is >= 1.0.1 before anything else, by a numeric semantic-version
// comparison, and the accepted version (without a leading "v") is what S5 later sends as ghAwVersionPin.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertGhAwVersion, compareVersions, isAcceptableVersion, parseVersion } from "../../bin/lib/ghaw-version.mjs";
import { LOCAL_GH_AW_DATA_HOME, createGhRunner, ghEnvironment } from "../../bin/lib/gh-runner.mjs";
import { buildReconcileRequest } from "../../bin/lib/reconcile-client.mjs";
import { createScenario, runCli } from "./helpers/harness.mjs";
import { installFakeGh } from "./helpers/fake-gh.mjs";

const REJECTED = [
  ["1.0.0", "gh aw version v1.0.0"],
  ["0.86.2", "gh aw version v0.86.2"],
  ["0.85.4", "gh aw version v0.85.4"],
  ["an empty string", ""],
  ["not-a-version", "not-a-version"],
];

for (const [label, output] of REJECTED) {
  for (const entry of ["bootstrap", "onboard"]) {
    test(`AC6: ${entry} with a gh-aw reporting ${label} exits non-zero before any request, file write or listener`, async () => {
      const scenario = await createScenario({ gh: { versionOutput: output } });
      try {
        const argv = entry === "bootstrap" ? [] : ["--repo", "example-owner/some-repo"];
        const before = scenario.workspace.status();
        const run = await runCli(entry, argv, { env: scenario.env(scenario.appCredentials()), cwd: scenario.workspace.dir });
        assert.notEqual(run.code, 0);
        assert.match(run.stderr, /GHSA-8h78-hpm7-29gg/);
        assert.match(run.stderr, />= 1\.0\.1/);
        assert.match(run.stderr, /gh aw upgrade/);
        assert.match(run.stderr, /Detected version: /);
        assert.equal(run.stdout, "");
        assert.deepEqual(scenario.fake.log, [], "zero network calls");
        assert.deepEqual(run.trace.filter((event) => event.type === "write"), [], "zero file writes");
        assert.deepEqual(run.trace.filter((event) => event.type === "listen"), [], "zero listener binds");
        assert.equal(scenario.workspace.status(), before, "the working copy is untouched");
        assert.equal(scenario.gh.calls("aw", "version").length >= 1, true, "the version was read through gh aw version");
      } finally {
        await scenario.cleanup();
      }
    });
  }
}

test("AC6: the remediation names the install and upgrade commands and the lock files", async () => {
  const scenario = await createScenario({ gh: { version: "0.86.2" } });
  try {
    const run = await scenario.bootstrap([]);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /gh extension install github\/gh-aw/);
    assert.match(run.stderr, /commit the regenerated \.lock\.yml files/);
    assert.match(run.stderr, /does not replace the SHA-pinned action references/);
    assert.match(run.stderr, /Detected version: 0\.86\.2/);
  } finally {
    await scenario.cleanup();
  }
});

test("AC6: a gh that cannot be found fails closed, naming the advisory", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap([], { env: { ...scenario.env(), PATH: "", Path: "" } });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /GHSA-8h78-hpm7-29gg/);
    assert.match(run.stderr, /unreadable/);
    assert.deepEqual(scenario.fake.log, []);
  } finally {
    await scenario.cleanup();
  }
});

test("AC6: the gate runs before the flags are parsed, so no argument can skip it", async () => {
  const scenario = await createScenario({ gh: { version: "1.0.0" } });
  try {
    for (const entry of ["bootstrap", "onboard"]) {
      const run = await scenario[entry](["--bogus"]);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /GHSA-8h78-hpm7-29gg/, entry);
    }
  } finally {
    await scenario.cleanup();
  }
});

test("AC6: the version command is recorded as gh aw version, and gh aw --version is the fallback", async () => {
  const scenario = await createScenario();
  try {
    const runner = createGhRunner({ env: scenario.env() });
    assert.equal(await assertGhAwVersion(runner), "1.0.1");
    assert.deepEqual(scenario.gh.log().map((entry) => entry.args), [["aw", "version"]]);
    scenario.gh.reset();
    // a CLI that rejects the subcommand but reports through the flag
    const calls = [];
    const flagOnly = async (args) => {
      calls.push(args.join(" "));
      return args.includes("--version") ? { code: 0, stdout: "gh aw version v1.2.0\n", stderr: "" } : { code: 1, stdout: "", stderr: "unknown command" };
    };
    assert.equal(await assertGhAwVersion(flagOnly), "1.2.0");
    assert.deepEqual(calls, ["aw version", "aw --version"]);
  } finally {
    await scenario.cleanup();
  }
});

const CASES = [
  ["1.0.0", false],
  ["v1.0.0", false],
  ["0.86.2", false],
  ["0.85.4", false],
  ["1.0.1-rc.1", false],
  ["v1.0.1-rc.1", false],
  ["1.0.1", true],
  ["v1.0.1", true],
  ["1.0.2", true],
  ["v1.0.2", true],
  ["1.0.10", true],
  ["1.1.0", true],
  ["2.0.0", true],
  ["10.0.0", true],
  ["", false],
  ["not-a-version", false],
  ["gh aw version v1.0.1", true],
  ["gh aw version v0.86.2", false],
];

for (const [text, accepted] of CASES) {
  test(`AC7: ${JSON.stringify(text)} is ${accepted ? "accepted" : "rejected"}`, () => {
    assert.equal(isAcceptableVersion(text), accepted);
  });
}

test("AC7: the comparison is numeric, ignores a leading v and orders a pre-release below its release", () => {
  const v = (text) => parseVersion(text);
  assert.equal(compareVersions(v("1.0.10"), v("1.0.9")), 1);
  assert.equal(compareVersions(v("v1.0.1"), v("1.0.1")), 0);
  assert.equal(compareVersions(v("1.0.1-rc.1"), v("1.0.1")), -1);
  assert.equal(compareVersions(v("1.0.1-rc.2"), v("1.0.1-rc.10")), -1, "numeric pre-release identifiers compare numerically");
  assert.equal(compareVersions(v("1.0.1-alpha"), v("1.0.1-1")), 1, "alphanumeric identifiers rank above numeric ones");
  assert.equal(compareVersions(v("1.0.1-rc"), v("1.0.1-rc.1")), -1, "a shorter pre-release ranks lower");
  assert.equal(compareVersions(v("2.0.0"), v("1.99.99")), 1);
  assert.equal(compareVersions(v("1.0.1+build.5"), v("1.0.1")), 0, "build metadata is ignored");
});

test("AC7: a passing v1.0.2 yields ghAwVersionPin 1.0.2, in the request builder and in the request each entry point sends", async () => {
  assert.equal(
    buildReconcileRequest({ manifestPath: "sdlc.yaml", appSlug: "x", engineAuthMode: "copilot-requests", ghAwVersionPin: "1.0.2" }).ghAwVersionPin,
    "1.0.2",
  );
  const scenario = await createScenario({ gh: { version: "1.0.2", versionOutput: "gh aw version v1.0.2" } });
  try {
    const run = await scenario.bootstrap([], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(scenario.reconcile.calls[0].request.ghAwVersionPin, "1.0.2");
  } finally {
    await scenario.cleanup();
  }
});

test("AC6: GH_AW_BIN replaces gh for the version check and still fails closed for an old binary", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-awbin-"));
  try {
    const stand = installFakeGh(directory, { version: "1.0.0" });
    const executable = path.join(stand.directory, process.platform === "win32" ? "gh.cmd" : "gh");
    const runner = createGhRunner({ env: { ...process.env, GH_AW_BIN: executable, SDLC_FAKE_GH_CONFIG: stand.env().SDLC_FAKE_GH_CONFIG } });
    await assert.rejects(assertGhAwVersion(runner), /GHSA-8h78-hpm7-29gg[\s\S]*Detected version: 1\.0\.0/);
    assert.deepEqual(stand.log().map((entry) => entry.args), [["aw", "version"]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC6: a GH_AW_BIN named gh-aw is the extension binary itself and receives the subcommand without the leading aw", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-awbin-"));
  try {
    const stand = installFakeGh(directory, { version: "1.0.1" });
    const launcher = path.join(stand.directory, process.platform === "win32" ? "gh.cmd" : "gh");
    const direct = path.join(stand.directory, process.platform === "win32" ? "gh-aw.cmd" : "gh-aw");
    fs.copyFileSync(launcher, direct);
    if (process.platform !== "win32") fs.chmodSync(direct, 0o755);
    const runner = createGhRunner({ env: { ...process.env, GH_AW_BIN: direct, SDLC_FAKE_GH_CONFIG: stand.env().SDLC_FAKE_GH_CONFIG } });
    await runner(["aw", "version"]);
    assert.deepEqual(stand.log().map((entry) => entry.args), [["version"]]);
    // other gh commands never use GH_AW_BIN
    stand.reset();
    await runner(["auth", "token"]).catch(() => {});
    assert.deepEqual(stand.log().filter((entry) => entry.args[0] === "version"), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("XDG_DATA_HOME defaults to the isolated gh-aw v1.0.1 installation only when it is unset and the directory exists", () => {
  assert.equal(ghEnvironment({}, () => true).XDG_DATA_HOME, LOCAL_GH_AW_DATA_HOME);
  assert.equal(ghEnvironment({}, () => false).XDG_DATA_HOME, undefined);
  assert.equal(ghEnvironment({ XDG_DATA_HOME: "C:\\elsewhere" }, () => true).XDG_DATA_HOME, "C:\\elsewhere");
  assert.equal(ghEnvironment({ PATH: "x" }, () => true).PATH, "x", "the rest of the environment is kept");
});
