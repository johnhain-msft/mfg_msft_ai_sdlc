// AC58: rendering is deterministic and idempotent.
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, listFiles, presetManifest, readText, readYaml, referenceRequest, REPO_ROOT, sha256, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();

/** A copy of a value in which every object's keys come in reverse order (arrays keep manifest order). */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  return value;
}

/** A deterministic pseudo-random shuffle of every object's keys. */
function shuffleKeys(value, seed = { state: 0x2545f491 }) {
  const next = () => {
    seed.state ^= seed.state << 13;
    seed.state ^= seed.state >>> 17;
    seed.state ^= seed.state << 5;
    return (seed.state >>> 0) / 0x100000000;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const keys = Object.keys(node);
      for (let index = keys.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [keys[index], keys[other]] = [keys[other], keys[index]];
      }
      return Object.fromEntries(keys.map((key) => [key, walk(node[key])]));
    }
    return node;
  };
  return walk(value);
}

/** SHA-256 of every file that a run wrote, keyed by path. */
function digests(workspace) {
  return Object.fromEntries(workspace.list(W).map((file) => [file, sha256(Buffer.from(workspace.read(file)))]));
}

async function render(manifestText) {
  const workspace = createWorkspace({ manifestText, instructions: true });
  const result = await workspace.reconcile(request);
  assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
  return workspace;
}

test("AC58: two renders in two directories, the second with the manifest's keys reversed or shuffled, are byte-identical", async () => {
  const original = readText(abs("sdlc.yaml"));
  const manifest = readYaml(abs("sdlc.yaml"));
  const variants = {
    original,
    reversed: toYaml(reverseKeys(manifest)),
    shuffled: toYaml(shuffleKeys(manifest)),
  };
  assert.notEqual(variants.reversed, toYaml(manifest));
  assert.notEqual(variants.shuffled, toYaml(manifest));
  const results = {};
  for (const [name, text] of Object.entries(variants)) {
    const workspace = await render(text);
    try {
      results[name] = digests(workspace);
    } finally {
      workspace.cleanup();
    }
  }
  assert.ok(Object.keys(results.original).length >= 18);
  assert.deepEqual(results.reversed, results.original, "reversed keys");
  assert.deepEqual(results.shuffled, results.original, "shuffled keys");
});

test("AC58: renderFleet output does not depend on the order of earlier renders in the process", () => {
  const first = renderFleet(request);
  renderFleet({ ...request, appSlug: "other-app", engineAuthMode: "copilot-requests" });
  const second = renderFleet(request);
  assert.deepEqual([...second.files], [...first.files]);
});

test("AC58: a render in a separate process (the command-line wrapper) matches the in-process render", async () => {
  const inProcess = await render(readText(abs("sdlc.yaml")));
  const viaCli = createWorkspace();
  try {
    const outcome = viaCli.cli(abs("tests", "s1", "fixtures", "request.reference.json"));
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(digests(viaCli), digests(inProcess));
  } finally {
    inProcess.cleanup();
    viaCli.cleanup();
  }
});

test("AC58: the committed .md sources, router and aw.json equal the regenerated files (git diff --exit-code .github/workflows would pass)", () => {
  const rendered = renderFleet(request).files;
  for (const [name, text] of rendered) {
    if (name.endsWith("aw.json")) continue;
    assert.equal(readText(abs(name)), text, `${name} is up to date`);
  }
  // renderFleet() renders the intended repository config; the committed one is what the compiler of record accepts:
  // gh-aw v1.0.1 rejects protected_files, so the committed file is the render without that key (AC55, section 4).
  const { protected_files: protectedFiles, ...acceptedByCompiler } = JSON.parse(rendered.get(`${W}/aw.json`));
  assert.deepEqual(protectedFiles, { exclude: [] });
  assert.deepEqual(JSON.parse(readText(abs(W, "aw.json"))), acceptedByCompiler);
  // Files that the compiler leaves behind for cross-repository targets are ignored by git and are not part of the fleet.
  const committed = listFiles(REPO_ROOT, W).filter((name) => /\.(md|yml)$/.test(name) && !name.endsWith(".lock.yml") && !/\/agentics-maintenance[^/]*\.yml$/.test(name));
  assert.deepEqual(committed, [...rendered.keys()].filter((name) => /\.(md|yml)$/.test(name)).sort());
});

test("AC58: every file is UTF-8 without a byte order mark, with LF line endings and a final newline", async () => {
  const workspace = await render(readText(abs("sdlc.yaml")));
  try {
    for (const file of workspace.list(W).filter((name) => !name.endsWith(".lock.yml"))) {
      const bytes = Buffer.from(workspace.read(file), "utf8");
      assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file}: BOM`);
      assert.equal(bytes.includes(0x0d), false, `${file}: CR`);
      assert.equal(bytes.at(-1), 0x0a, `${file}: final newline`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC58: no timestamp, random value, host name or absolute path reaches a generated file", async () => {
  const workspace = await render(readText(abs("sdlc.yaml")));
  try {
    const forbidden = [workspace.dir, workspace.root, os.tmpdir(), REPO_ROOT.replace(/[\\/]$/, ""), os.hostname()].filter((value) => value.length > 3);
    for (const file of workspace.list(W).filter((name) => !name.endsWith(".lock.yml"))) {
      const text = workspace.read(file);
      for (const value of forbidden) assert.equal(text.includes(value), false, `${file} contains ${value}`);
      assert.equal(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false, `${file}: an ISO timestamp`);
      assert.equal(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(text), false, `${file}: a UUID`);
      assert.equal(/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(text), false, `${file}: an absolute path`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC58: arrays keep manifest order unless the criterion says sorted: reviewers and projects follow the manifest", () => {
  const manifest = presetManifest();
  manifest.dependencyEdges[1].reviewers = ["zeta", "alpha"];
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const files = renderFleet(request, { cwd: workspace.dir }).files;
    const text = files.get(`${W}/cascade-ai-copilot-lab.md`);
    assert.ok(text.indexOf("- zeta") < text.indexOf("- alpha"));
  } finally {
    workspace.cleanup();
  }
});
