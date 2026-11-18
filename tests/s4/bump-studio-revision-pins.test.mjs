// AC35-AC39: scripts/bump-studio-revision-pins.mjs replaces the prior revision in the pin files that the manifest names, and nowhere else.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assignedLiterals, bumpText } from "../../scripts/bump-studio-revision-pins.mjs";
import { HELPERS, commitAll, fixture, git, jsonOf, portfolioMin, readJson, readText, runNode, tempDir, writeFiles } from "./helpers/fixtures.mjs";

const PRIOR = "2108ac9a1e9eff96e97b500117b0de4a546768c3";
const OLDER = "d362e1c8752b398307ae84341ccc82fec63b595f";
const NEW = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const TARGETS = [
  "apps/lab-studio/client/src/labs/source.ts",
  "apps/lab-studio/server/tests/source.test.ts",
  "apps/lab-studio/server/tests/lab-drift.test.ts",
  "README.md",
  "experiences/copilot-workshop/public/NOTICE.txt",
  "public/copilot-project.html",
];
const bump = (dir, sha = NEW, options = {}) => runNode(HELPERS.bump, ["--portfolio", dir, "--new-sha", sha], options);
const changedPaths = (dir) => git(dir, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
const file = (dir, relative) => readText(path.join(dir, ...relative.split("/")));

test("AC35/AC36: the bump reads the prior revisions from the provenance files, writes the six target files and no other, and never a provenance file", () => {
  const { dir } = portfolioMin();
  const result = bump(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(changedPaths(dir), [...TARGETS].sort(), "git status lists only the target files");
  assert.deepEqual(jsonOf(result.stdout), { newSha: NEW, priorShas: [PRIOR], updatedFiles: TARGETS });
  for (const forbidden of ["apps/lab-studio/lab-sources.json", "experiences/copilot-workshop/provenance.json", "experiences/copilot-workshop/source-inputs.json"]) {
    assert.equal(changedPaths(dir).includes(forbidden), false, forbidden);
  }
  assert.equal(readJson(path.join(dir, "apps/lab-studio/lab-sources.json"))._provenance.commit, PRIOR, "only the accept commands write the manifest");
});

test("AC37/AC38: the forms of the studio source files: the constant, the two expect forms and the pinned URLs change; the slice expression and every comment stay", () => {
  const { dir } = portfolioMin();
  assert.equal(bump(dir).code, 0);
  const source = file(dir, TARGETS[0]);
  assert.ok(source.includes(`export const SOURCE_COMMIT = "${NEW}";`));
  assert.ok(source.includes("export const SOURCE_SHORT_COMMIT = SOURCE_COMMIT.slice(0, 7);"), "the slice expression is untouched");
  const test = file(dir, TARGETS[1]);
  assert.ok(test.includes(`expect(SOURCE_COMMIT).toBe("${NEW}");`));
  assert.ok(test.includes(`expect(SOURCE_SHORT_COMMIT).toBe("${NEW.slice(0, 7)}");`));
  assert.ok(test.includes(`blob/${NEW}/`), "the URL of the pinned constant");
  assert.ok(test.includes('// At 2108ac9 labs/setup.md is a pointer: "Setup has moved!'), "a 7-hex in a // comment is left alone");
  assert.equal(test.includes(PRIOR), false);
});

test("AC37/AC38: lab-drift.test.ts, README.md, NOTICE.txt and the page: exact 40-hex matches change, an older revision and the unrelated 7-hex test inputs stay, and a short form in prose is reported", () => {
  const { dir } = portfolioMin();
  const result = bump(dir);
  const drift = file(dir, TARGETS[2]);
  assert.ok(drift.includes(`commit: "${NEW}",`));
  assert.ok(drift.includes('"abc1234"') && drift.includes('"def5678"') === false, "abc1234 is a test input, not a prior revision");
  assert.ok(drift.includes("// Recorded at edb7b61 (PR #83) before the merge: these labs changed in d362e1c."), "comments keep their revisions");
  const readme = file(dir, TARGETS[3]);
  assert.ok(readme.includes(`\`${NEW}\``) && readme.includes(OLDER) && readme.includes("edb7b61e8f6d61535ac133593c57212c73e6f6cf"), "only the prior revision is replaced");
  assert.ok(file(dir, TARGETS[4]).includes(NEW));
  const page = file(dir, TARGETS[5]);
  assert.equal(page.split(NEW).length - 1, 2, "both URLs of the page");
  assert.ok(page.includes("(2108ac9, PR #86)"), "the short form in prose is not rewritten");
  assert.ok(result.stderr.split("\n").includes("unreplaced-short-sha: public/copilot-project.html:5"), result.stderr);
  assert.equal(result.stderr.includes("unreplaced-short-sha: apps/lab-studio/server/tests"), false, "short forms in comments and expect(...) are not reported");
});

test("AC37: when the two prior revisions differ, the literals of both are replaced", () => {
  const { dir } = portfolioMin();
  writeFiles(dir, {
    "apps/lab-studio/lab-sources.json": file(dir, "apps/lab-studio/lab-sources.json").replace(PRIOR, OLDER),
    "README.md": `A \`${PRIOR}\` and a \`${OLDER}\` and a third \`${"c".repeat(40)}\`.\n`,
  });
  commitAll(dir, "two priors");
  const result = bump(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(jsonOf(result.stdout).priorShas, [OLDER, PRIOR]);
  assert.equal(file(dir, "README.md"), `A \`${NEW}\` and a \`${NEW}\` and a third \`${"c".repeat(40)}\`.\n`);
});

test("AC37: a revision inside comments, a URL string, a template literal, expect(...) and an assignment: the comment bytes stay, the code literals change", () => {
  const text = readText(fixture("revision-pins", "comments.ts"));
  const { text: out, unreplacedShort } = bumpText(text, { typescript: true, priors: [PRIOR], newSha: NEW });
  const lines = out.split("\n");
  const before = text.split("\n");
  assert.equal(lines[0], before[0], "// line comment");
  assert.equal(lines[1], before[1], "/* block comment, first line");
  assert.equal(lines[2], before[2], "block comment, second line");
  assert.equal(lines[3], `export const PINNED = "${NEW}"; // trailing comment with ${PRIOR.slice(0, 7)}`, "code replaced, the trailing comment kept");
  assert.equal(lines[4], `export const URL_FORM = "https://github.com/acme/tree/${NEW}/docs"; // https://example.test/${PRIOR}`, "the // of a URL in a string is not a comment; the comment that follows is");
  assert.equal(lines[5], `export const SHORT = "${NEW.slice(0, 7)}";`, "a short form in an assignment");
  assert.equal(lines[6], before[6], "a regular expression with // inside and a division are not comments");
  assert.equal(lines[7], `const template = \`blob/${NEW}/x \${division} // not a comment\`;`, "a revision in the text of a template literal changes; its // is not a comment");
  assert.equal(lines[9], `  expect(value).toBe("${NEW.slice(0, 7)}");`, "a short form in expect(...)");
  assert.equal(lines[11], before[11], "a short form in a call that is neither expect nor an assignment stays");
  assert.deepEqual(unreplacedShort, [12], "and is reported, by line");
});

test("AC37: the same file in a language without comments (a README, a notice, a page): every exact 40-hex match changes and every short form is reported", () => {
  const text = `see https://github.com/acme/tree/${PRIOR}/x // not a comment\nshort ${PRIOR.slice(0, 7)} in prose and (${PRIOR.slice(0, 7)}) in brackets\n`;
  const { text: out, unreplacedShort } = bumpText(text, { typescript: false, priors: [PRIOR], newSha: NEW });
  assert.equal(out, `see https://github.com/acme/tree/${NEW}/x // not a comment\nshort ${PRIOR.slice(0, 7)} in prose and (${PRIOR.slice(0, 7)}) in brackets\n`);
  assert.deepEqual(unreplacedShort, [2, 2]);
});

test("AC37: a string that merely contains the revision inside a longer hex run is not a revision", () => {
  const longer = `${PRIOR}ab`;
  const { text } = bumpText(`const a = "${longer}"; const b = "x${PRIOR}";\n`, { typescript: true, priors: [PRIOR], newSha: NEW });
  assert.ok(text.includes(longer) && text.includes(`x${PRIOR}`));
});

test("AC35: the prior revisions are never read from the poll cursor: a different SDLC cursor value in the environment changes nothing", () => {
  const one = portfolioMin();
  const two = portfolioMin();
  const a = bump(one.dir);
  const b = bump(two.dir, NEW, { env: { SDLC_SYNC_STATE_COPILOT_LAB: JSON.stringify({ lastMergedUpstreamSha: "e".repeat(40) }), LAST_MERGED_SHA: "e".repeat(40), PREVIOUS_SHA: "e".repeat(40) } });
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout, b.stdout, "identical output");
  assert.equal(git(one.dir, ["diff"]).stdout, git(two.dir, ["diff"]).stdout, "and identical changes");
});

test("AC39: invoked twice with the same --new-sha, the second call is a no-op: exit 0 and every target byte-identical", () => {
  const { dir } = portfolioMin();
  assert.equal(bump(dir).code, 0);
  const once = git(dir, ["diff"]).stdout;
  const second = bump(dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(git(dir, ["diff"]).stdout, once);
  assert.deepEqual(jsonOf(second.stdout).updatedFiles, []);
});

test("AC35: a --new-sha that is not 40 lowercase hex, an unparsable provenance file, a prior revision that is not 40 hex and a missing provenance file exit 2 and change nothing", () => {
  const cases = [
    ["short --new-sha", () => ({ args: "2108ac9" })],
    ["uppercase --new-sha", () => ({ args: NEW.toUpperCase() })],
    ["unparsable provenance", (dir) => writeFiles(dir, { "experiences/copilot-workshop/provenance.json": '{ "commit": ' })],
    ["manifest commit is not 40 hex", (dir) => writeFiles(dir, { "apps/lab-studio/lab-sources.json": file(dir, "apps/lab-studio/lab-sources.json").replace(PRIOR, "abc1234") })],
    ["provenance without a commit", (dir) => writeFiles(dir, { "experiences/copilot-workshop/provenance.json": "{}\n" })],
    ["missing provenance file", (dir) => writeFiles(dir, { "experiences/copilot-workshop/provenance.json": null })],
  ];
  for (const [label, prepare] of cases) {
    const { dir } = portfolioMin();
    const prepared = prepare(dir);
    commitAll(dir, label);
    const result = bump(dir, prepared?.args ?? NEW);
    assert.equal(result.code, 2, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(git(dir, ["diff", "--exit-code"], { allowFailure: true }).status, 0, `${label}: the checkout is untouched`);
  }
});

test("AC39: a bump that runs after the accept commands (the prior revisions already are --new-sha) leaves the pin stale, so it exits 2 and writes nothing", () => {
  const { dir } = portfolioMin();
  const accepted = {};
  for (const relative of ["apps/lab-studio/lab-sources.json", "experiences/copilot-workshop/provenance.json"]) accepted[relative] = file(dir, relative).replaceAll(PRIOR, NEW);
  writeFiles(dir, accepted);
  commitAll(dir, "after the accept");
  const result = bump(dir);
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /SOURCE_COMMIT/);
  assert.equal(git(dir, ["diff", "--exit-code"], { allowFailure: true }).status, 0);
});

test("AC1/AC35: against a fleet whose paths, constant name and files differ from the portfolio's the helper still works, and reports a missing target file", () => {
  const fleet = fixture("synthetic-fleet");
  const dir = path.join(tempDir("sdlc-s4-synthetic-"), "checkout");
  fs.cpSync(path.join(fleet, "portfolio"), dir, { recursive: true });
  git(dir, ["init", "-q"]);
  commitAll(dir, "base");
  const prior = "a".repeat(40);
  const result = runNode(HELPERS.bump, ["--portfolio", dir, "--new-sha", NEW], { cwd: fleet });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(file(dir, "web/revision.ts").includes(`PINNED_REVISION = "${NEW}"`));
  assert.ok(file(dir, "web/revision.ts").includes("PINNED_REVISION.slice(0, 7)"));
  assert.ok(file(dir, "README.md").includes(NEW) && !file(dir, "README.md").includes(prior));
  assert.deepEqual(changedPaths(dir), ["README.md", "web/revision.ts"]);
  fs.rmSync(path.join(dir, "README.md"));
  commitAll(dir, "no readme");
  const again = runNode(HELPERS.bump, ["--portfolio", dir, "--new-sha", NEW], { cwd: fleet });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stderr.includes("skipped-missing-file: README.md"), "a target file that does not exist is skipped and said so");
  const stale = runNode(HELPERS.bump, ["--portfolio", dir, "--new-sha", "c".repeat(40)], { cwd: fleet });
  assert.equal(stale.code, 2, "the pin constant holds NEW, and the provenance files still name the old revision, so nothing replaces NEW by a third one");
});

test("AC37: assignedLiterals finds the string assigned to a constant, with or without a type annotation", () => {
  assert.deepEqual(assignedLiterals('export const SOURCE_COMMIT = "abc";\nconst SOURCE_COMMIT2: string = "d";\n', "SOURCE_COMMIT"), ["abc"]);
  assert.deepEqual(assignedLiterals('export const X: string = "typed";\nobj.X = "member";\n', "X"), ["typed"]);
  assert.deepEqual(assignedLiterals("const X = compute();\n", "X"), []);
});
