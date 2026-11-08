// AC8 and AC9: both entry points accept exactly the invocations of contract C10. Every flag is optional where the
// contract says so, every enum is closed, and an unknown flag (so that no secret can be passed on the command line)
// exits non-zero before any network call or any file access to the target.
import assert from "node:assert/strict";
import test from "node:test";
import { ENGINES, MODES, STRATEGIES, parseBootstrapArgs, parseOnboardArgs } from "../../bin/lib/cli-flags.mjs";
import { createScenario } from "./helpers/harness.mjs";

test("AC8: every documented flag parses to the expected options object", () => {
  assert.deepEqual(parseBootstrapArgs([]), {
    manifest: "sdlc.yaml",
    owner: undefined,
    appName: undefined,
    engine: "copilot",
    deconflictUpstreamSchedules: false,
    nonInteractive: false,
  });
  assert.deepEqual(
    parseBootstrapArgs(["--manifest", "fleet/sdlc.yaml", "--owner", "acme", "--app-name", "Acme SDLC", "--engine", "claude", "--deconflict-upstream-schedules", "--non-interactive"]),
    { manifest: "fleet/sdlc.yaml", owner: "acme", appName: "Acme SDLC", engine: "claude", deconflictUpstreamSchedules: true, nonInteractive: true },
  );
  assert.equal(parseBootstrapArgs(["--manifest=other.yaml"]).manifest, "other.yaml", "the --flag=value form works");
});

test("AC8: the engine enum has exactly the five members and defaults to copilot", () => {
  assert.deepEqual([...ENGINES], ["copilot", "claude", "codex", "gemini", "pi"]);
  for (const engine of ENGINES) assert.equal(parseBootstrapArgs(["--engine", engine]).engine, engine);
  assert.equal(parseBootstrapArgs([]).engine, "copilot");
});

test("AC8: --app-name accepts 34 characters and rejects 35, counted in characters", () => {
  assert.equal(parseBootstrapArgs(["--app-name", "a".repeat(34)]).appName.length, 34);
  assert.throws(() => parseBootstrapArgs(["--app-name", "a".repeat(35)]), /35 characters long; GitHub accepts at most 34/);
  assert.equal(parseBootstrapArgs(["--app-name", "é".repeat(34)]).appName.length, 34);
});

test("AC8: the flags that explicitly appeared are recorded without becoming part of the options object", () => {
  const options = parseBootstrapArgs(["--engine", "codex"]);
  assert.deepEqual([...options.explicit], ["engine"]);
  assert.equal(Object.keys(options).includes("explicit"), false);
});

for (const argv of [
  ["--engine", "agy"],
  ["--engine", "foo"],
  ["--bogus"],
  ["--token", "abc"],
  ["--app-name", "x".repeat(35)],
  ["--engine"],
  ["--engine", "claude", "--engine", "codex"],
  ["--owner", ""],
  ["--non-interactive=yes"],
  ["positional"],
  ["--help"],
]) {
  test(`AC8: bootstrap ${JSON.stringify(argv)} exits non-zero with zero recorded network calls`, async () => {
    const scenario = await createScenario();
    try {
      const run = await scenario.bootstrap(argv, { env: scenario.env(scenario.appCredentials()) });
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /usage: node bin\/sdlc-bootstrap\.mjs|--[a-z-]+/);
      assert.deepEqual(scenario.fake.log, []);
      assert.equal(run.stdout, "");
      assert.equal(scenario.reconcile.calls.length, 0);
    } finally {
      await scenario.cleanup();
    }
  });
}

test("AC8: --engine gemini prints the deprecation warning on stderr and continues", async () => {
  const scenario = await createScenario();
  try {
    const run = await scenario.bootstrap(["--engine", "gemini", "--non-interactive"]);
    assert.match(run.stderr, /warning: gh-aw labels the gemini engine as deprecated/);
    assert.equal(run.stdout, "");
  } finally {
    await scenario.cleanup();
  }
});

test("AC8: a token passed as a flag is refused without echoing the value", async () => {
  const scenario = await createScenario();
  try {
    for (const argv of [["--token", "ghp_supersecretvalue1234567890"], ["--token=ghp_supersecretvalue1234567890"], ["--private-key", "-----BEGIN RSA PRIVATE KEY-----"]]) {
      const run = await scenario.bootstrap(argv);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /Unknown option/);
      assert.equal(run.stderr.includes("ghp_supersecretvalue1234567890"), false);
      assert.equal(run.stderr.includes("BEGIN RSA"), false);
    }
  } finally {
    await scenario.cleanup();
  }
});

const FULL_ONBOARD = [
  "--downstream",
  "example-owner/hub",
  "--strategy",
  "content-and-docs-sync",
  "--watch-url",
  "https://example.com/changelog",
  "--watch-url",
  "https://example.com/blog/feed.xml",
  "--schedule",
  "0 5 * * 0",
  "--mode",
  "mechanical",
  "--instructions",
  "Keep docs current",
  "--manifest",
  "fleet.yaml",
];

test("AC9: a full invocation parses to the same options in the --repo form and in the positional form", () => {
  const named = parseOnboardArgs(["--repo", "example-owner/app", ...FULL_ONBOARD]);
  const positional = parseOnboardArgs(["example-owner/app", ...FULL_ONBOARD]);
  assert.deepEqual(named, positional);
  assert.deepEqual(named, {
    repo: "example-owner/app",
    downstream: "example-owner/hub",
    strategy: "content-and-docs-sync",
    watchUrl: [
      { url: "https://example.com/changelog", label: "example.com/changelog", kind: "changelog" },
      { url: "https://example.com/blog/feed.xml", label: "example.com/blog/feed.xml", kind: "blog" },
    ],
    schedule: "0 5 * * 0",
    mode: "mechanical",
    instructions: "Keep docs current",
    manifest: "fleet.yaml",
  });
});

test("AC9: the defaults are strategy auto, mode auto and manifest sdlc.yaml, and --watch-url is repeatable", () => {
  assert.deepEqual(parseOnboardArgs(["--repo", "some/where"]), {
    repo: "some/where",
    downstream: undefined,
    strategy: "auto",
    watchUrl: [],
    schedule: undefined,
    mode: "auto",
    instructions: undefined,
    manifest: "sdlc.yaml",
  });
  assert.equal(parseOnboardArgs(["--repo", "a/b", "--watch-url", "https://a.example/x", "--watch-url", "https://b.example/y"]).watchUrl.length, 2);
  assert.equal(parseOnboardArgs(["--repo", "a/b", "--watch-url", "https://a.example/x", "--watch-url", "https://a.example/x"]).watchUrl.length, 1, "a repeated URL is kept once");
});

test("AC9: the strategy and mode enums have exactly the members of the contract", () => {
  assert.deepEqual([...STRATEGIES], ["auto", "content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan", "custom"]);
  assert.deepEqual([...MODES], ["auto", "mechanical", "ai-adaptation"]);
  for (const strategy of STRATEGIES) assert.equal(parseOnboardArgs(["--repo", "a/b", "--strategy", strategy]).strategy, strategy);
  for (const mode of MODES) assert.equal(parseOnboardArgs(["--repo", "a/b", "--downstream", "a/c", "--mode", mode]).mode, mode);
});

test("AC9: the repository may be a local path", () => {
  assert.equal(parseOnboardArgs(["--repo", "./some/dir"]).repo, "./some/dir");
  assert.equal(parseOnboardArgs(["C:\\work\\repo"]).repo, "C:\\work\\repo");
});

const INVALID_ONBOARD = [
  [[], /the repository is required/],
  [["--downstream", "a/b"], /the repository is required/],
  [["--repo", "a/b", "c/d"], /either as --repo or as one positional/],
  [["a/b", "c/d"], /only one positional/],
  [["--repo", "a/b", "--strategy", "everything"], /--strategy 'everything' is not one of/],
  [["--repo", "a/b", "--downstream", "a/c", "--mode", "magic"], /--mode 'magic' is not one of/],
  [["--repo", "a/b", "--mode", "mechanical"], /--mode mechanical needs --downstream/],
  [["--repo", "a/b", "--mode", "ai-adaptation"], /--mode ai-adaptation needs --downstream/],
  [["--repo", "a/b", "--bogus"], /Unknown option '--bogus'/],
  [["--repo", "a/b", "--token", "abc"], /Unknown option '--token'/],
  [["--repo", "a/b", "--schedule", "every day"], /not a five-field cron expression/],
  [["--repo", "a/b", "--schedule", "0 5 * *"], /not a five-field cron expression/],
  [["--repo", "a/b", "--schedule", "61 5 * * 0"], /not a five-field cron expression/],
  [["--repo", "a/b", "--downstream", "not-a-repo"], /not an <owner\/repo> repository/],
  [["--repo", "a/b", "--watch-url", "http://example.com"], /not an https URL/],
  [["--repo", "a/b", "--watch-url", "https://*.example.com"], /exact hostname without a wildcard/],
  [["--repo", "a/b", "--watch-url", "https://user:pw@example.com"], /embeds credentials/],
  [["--repo", "a/b", "--watch-url", "https://127.0.0.1/x"], /IP literal/],
  [["--repo", "a/b", "--watch-url", "https://[::1]/x"], /IP literal/],
  [["--repo", "a/b", "--strategy", "auto", "--strategy", "custom"], /more than once/],
  [["--repo", ""], /must not be empty|repository is required/],
];

for (const [argv, expected] of INVALID_ONBOARD) {
  test(`AC9: onboard ${JSON.stringify(argv)} is rejected by the parser`, () => {
    assert.throws(() => parseOnboardArgs(argv), expected);
  });
}

test("AC9: each invalid onboard invocation exits non-zero before any file or network access", async () => {
  const scenario = await createScenario();
  try {
    for (const [argv] of INVALID_ONBOARD) {
      const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()) });
      assert.notEqual(run.code, 0, JSON.stringify(argv));
      assert.deepEqual(scenario.fake.log, [], `${JSON.stringify(argv)}: zero network calls`);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /usage: node bin\/sdlc-onboard\.mjs/, `${JSON.stringify(argv)}: the failure is a usage error, so the target was never read`);
    }
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.equal(scenario.workspace.read("sdlc.yaml").includes("onboard"), false);
  } finally {
    await scenario.cleanup();
  }
});

test("AC9: the --instructions value is not read while the flags are parsed", () => {
  const options = parseOnboardArgs(["--repo", "a/b", "--instructions", "does-not-exist-anywhere.md"]);
  assert.equal(options.instructions, "does-not-exist-anywhere.md");
});
