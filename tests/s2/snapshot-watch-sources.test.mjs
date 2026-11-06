// AC11 and AC12: the watchUrls and packageManifests snapshots under <out>/sources/ (contract C5, request).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { run } from "../../src/snapshot-watch-sources.mjs";
import { AUDIT_SECTIONS, SELF_IMPROVEMENT_SECTIONS } from "../../src/validate-copilot-lab-audit.mjs";
import { parseManifestFile } from "../../src/drift/lib/dependencies.mjs";
import { globToRegExp, listFiles, matchesGlob } from "../../src/drift/lib/glob.mjs";
import { readProjectSources } from "../../src/drift/lib/manifest.mjs";
import { parseYamlSubset, YamlSubsetError } from "../../src/drift/lib/yaml-subset.mjs";
import { loadYaml } from "../../src/drift/lib/yaml-load.mjs";
import { abs, DRIFT_KEYS, driftWorkflow, hashTree, listTree, readText, REPO_ROOT, script, tempDir } from "./helpers/fixtures.mjs";
import { createSnapshotWorkspace, invoke } from "./helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, hangUntilAbort, runNode, startStubServer } from "./helpers/stub-server.mjs";

const ORIGIN = "https://changelog.example.test";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** The three pages of the fixture manifest: a 200, a 404 and a response that never comes. */
const pages = (extra = {}) =>
  createFakeFetch((entry) => {
    if (extra[entry.path]) return extra[entry.path](entry);
    if (entry.path === "/changelog") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>Release 18.0.0</body></html>" };
    if (entry.path === "/missing") return { status: 404, body: "not found" };
    return hangUntilAbort(entry);
  });

const snapshotArgs = (workspace, extra = []) => ["--out", workspace.out, "--project", "snapshot-fixture", "--manifest", workspace.manifest, "--checkout", workspace.checkout, "--timeout-ms", "150", ...extra];
const manifestOf = (workspace) => JSON.parse(fs.readFileSync(path.join(workspace.out, "sources", "manifest.json"), "utf8"));

test("AC11: a 200, a 404 and a slow response give three manifest records (two failed) and one snapshot file", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const result = await invoke(run, snapshotArgs(workspace), { fetch: pages() });
    assert.equal(result.code, 0, result.stderr);
    const manifest = manifestOf(workspace);
    assert.equal(manifest.watchUrls.length, 3);
    assert.deepEqual(manifest.watchUrls.map((record) => record.state), ["ok", "failed", "failed"], "ordered by url: changelog, missing, slow");
    const [ok, missing, slow] = manifest.watchUrls;
    assert.deepEqual({ url: ok.url, label: ok.label, kind: ok.kind, status: ok.status }, { url: `${ORIGIN}/changelog`, label: "Example changelog", kind: "changelog", status: 200 });
    assert.deepEqual({ url: missing.url, label: missing.label, kind: missing.kind, status: missing.status, snapshot: missing.snapshot }, { url: `${ORIGIN}/missing`, label: "Missing page", kind: "docs", status: 404, snapshot: null });
    assert.equal(missing.error, "HTTP 404");
    assert.deepEqual({ url: slow.url, kind: slow.kind, status: slow.status, snapshot: slow.snapshot }, { url: `${ORIGIN}/slow`, kind: "blog", status: null, snapshot: null });
    assert.match(slow.error, /timed out after 150 ms/);
    // exactly one snapshot file for the 200, under sources/, with the bytes of the response
    const files = listTree(workspace.out).filter((file) => !file.startsWith("sources/manifests/") && file !== "sources/manifest.json");
    assert.deepEqual(files, [ok.snapshot]);
    assert.match(ok.snapshot, /^sources\/changelog\.example\.test-[0-9a-f]{12}\.html$/);
    assert.equal(fs.readFileSync(path.join(workspace.out, ...ok.snapshot.split("/")), "utf8"), "<html><body>Release 18.0.0</body></html>");
    assert.equal(ok.sha256, sha256("<html><body>Release 18.0.0</body></html>"));
    assert.equal(ok.bytes, Buffer.byteLength("<html><body>Release 18.0.0</body></html>"));
    // failed entries are carried as limitations: never dropped, never guessed
    assert.ok(manifest.limitations.includes(`${ORIGIN}/missing: HTTP 404`));
    assert.ok(manifest.limitations.some((line) => line.startsWith(`${ORIGIN}/slow: timed out`)));
  } finally {
    workspace.cleanup();
  }
});

test("AC11: a second run on the same inputs writes byte-identical files", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    const first = hashTree(workspace.out);
    const mtimes = Object.fromEntries(listTree(workspace.out).map((file) => [file, fs.statSync(path.join(workspace.out, file)).mtimeMs]));
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    assert.equal(hashTree(workspace.out), first, "every output file is byte for byte the same");
    for (const file of listTree(workspace.out)) assert.equal(fs.statSync(path.join(workspace.out, file)).mtimeMs, mtimes[file], `${file} is not even rewritten`);
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:/.test(readText(path.join(workspace.out, "sources", "manifest.json"))), false, "the manifest holds no timestamp");
  } finally {
    workspace.cleanup();
  }
});

test("AC11: the command, run as a process against a stub server on 127.0.0.1, records the same three attempts, and a slow machine does not change them", async () => {
  // The page that answers is deliberately slower than the margin that this test used to give it (a 400 ms timeout, which a full parallel
  // run of the suite could exceed), the timeout is the generous default, and the response that never completes is a dropped connection:
  // nothing here depends on how long the machine takes, so the three records are the same on a loaded one.
  const server = await startStubServer((entry) => {
    if (entry.path === "/changelog") return { status: 200, headers: { "content-type": "text/html" }, body: "<p>served</p>", delayMs: 1200 };
    if (entry.path === "/missing") return { status: 404, body: "gone" };
    return { drop: true };
  });
  const workspace = createSnapshotWorkspace({ placeholders: { [ORIGIN]: server.url } });
  try {
    const env = cleanEnv({ GITHUB_WORKSPACE: workspace.workspace });
    const first = await runNode(script("snapshot-watch-sources.mjs"), ["--out", workspace.out, "--project", "snapshot-fixture", "--checkout", "checkout"], { env, cwd: workspace.workspace });
    assert.equal(first.code, 0, first.stderr);
    const overlapOfFirstRun = server.state.maxInflight;
    const manifest = manifestOf(workspace);
    assert.deepEqual(manifest.watchUrls.map((record) => [record.status, record.state]), [[200, "ok"], [404, "failed"], [null, "failed"]]);
    const hashes = hashTree(workspace.out);
    const second = await runNode(script("snapshot-watch-sources.mjs"), ["--out", workspace.out, "--project", "snapshot-fixture", "--checkout", "checkout"], { env, cwd: workspace.workspace });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(hashTree(workspace.out), hashes, "byte-identical output files on a second run");
    assert.deepEqual(server.requests.map((request) => request.method), Array(6).fill("GET"), "only GET requests, three per run");
    assert.equal(overlapOfFirstRun, 1, "the requests of a run were issued one after the other");
  } finally {
    workspace.cleanup();
    await server.close();
  }
});

test("AC11: the command, run as a process, records a response that never comes as failed with the timeout that it was given, whatever the load", async () => {
  // Every route hangs until the client gives up, so the outcome cannot depend on how quickly a loaded machine serves a page.
  const server = await startStubServer(() => new Promise(() => {}));
  const workspace = createSnapshotWorkspace({ placeholders: { [ORIGIN]: server.url } });
  try {
    const env = cleanEnv({ GITHUB_WORKSPACE: workspace.workspace });
    const result = await runNode(script("snapshot-watch-sources.mjs"), ["--out", workspace.out, "--project", "snapshot-fixture", "--checkout", "checkout", "--timeout-ms", "300"], { env, cwd: workspace.workspace });
    assert.equal(result.code, 0, result.stderr);
    const { watchUrls, limitations } = manifestOf(workspace);
    assert.deepEqual(watchUrls.map((record) => [record.status, record.state, record.snapshot]), Array(3).fill([null, "failed", null]));
    for (const record of watchUrls) assert.match(record.error, /^timed out after 300 ms$/, record.url);
    assert.equal(limitations.filter((line) => /timed out after 300 ms$/.test(line)).length, 3, "each is carried as a limitation");
    assert.equal(listTree(workspace.out).some((file) => file.startsWith("sources/") && !file.startsWith("sources/manifests/") && file !== "sources/manifest.json"), false, "and no snapshot file was written for any of them");
  } finally {
    workspace.cleanup();
    await server.close();
  }
});

test("AC12: package.json and a nested *.csproj are snapshotted with their dependency names and versions", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    const manifest = manifestOf(workspace);
    const byPattern = Object.fromEntries(manifest.packageManifests.map((record) => [record.pattern, record]));
    const packageJson = byPattern["package.json"];
    assert.equal(packageJson.state, "matched");
    assert.deepEqual(packageJson.files.map((file) => file.path), ["package.json"]);
    const [file] = packageJson.files;
    assert.equal(file.snapshot, "sources/manifests/package.json");
    assert.deepEqual(file.dependencies, [
      { name: "@angular/core", version: "^17.3.0", scope: "dependencies" },
      { name: "rxjs", version: "~7.8.0", scope: "dependencies" },
      { name: "typescript", version: "~5.4.2", scope: "devDependencies" },
    ]);
    assert.deepEqual(file.engines, { node: ">=20" });
    assert.equal(fs.readFileSync(path.join(workspace.out, "sources", "manifests", "package.json"), "utf8"), fs.readFileSync(path.join(workspace.checkout, "package.json"), "utf8"));
    const csproj = byPattern["**/*.csproj"];
    assert.deepEqual(csproj.files.map((entry) => entry.path), ["services/api/Api.csproj"]);
    assert.equal(csproj.files[0].snapshot, "sources/manifests/services/api/Api.csproj");
    assert.deepEqual(csproj.files[0].dependencies, [
      { name: "Newtonsoft.Json", version: "13.0.3", scope: "PackageReference" },
      { name: "Serilog.AspNetCore", version: "8.0.0", scope: "PackageReference" },
    ]);
    assert.deepEqual(csproj.files[0].frameworks, ["net8.0"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC12: a pattern that matches no file is listed in manifest.json, as a record and as a limitation, not ignored", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    const manifest = manifestOf(workspace);
    const unmatched = manifest.packageManifests.find((record) => record.pattern === "docs/**/package.json");
    assert.deepEqual(unmatched, { pattern: "docs/**/package.json", state: "unmatched", files: [] });
    assert.ok(manifest.limitations.includes("the package manifest pattern 'docs/**/package.json' matches no file in the target checkout"));
  } finally {
    workspace.cleanup();
  }
});

test("AC12: the checkout is left untouched, git status --porcelain stays empty", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    assert.equal(workspace.status(), "");
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    assert.equal(workspace.status(), "", "a run that finds no drift leaves nothing to commit");
  } finally {
    workspace.cleanup();
  }
});

test("AC12: a package.json under node_modules is not a match, and an unreadable or unknown manifest is recorded, not guessed", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    fs.mkdirSync(path.join(workspace.checkout, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(workspace.checkout, "node_modules", "dep", "package.json"), '{"dependencies":{"x":"1"}}');
    fs.mkdirSync(path.join(workspace.checkout, "docs", "broken"), { recursive: true });
    fs.writeFileSync(path.join(workspace.checkout, "docs", "broken", "package.json"), "{ not json");
    const manifestText = fs.readFileSync(workspace.manifest, "utf8").replace("- docs/**/package.json", "- docs/**/package.json\n          - README.md\n          - '**/package.json'");
    fs.writeFileSync(workspace.manifest, manifestText);
    assert.equal((await invoke(run, snapshotArgs(workspace), { fetch: pages() })).code, 0);
    const manifest = manifestOf(workspace);
    const all = manifest.packageManifests.find((record) => record.pattern === "**/package.json");
    assert.deepEqual(all.files.map((entry) => entry.path), ["docs/broken/package.json", "package.json"], "node_modules is never entered");
    const broken = all.files[0];
    assert.equal(broken.parser, "none");
    assert.equal(broken.dependencies, null);
    assert.match(broken.error, /could not parse package.json/);
    assert.ok(manifest.limitations.some((line) => line.startsWith("docs/broken/package.json: could not parse")));
    const readme = manifest.packageManifests.find((record) => record.pattern === "README.md").files[0];
    assert.deepEqual({ parser: readme.parser, dependencies: readme.dependencies }, { parser: "none", dependencies: null }, "a format without a parser has no dependency list");
  } finally {
    workspace.cleanup();
  }
});

test("AC11: bodies are saved as received, by content type; an empty, oversized or unreachable response is a failed entry", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const manifestText = fs
      .readFileSync(workspace.manifest, "utf8")
      .replace("https://changelog.example.test/slow", "https://changelog.example.test/feed")
      .replace("        packageManifests:", "          - url: https://changelog.example.test/empty\n            label: Empty\n            kind: docs\n          - url: https://changelog.example.test/huge\n            label: Huge\n            kind: docs\n          - url: https://changelog.example.test/down\n            label: Down\n            kind: docs\n          - url: https://changelog.example.test/moved\n            label: Moved\n            kind: docs\n        packageManifests:");
    fs.writeFileSync(workspace.manifest, manifestText);
    const fakeFetch = createFakeFetch((entry) => {
      switch (entry.path) {
        case "/changelog":
          return { status: 200, headers: { "content-type": "application/json" }, body: '{"v":1}' };
        case "/feed":
          return { status: 200, headers: { "content-type": "application/atom+xml" }, body: "<feed/>" };
        case "/empty":
          return { status: 200, headers: { "content-type": "text/plain" }, body: "" };
        case "/huge":
          return { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(2048) };
        case "/moved":
          return { status: 200, headers: { "content-type": "text/markdown" }, body: "# moved" };
        case "/down":
          throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
        default:
          return { status: 404 };
      }
    });
    const result = await invoke(run, snapshotArgs(workspace, ["--max-bytes", "1024"]), { fetch: fakeFetch });
    assert.equal(result.code, 0, result.stderr);
    const records = Object.fromEntries(manifestOf(workspace).watchUrls.map((record) => [new URL(record.url).pathname, record]));
    assert.match(records["/changelog"].snapshot, /\.json$/);
    assert.match(records["/feed"].snapshot, /\.xml$/);
    assert.match(records["/moved"].snapshot, /\.md$/);
    assert.equal(records["/empty"].state, "failed");
    assert.equal(records["/empty"].error, "the response body is empty");
    assert.equal(records["/huge"].state, "failed");
    assert.match(records["/huge"].error, /larger than 1024 bytes/);
    assert.equal(records["/down"].state, "failed");
    assert.match(records["/down"].error, /fetch failed.*ECONNREFUSED/);
    assert.equal(records["/down"].status, null);
    assert.ok(fakeFetch.requests.every((request) => request.method === "GET" && request.headers["user-agent"]), "only GET requests, with a user agent");
  } finally {
    workspace.cleanup();
  }
});

test("AC11 and AC12: a usage error or an unusable input exits non-zero before anything is written", async () => {
  const workspace = createSnapshotWorkspace();
  try {
    const none = pages();
    assert.equal((await invoke(run, ["--out", workspace.out], { fetch: none })).code, 2, "--project is required");
    assert.equal((await invoke(run, [...snapshotArgs(workspace), "--bogus", "1"], { fetch: none })).code, 2, "an unknown option");
    assert.equal((await invoke(run, snapshotArgs(workspace).map((value) => (value === "snapshot-fixture" ? "other" : value)), { fetch: none })).code, 1, "a project that the manifest does not list");
    assert.equal((await invoke(run, snapshotArgs(workspace).map((value) => (value === workspace.checkout ? path.join(workspace.workspace, "absent") : value)), { fetch: none })).code, 1, "a checkout that does not exist");
    assert.equal((await invoke(run, snapshotArgs(workspace, ["--timeout-ms", "0"]), { fetch: none })).code, 2);
    assert.equal(none.requests.length, 0, "nothing was fetched");
    assert.equal(fs.existsSync(workspace.out), false, "and nothing was written");
  } finally {
    workspace.cleanup();
  }
});

test("AC11: the manifest reader refuses what the snapshot must not rely on: a wildcard host, credentials and a duplicate project", async () => {
  const directory = tempDir();
  try {
    const write = (name, text) => {
      fs.writeFileSync(path.join(directory, name), text);
      return path.join(directory, name);
    };
    const project = (extra = "") => `projects:\n  - projectKey: p\n    repo: o/r\n    driftAudit:\n      knowledgeSources:\n        watchUrls:\n          - url: https://example.org/a\n            label: A\n            kind: docs\n${extra}`;
    const ok = await readProjectSources({ manifestPath: write("ok.yaml", project("        packageManifests:\n          - package.json\n")), projectKey: "p" });
    assert.deepEqual(ok, { projectKey: "p", repo: "o/r", watchUrls: [{ url: "https://example.org/a", label: "A", kind: "docs" }], packageManifests: ["package.json"] });
    for (const [name, text, message] of [
      ["wild.yaml", project().replace("https://example.org/a", "https://*.example.org/a"), /wildcard/],
      ["creds.yaml", project().replace("https://example.org/a", "https://user:pw@example.org/a"), /credentials/],
      ["scheme.yaml", project().replace("https://example.org/a", "ftp://example.org/a"), /not an http\(s\) URL/],
      ["kind.yaml", project().replace("kind: docs", "kind: podcast"), /unknown kind 'podcast'/],
      ["dup.yaml", `${project()}  - projectKey: p\n    repo: o/r2\n    driftAudit: {}\n`, /more than once/],
      ["traversal.yaml", project("        packageManifests:\n          - ../outside/package.json\n"), /leaves the checkout/],
      ["absolute.yaml", project("        packageManifests:\n          - /etc/passwd\n"), /relative POSIX path/],
    ]) {
      await assert.rejects(readProjectSources({ manifestPath: write(name, text), projectKey: "p" }), message, name);
    }
    await assert.rejects(readProjectSources({ manifestPath: path.join(directory, "missing.yaml"), projectKey: "p" }), /cannot be read/);
    await assert.rejects(readProjectSources({ manifestPath: write("nolist.yaml", "other: 1\n"), projectKey: "p" }), /no projects list/);
    await assert.rejects(readProjectSources({ manifestPath: write("nokey.yaml", project()), projectKey: "nope" }), /no project 'nope'/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC12: glob patterns: * and ? stay in a segment, ** crosses directories, braces choose, everything is case-sensitive", () => {
  const cases = [
    ["package.json", "package.json", true],
    ["package.json", "node/package.json", false],
    ["node/package.json", "node/package.json", true],
    ["**/*.csproj", "App.csproj", true],
    ["**/*.csproj", "a/b/App.csproj", true],
    ["**/*.csproj", "a/b/App.csproj.bak", false],
    ["*.csproj", "a/App.csproj", false],
    ["src/**", "src/a/b.txt", true],
    ["src/**", "other/a.txt", false],
    ["a/**/z.json", "a/z.json", true],
    ["a/**/z.json", "a/b/c/z.json", true],
    ["requirements?.txt", "requirements1.txt", true],
    ["requirements?.txt", "requirements10.txt", false],
    ["{package,composer}.json", "composer.json", true],
    ["Package.json", "package.json", false],
    ["./package.json", "package.json", true],
  ];
  for (const [pattern, file, expected] of cases) assert.equal(matchesGlob(pattern, file), expected, `${pattern} on ${file}`);
  for (const bad of ["", "  ", "/abs/x", "C:/x", "a/../b", "a\\b"]) assert.throws(() => globToRegExp(bad), /relative|empty|leaves/, JSON.stringify(bad));
  assert.throws(() => globToRegExp("{a,b"), /brace/);
});

test("AC12: the listing is sorted, skips .git and node_modules and never follows a link", () => {
  const directory = tempDir();
  try {
    for (const file of ["b.txt", "a/c.txt", "a/b/d.txt", ".git/config", "node_modules/x/package.json"]) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), "x");
    }
    assert.deepEqual(listFiles(directory), ["a/b/d.txt", "a/c.txt", "b.txt"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC12: the dependency parsers read package.json, MSBuild files, requirements.txt and go.mod, and refuse to guess for the rest", () => {
  const parse = (name, text) => parseManifestFile(name, Buffer.from(text));
  const npm = parse("package.json", JSON.stringify({ dependencies: { b: "2", a: "1" }, optionalDependencies: { o: "3" }, peerDependencies: { p: ">=4" } }));
  assert.deepEqual(npm.dependencies.map((entry) => `${entry.scope}:${entry.name}@${entry.version}`), ["dependencies:a@1", "dependencies:b@2", "peerDependencies:p@>=4", "optionalDependencies:o@3"]);
  assert.equal(parse("package.json", "[]").parser, "none");
  const msbuild = parse(
    "Directory.Packages.props",
    '<Project><ItemGroup><PackageVersion Include="Pkg.A" Version="1.0.0" /><PackageVersion Include="Pkg.B" Version="2.0.0-beta" /><!-- <PackageVersion Include="Gone" Version="9" /> --></ItemGroup></Project>',
  );
  assert.deepEqual(msbuild.dependencies.map((entry) => [entry.name, entry.version]), [["Pkg.A", "1.0.0"], ["Pkg.B", "2.0.0-beta"]]);
  const multi = parse("a.csproj", "<Project><PropertyGroup><TargetFrameworks>net8.0;net6.0</TargetFrameworks></PropertyGroup><ItemGroup><PackageReference Update='X' Version='1.&amp;2'/></ItemGroup></Project>");
  assert.deepEqual(multi.frameworks, ["net6.0", "net8.0"]);
  assert.deepEqual(multi.dependencies, [{ name: "X", version: "1.&2", scope: "PackageReference" }]);
  const requirements = parse("requirements-dev.txt", "# comment\nflask[async]==3.0.0\n-r base.txt\nrequests>=2.31,<3 ; python_version >= '3.9'\nnumpy\n");
  assert.deepEqual(requirements.dependencies.map((entry) => [entry.name, entry.version]), [["flask", "==3.0.0"], ["numpy", null], ["requests", ">=2.31,<3"]]);
  const goMod = parse("go.mod", "module example.org/m\n\ngo 1.22\n\nrequire (\n\texample.org/a v1.2.3\n\texample.org/b v0.4.0 // indirect\n)\nrequire example.org/c v2.0.0\n");
  assert.deepEqual(goMod.dependencies.map((entry) => `${entry.name}@${entry.version}`), ["go@1.22", "example.org/a@v1.2.3", "example.org/b@v0.4.0", "example.org/c@v2.0.0"]);
  assert.deepEqual(parse("Gemfile", "gem 'rails'"), { parser: "none", dependencies: null });
});

// The pre-agent steps run before any `npm ci`, so the manifest is read by a reader of its own when the `yaml` package is absent.
function* yamlFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* yamlFiles(child);
    else if (/\.ya?ml$/.test(entry.name)) yield child;
  }
}

test("the dependency-free YAML reader agrees with the yaml package on every YAML file of the repository's tests and on sdlc.yaml", () => {
  const files = [...yamlFiles(abs("tests")), abs("sdlc.yaml")];
  let compared = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    let expected;
    try {
      expected = YAML.parse(text);
    } catch {
      assert.throws(() => parseYamlSubset(text), YamlSubsetError, `${path.relative(REPO_ROOT, file)}: both refuse it`);
      continue;
    }
    assert.deepEqual(parseYamlSubset(text), expected, path.relative(REPO_ROOT, file));
    compared += 1;
  }
  assert.ok(compared >= 30, `${compared} files compared`);
});

test("the dependency-free YAML reader agrees with the yaml package on block scalars, multi-line scalars, flow collections and comments", () => {
  const cases = {
    literal: "a: |\n  line1\n  line2\n\n  line3\nb: 1\n",
    literalStrip: "a: |-\n  line1\n  line2\nb: 1\n",
    literalKeep: "a: |+\n  line1\n\n\nb: 1\n",
    folded: "a: >\n  one\n  two\n\n  three\n    more\n  four\nb: 2\n",
    foldedStrip: "a: >-\n  one\n  two\nb: 2\n",
    multiPlain: "a: first\n  second\n  third\nb: x\n",
    multiPlainBlank: "a: first\n\n  third\nb: x\n",
    doubleQuoted: 'a: "he said \\"hi\\"\\n\\ttab \\u00e9"\n',
    doubleQuotedMulti: 'a: "line one\n  line two\n\n  line three"\nb: 1\n',
    escapedBreak: 'a: "abc\\\n  def"\n',
    singleQuoted: "a: 'it''s'\nb: 'x # y'\n",
    singleQuotedMulti: "a: 'one\n  two'\n",
    flowSequence: "a: [1, two, 'three', \"four\", [5, 6], {x: 7}]\n",
    flowMapping: "a: {x: 1, y: [a, b], 'z w': null, q}\n",
    flowMulti: "a: [one,\n  two,\n  three]\nb: 1\n",
    empties: "a: []\nb: {}\nc:\nd: ~\n",
    sequenceAtKeyIndent: "a:\n- 1\n- 2\nb:\n  - x\n  - y\n",
    nestedSequence: "- - a\n  - b\n- - c\n",
    sequenceOfMappings: "- name: a\n  value: 1\n- name: b\n  value:\n    - 1\n    - 2\n",
    emptyItems: "a:\n  -\n  - x\n",
    comments: "# top\na: 1 # trailing\nb: 'x' # c\nc: # nothing\n  d: 2 # more\n",
    quotedKeys: "\"a b\": 1\n'c:d': 2\n",
    urlValues: "u: https://example.org/a#frag\nv: a:b\nw: 12:30\n",
    numbers: "a: 1\nb: -2\nc: 3.5\nd: 1e3\ne: 0x1F\nf: 0o17\ng: .inf\nh: 1.0.1\ni: 007\nj: 1_000\n",
    booleansAndNull: "a: true\nb: False\nc: TRUE\nd: yes\ne: no\nf: null\ng: Null\nh: ~\n",
    documentStart: "---\na: 1\n",
    topLevelScalar: "just a string\n",
    windowsLineEnds: "a: 1\r\nb:\r\n  - x\r\n  - y\r\n",
    blockScalarsInSequence: "- |\n  text\n  more\n- >\n  folded\n  text\n",
    deepNesting: "a:\n  b:\n    c:\n      - d: 1\n        e:\n          - f\n",
    keyThenKey: "a:\nb: 1\n",
    dashAndDigits: "args:\n  - -y\n  - '@upstash/context7-mcp@latest'\n  - 5\n",
  };
  for (const [name, text] of Object.entries(cases)) assert.deepEqual(parseYamlSubset(text), YAML.parse(text), name);
});

test("the dependency-free YAML reader refuses what it does not support instead of guessing", () => {
  for (const text of ["a: &x 1\n", "a: *x\n", "a: !!str 1\n", "\ta: 1\n", "a: 1\na: 2\n", "? a\n: b\n", "a: b: c\n", "a: [1, 2\n", "a: 'open\n", "a: |x\n  t\n", "---\na: 1\n---\nb: 2\n"]) {
    assert.throws(() => parseYamlSubset(text), YamlSubsetError, JSON.stringify(text));
  }
  assert.throws(() => parseYamlSubset("a: 1\n  b: 2\n"), /mapping value is not allowed|unexpected/);
});

test("loadYaml uses the yaml package when it is installed and the subset reader when asked, with the same value", async () => {
  const text = "projects:\n  - projectKey: a\n    list: [1, 2]\n    text: >-\n      folded\n      text\n";
  assert.deepEqual(await loadYaml(text, { parser: "subset" }), await loadYaml(text, { parser: "yaml" }));
  assert.deepEqual(await loadYaml(text), YAML.parse(text));
});

// AC11: "an entry that cannot be fetched MUST be listed there as failed and carried into the report as a limitation, never dropped or guessed".
// The script lists it (above); the prompt of each preset workflow tells the agent to carry it into the report of that workflow.
const LIMITATION = {
  "gh-admin-msft": { sentence: "A source that could not be fetched is a limitation to report, never something to guess.", section: null },
  "copilot-lab": {
    sentence: "A watched source that it lists as failed, and a package manifest pattern that matched no file, are limitations: record each in the `## Checks` section of the report and never guess what the source said.",
    section: "Checks",
  },
  "self-improving-agents": {
    sentence: "A watched source that `/tmp/gh-aw/agent/sources/manifest.json` lists as failed is a limitation too: record it in the `## Summary` section of the report and never guess what the source said.",
    section: "Summary",
  },
};

for (const key of DRIFT_KEYS) {
  test(`AC11: the prompt of drift-${key} tells the agent to carry a source that manifest.json lists as failed into the report as a limitation, and never to guess it`, () => {
    const { body } = driftWorkflow(key);
    const { sentence, section } = LIMITATION[key];
    assert.ok(body.includes(sentence), `${key}: ${sentence}`);
    assert.ok(body.includes("manifest.json"), `${key}: the prompt names the manifest that holds the failed entries`);
    if (section !== null) {
      // the section named for the limitation is a section that the report must carry anyway, so that its validator still passes
      const required = key === "copilot-lab" ? AUDIT_SECTIONS : SELF_IMPROVEMENT_SECTIONS;
      assert.ok(required.includes(section), `## ${section} is a required section of the ${key} report`);
    }
  });
}
