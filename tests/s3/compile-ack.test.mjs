// The acknowledgement that SPEC-01's reconciler returns for the cascade workflows (contract C3, CascadeCompileAck) as S3 consumes it (SPEC-03 AC6): the router's path, the
// mechanical workflows' paths and the number of edges, each checked against the files on disk and against sdlc.yaml.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { buildAcks } from "../../src/reconcile.mjs";
import { referenceRequest } from "../s1/helpers/fixtures.mjs";
import { abs, readText } from "./helpers/fixtures.mjs";

const ack = buildAcks(referenceRequest()).cascade;
const manifest = YAML.parse(readText(abs("sdlc.yaml")));
const router = YAML.parse(readText(abs(".github", "workflows", "cascade-router.yml")));

test("AC6 the acknowledgement has exactly the three fields of C3", () => {
  assert.deepEqual(Object.keys(ack).sort(), ["dependencyEdgesCount", "mechanicalWorkflowPaths", "routerWorkflowPath"]);
  assert.equal(typeof ack.routerWorkflowPath, "string");
  assert.ok(Array.isArray(ack.mechanicalWorkflowPaths) && ack.mechanicalWorkflowPaths.every((entry) => typeof entry === "string"));
  assert.equal(Number.isInteger(ack.dependencyEdgesCount), true);
});

test("AC6 routerWorkflowPath is .github/workflows/cascade-router.yml and the file exists", () => {
  assert.equal(ack.routerWorkflowPath, ".github/workflows/cascade-router.yml");
  assert.equal(fs.existsSync(abs(...ack.routerWorkflowPath.split("/"))), true);
});

test("AC6 every mechanicalWorkflowPaths entry exists on disk with its compiled lock, and the preset has .github/workflows/cascade-mechanical-ghec-admin.md", () => {
  assert.ok(ack.mechanicalWorkflowPaths.includes(".github/workflows/cascade-mechanical-ghec-admin.md"));
  for (const entry of ack.mechanicalWorkflowPaths) {
    assert.equal(fs.existsSync(abs(...entry.split("/"))), true, entry);
    assert.equal(fs.existsSync(abs(...entry.replace(/\.md$/, ".lock.yml").split("/"))), true, `${entry}: its lock`);
  }
  const mechanicalEdges = manifest.dependencyEdges.filter((edge) => edge.mode === "mechanical");
  assert.equal(ack.mechanicalWorkflowPaths.length, mechanicalEdges.length, "one per mechanical edge");
});

test("AC6 dependencyEdgesCount equals the length of the router matrix and the number of dependencyEdges entries in sdlc.yaml", () => {
  const matrix = router.jobs.route.strategy.matrix;
  assert.equal(ack.dependencyEdgesCount, matrix.upstreamKey.length);
  assert.equal(ack.dependencyEdgesCount, matrix.include.length);
  assert.equal(ack.dependencyEdgesCount, manifest.dependencyEdges.length);
  assert.equal(ack.dependencyEdgesCount, 4, "the default preset");
});

test("AC6 the acknowledgement is derived without writing: asking for it leaves the committed workflows as they are", () => {
  const before = fs.readFileSync(abs(".github", "workflows", "cascade-router.yml"), "utf8");
  buildAcks(referenceRequest());
  assert.equal(fs.readFileSync(abs(".github", "workflows", "cascade-router.yml"), "utf8"), before);
});
