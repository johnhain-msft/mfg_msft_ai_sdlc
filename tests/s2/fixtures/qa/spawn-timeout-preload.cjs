// Observe only the real CLI spawns of the selected S1 regression, preserving the
// real implementation and never delaying a process to simulate a busy host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = childProcess.spawnSync;

childProcess.spawnSync = function observedSpawn(command, args, options) {
  const cli = command === process.execPath && /[\\/]src[\\/]reconcile\.mjs$/.test(String(args?.[0] ?? ""));
  if (cli) assert.equal(options?.timeout, 120000, "two-minute CLI spawn timeout reaches the actual spawn");
  const result = original(command, args, options);
  if (cli && process.env.SDLC_QA_SPAWN_LOG) {
    fs.appendFileSync(process.env.SDLC_QA_SPAWN_LOG, `${JSON.stringify({ timeout: options.timeout, status: result.status })}\n`);
  }
  return result;
};
syncBuiltinESMExports();
