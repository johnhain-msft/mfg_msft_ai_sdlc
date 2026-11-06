// AC38: no partial writes. Every S2 script writes each artifact atomically (a temporary file in the same directory, then a rename) and, on any
// failure, leaves no truncated or half-written file under its --out directory and no change in the target checkout or the orchestrator
// workspace. The pre-agent steps leave the target checkout's `git status --porcelain` empty, so that a run that finds no drift leaves nothing
// to commit.
//
// A failure is injected two ways, as the criterion names: an aborted fetch and a failing rename. The rename fails on the first, or on a later,
// file of the batch, so that both "nothing was renamed yet" and "some files were already in place" are rolled back.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeFilesAtomically } from "../../src/drift/lib/atomic.mjs";
import { run as dedupe } from "../../src/drift/dedupe-open-prs.mjs";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { run as snapshot } from "../../src/snapshot-watch-sources.mjs";
import { hashTree, listTree, tempDir } from "./helpers/fixtures.mjs";
import { createOrchestratorWorkspace, invoke, leftovers, recordingFs } from "./helpers/run-script.mjs";
import { cleanEnv, createClock, createFakeFetch, hangUntilAbort, json } from "./helpers/stub-server.mjs";

const TARGET = "example-owner/example-target";
const TOKEN = "ghs_installationtokenfixture";

const pages = (body = "<html><body>Release 18.0.0</body></html>") =>
  createFakeFetch((entry) => {
    if (entry.path === "/changelog") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
    if (entry.path === "/missing") return { status: 404, body: "not found" };
    return hangUntilAbort(entry);
  });
const aborted = () =>
  createFakeFetch(() => {
    throw new DOMException("This operation was aborted", "AbortError");
  });
const pulls = (number = 7) => createFakeFetch(() => json(200, [{ number, html_url: `https://github.example/pull/${number}`, head: { ref: "sdlc/weekly-audit-2026-11-01" }, labels: [], draft: false }]));

/** Everything that would be a partial write: a temporary file, a hidden restore file, a JSON file that does not parse. */
function assertNoPartialFiles(directory, label) {
  assert.deepEqual(leftovers(directory), [], `${label}: no temporary or restore file`);
  for (const file of listTree(directory).filter((candidate) => candidate.endsWith(".json"))) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directory, ...file.split("/")), "utf8")), `${label}: ${file} parses`);
  }
  for (const file of listTree(directory)) assert.equal(/\.tmp$/.test(file) || path.basename(file).startsWith("."), false, `${label}: ${file} looks like a temporary file`);
}

const snapshotArgs = (fixtureWorkspace, out) => ["--out", out, "--project", "snapshot-fixture", "--manifest", fixtureWorkspace.manifest, "--checkout", fixtureWorkspace.checkout, "--timeout-ms", "150"];
const dedupeEnv = () => cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GH_APP_INSTALLATION_TOKEN: TOKEN });

async function assertUntouched(fixtureWorkspace, before) {
  assert.equal(fixtureWorkspace.status(), "", "git status --porcelain is empty in the target checkout");
  assert.equal(fixtureWorkspace.orchestrator.status(), "", "and in the orchestrator workspace");
  assert.equal(fixtureWorkspace.fingerprint(), before, "and nothing outside --out changed");
}

/** After a failed run: an --out that the run created is gone, and one that existed is empty again, with no directory of the run left in it. */
function assertOutIsAsItWas(out, preexisting) {
  if (preexisting) {
    assert.equal(fs.existsSync(out), true, "--out existed before the run and still does");
    assert.deepEqual(fs.readdirSync(out), [], "and holds nothing: no file, no temporary file, no directory that the run created");
  } else {
    assert.equal(fs.existsSync(out), false, "--out was created by the run, so it is gone");
  }
}

// --- the writer -----------------------------------------------------------------------------------------------------------------------------

test("AC38: each file is written to a temporary file in its own directory, complete, and then renamed over the target", () => {
  const directory = tempDir("sdlc-s2-atomic-");
  try {
    const observed = [];
    const wrapped = new Proxy(fs, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        if (property === "renameSync") {
          return (from, to) => {
            observed.push({ from, to, bytes: fs.readFileSync(from, "utf8"), targetBefore: fs.existsSync(to) ? fs.readFileSync(to, "utf8") : null });
            return value.call(target, from, to);
          };
        }
        return value.bind(target);
      },
    });
    fs.writeFileSync(path.join(directory, "existing.json"), '{"old":true}\n');
    const result = writeFilesAtomically(
      [
        { path: path.join(directory, "a", "one.json"), data: '{"one":1}\n' },
        { path: path.join(directory, "existing.json"), data: '{"old":false}\n' },
      ],
      { fs: wrapped },
    );
    assert.equal(observed.length, 2);
    for (const { from, to, bytes, targetBefore } of observed) {
      assert.equal(path.dirname(from), path.dirname(to), "the temporary file is in the directory of its target, so the rename stays on one file system");
      assert.match(path.basename(from), /\.tmp$/);
      assert.equal(bytes, to.endsWith("one.json") ? '{"one":1}\n' : '{"old":false}\n', "the temporary file is complete before the rename");
      assert.equal(targetBefore, to.endsWith("existing.json") ? '{"old":true}\n' : null, "the target still held its old content, or nothing, at that moment");
    }
    assert.deepEqual(result.written.map((file) => path.basename(file)), ["one.json", "existing.json"]);
    assert.deepEqual(listTree(directory), ["a/one.json", "existing.json"], "no temporary file remains");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const failingRename of [1, 2, 3]) {
  test(`AC38: when rename number ${failingRename} of three fails, the batch is rolled back: new files and new directories are gone, old files have their old bytes`, () => {
    const directory = tempDir("sdlc-s2-atomic-");
    try {
      const existing = path.join(directory, "kept.json");
      fs.writeFileSync(existing, '{"before":true}\n');
      const before = hashTree(directory);
      const recorder = recordingFs({ failRename: (from, to, count) => count === failingRename });
      assert.throws(
        () =>
          writeFilesAtomically(
            [
              { path: path.join(directory, "new", "deep", "first.json"), data: '{"first":1}\n' },
              { path: existing, data: '{"before":false}\n' },
              { path: path.join(directory, "second.json"), data: '{"second":2}\n' },
            ],
            { fs: recorder.fs },
          ),
        /injected rename failure/,
      );
      assert.equal(hashTree(directory), before, "the directory is exactly as it was");
      assert.equal(fs.existsSync(path.join(directory, "new")), false, "including the directories that the batch created");
      assertNoPartialFiles(directory, `rename ${failingRename}`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("AC38: a write that stops half way leaves no truncated temporary file and never creates the target", () => {
  const directory = tempDir("sdlc-s2-atomic-");
  try {
    fs.mkdirSync(path.join(directory, "x"));
    let writes = 0;
    const wrapped = new Proxy(fs, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        if (property === "writeFileSync") {
          return (file, data) => {
            writes += 1;
            if (writes === 2) {
              value.call(target, file, String(data).slice(0, 4));
              throw Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
            }
            return value.call(target, file, data);
          };
        }
        return value.bind(target);
      },
    });
    assert.throws(() => writeFilesAtomically([{ path: path.join(directory, "x", "a.json"), data: '{"a":1}\n' }, { path: path.join(directory, "x", "b.json"), data: '{"b":2}\n' }], { fs: wrapped }), /injected disk full/);
    assert.deepEqual(listTree(directory), [], "nothing is left in the directory that existed: no half-written temporary file, no target");
    assert.deepEqual(fs.readdirSync(path.join(directory, "x")), []);
    // and the same when the directory is one that the batch had to create: it is removed, whole
    const refusingWrites = new Proxy(fs, {
      get(target, property) {
        const value = target[property];
        if (property === "writeFileSync") return () => { throw new Error("injected failure"); };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.throws(() => writeFilesAtomically([{ path: path.join(directory, "y", "a.json"), data: '{"a":1}\n' }], { fs: refusingWrites }), /injected failure/);
    assert.equal(fs.existsSync(path.join(directory, "y")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AC38: a file whose bytes would not change is not rewritten, so an unchanged run cannot half-write anything", () => {
  const directory = tempDir("sdlc-s2-atomic-");
  try {
    const target = path.join(directory, "same.json");
    fs.writeFileSync(target, '{"same":true}\n');
    const recorder = recordingFs();
    const result = writeFilesAtomically([{ path: target, data: '{"same":true}\n' }], { fs: recorder.fs });
    assert.deepEqual(result, { written: [], unchanged: [path.resolve(target)] });
    assert.deepEqual(recorder.writes, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// --- snapshot-watch-sources ----------------------------------------------------------------------------------------------------------------

for (const failingRename of [1, 2, 4]) {
  for (const preexisting of [false, true]) {
    test(`AC38: snapshot-watch-sources with rename number ${failingRename} failing exits 1 and leaves no file under --out (${preexisting ? "which existed already, as /tmp/gh-aw/agent does" : "which the run would have created"}), and the checkout clean`, async () => {
      const fixtureWorkspace = createOrchestratorWorkspace();
      try {
        if (preexisting) fs.mkdirSync(fixtureWorkspace.out, { recursive: true });
        const before = fixtureWorkspace.fingerprint();
        const recorder = recordingFs({ failRename: (from, to, count) => count === failingRename });
        const result = await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { fetch: pages(), fs: recorder.fs, env: cleanEnv() });
        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stderr, /injected rename failure/);
        assert.ok(recorder.renames.length >= failingRename, "the rename that failed was reached");
        assertOutIsAsItWas(fixtureWorkspace.out, preexisting);
        await assertUntouched(fixtureWorkspace, before);
      } finally {
        fixtureWorkspace.cleanup();
      }
    });
  }
}

test("AC38: a failing rename in a second snapshot run leaves the files of the first run exactly as they were", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    assert.equal((await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { fetch: pages(), env: cleanEnv() })).code, 0);
    const first = hashTree(fixtureWorkspace.out);
    const before = fixtureWorkspace.fingerprint();
    const recorder = recordingFs({ failRename: (from, to, count) => count === 2 });
    const result = await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { fetch: pages("<html><body>Release 19.0.0</body></html>"), fs: recorder.fs, env: cleanEnv() });
    assert.equal(result.code, 1);
    assert.equal(hashTree(fixtureWorkspace.out), first, "byte for byte the first run's output: nothing truncated, nothing half replaced");
    assertNoPartialFiles(fixtureWorkspace.out, "after the failed second run");
    await assertUntouched(fixtureWorkspace, before);
  } finally {
    fixtureWorkspace.cleanup();
  }
});

test("AC38: an aborted fetch for every watched URL is recorded as failed, and the manifest that results is whole JSON with no temporary file beside it", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    const before = fixtureWorkspace.fingerprint();
    const fetch = aborted();
    const result = await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { fetch, env: cleanEnv() });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fetch.requests.length, 3, "every URL was attempted");
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureWorkspace.out, "sources", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.watchUrls.map((record) => record.state), ["failed", "failed", "failed"]);
    assert.equal(manifest.watchUrls.every((record) => record.snapshot === null), true, "no snapshot file is claimed for an entry that was not fetched");
    assertNoPartialFiles(fixtureWorkspace.out, "after the aborted fetches");
    assert.equal(listTree(fixtureWorkspace.out).some((file) => /\.html$/.test(file)), false, "and no snapshot file was written for them");
    await assertUntouched(fixtureWorkspace, before);
  } finally {
    fixtureWorkspace.cleanup();
  }
});

test("AC38: a fetch that is aborted half way through the body leaves no truncated snapshot", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    const before = fixtureWorkspace.fingerprint();
    const stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html><body>Release 1"));
        },
        pull() {
          throw new DOMException("This operation was aborted", "AbortError");
        },
      });
    const fetch = createFakeFetch((entry) => (entry.path === "/changelog" ? new Response(stream(), { status: 200, headers: { "content-type": "text/html" } }) : { status: 404, body: "gone" }));
    const result = await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { fetch, env: cleanEnv() });
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureWorkspace.out, "sources", "manifest.json"), "utf8"));
    const changelog = manifest.watchUrls.find((record) => record.url.endsWith("/changelog"));
    assert.equal(changelog.state, "failed", "a body that did not arrive in full is a failed entry");
    assert.equal(changelog.snapshot, null);
    assert.equal(listTree(fixtureWorkspace.out).some((file) => /\.html$/.test(file)), false, "the half body is not kept as a snapshot");
    assertNoPartialFiles(fixtureWorkspace.out, "after the interrupted body");
    await assertUntouched(fixtureWorkspace, before);
  } finally {
    fixtureWorkspace.cleanup();
  }
});

// --- dedupe-open-prs -----------------------------------------------------------------------------------------------------------------------

test("AC38: dedupe-open-prs with an aborted fetch exits 1 and creates nothing under --out", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    const before = fixtureWorkspace.fingerprint();
    const clock = createClock();
    const fetch = aborted();
    const result = await invoke(dedupe, ["--out", fixtureWorkspace.out, "--target-repo", TARGET], { env: dedupeEnv(), fetch, now: clock.now, sleep: clock.sleep });
    assert.equal(result.code, 1);
    assert.ok(fetch.requests.length >= 1);
    assert.equal(fs.existsSync(fixtureWorkspace.out), false, "no --out directory, no file");
    await assertUntouched(fixtureWorkspace, before);
  } finally {
    fixtureWorkspace.cleanup();
  }
});

for (const failingRename of [1, 2]) {
  for (const preexisting of [false, true]) {
    test(`AC38: dedupe-open-prs with rename number ${failingRename} failing exits 1 and leaves nothing behind (--out ${preexisting ? "existed already" : "absent"})`, async () => {
      const fixtureWorkspace = createOrchestratorWorkspace();
      try {
        if (preexisting) fs.mkdirSync(fixtureWorkspace.out, { recursive: true });
        const before = fixtureWorkspace.fingerprint();
        const recorder = recordingFs({ failRename: (from, to, count) => count === failingRename });
        const result = await invoke(dedupe, ["--out", fixtureWorkspace.out, "--target-repo", TARGET], { env: dedupeEnv(), fetch: pulls(), fs: recorder.fs });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /injected rename failure/);
        assertOutIsAsItWas(fixtureWorkspace.out, preexisting);
        await assertUntouched(fixtureWorkspace, before);
      } finally {
        fixtureWorkspace.cleanup();
      }
    });
  }
}

test("AC38: a failing rename in a second dedupe run restores the report of the first run, whole", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    assert.equal((await invoke(dedupe, ["--out", fixtureWorkspace.out, "--target-repo", TARGET], { env: dedupeEnv(), fetch: pulls(7) })).code, 0);
    const first = hashTree(fixtureWorkspace.out);
    const recorder = recordingFs({ failRename: (from, to, count) => count === 2 });
    const result = await invoke(dedupe, ["--out", fixtureWorkspace.out, "--target-repo", TARGET], { env: dedupeEnv(), fetch: pulls(8), fs: recorder.fs });
    assert.equal(result.code, 1);
    assert.equal(hashTree(fixtureWorkspace.out), first, "both files hold what the first run wrote, not a mixture");
    assertNoPartialFiles(fixtureWorkspace.out, "after the failed second run");
  } finally {
    fixtureWorkspace.cleanup();
  }
});

// --- prepare-run and the run as a whole ----------------------------------------------------------------------------------------------------

test("AC38: prepare-run with a failing rename exits 1 and leaves no run context", async () => {
  for (const preexisting of [false, true]) {
    const fixtureWorkspace = createOrchestratorWorkspace();
    try {
      if (preexisting) fs.mkdirSync(fixtureWorkspace.out, { recursive: true });
      const before = fixtureWorkspace.fingerprint();
      const recorder = recordingFs({ failRename: (from, to, count) => count === 1 });
      const result = await invoke(prepare, ["--out", fixtureWorkspace.out, "--target-repo", TARGET, "--dry-run", "true", "--checkout", "checkout"], {
        env: cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: fixtureWorkspace.workspace }),
        fs: recorder.fs,
      });
      assert.equal(result.code, 1);
      assertOutIsAsItWas(fixtureWorkspace.out, preexisting);
      await assertUntouched(fixtureWorkspace, before);
    } finally {
      fixtureWorkspace.cleanup();
    }
  }
});

test("AC38: after a complete run of the three pre-agent scripts the target checkout has an empty git status, so a run without drift leaves nothing to commit", async () => {
  const fixtureWorkspace = createOrchestratorWorkspace();
  try {
    const before = fixtureWorkspace.fingerprint();
    const env = cleanEnv({ CONFIGURED_TARGET_REPO: TARGET, GITHUB_WORKSPACE: fixtureWorkspace.workspace, GH_APP_INSTALLATION_TOKEN: TOKEN });
    assert.equal((await invoke(prepare, ["--out", fixtureWorkspace.out, "--target-repo", TARGET, "--dry-run", "false", "--checkout", "checkout"], { env })).code, 0);
    assert.equal((await invoke(dedupe, ["--out", fixtureWorkspace.out, "--target-repo", TARGET], { env, fetch: pulls() })).code, 0);
    assert.equal((await invoke(snapshot, snapshotArgs(fixtureWorkspace, fixtureWorkspace.out), { env, fetch: pages() })).code, 0);
    assertNoPartialFiles(fixtureWorkspace.out, "after the complete run");
    await assertUntouched(fixtureWorkspace, before);
  } finally {
    fixtureWorkspace.cleanup();
  }
});
