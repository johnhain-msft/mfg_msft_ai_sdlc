#!/usr/bin/env node
// Recording stand-ins for `gh` and `git` for the tests/s1 suite, so that no test talks to GitHub.
//
//   node shim-runner.mjs <gh|git> <args...>
//
// The behaviour is configured by the JSON file named in SDLC_SHIM_CONFIG. Every invocation is
// appended to the JSONL log named there. `gh aw compile` is replaced by a compiler stub whose
// behaviour is selected by `compile.mode`; `git` is logged and then handed to the real binary.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const STUB_LOCK_HEADER = "# stub compiler output (tests/s1/helpers/shim-runner.mjs)";

/** What the stub compiler writes for a workflow source: a pure function of its name and bytes. */
export function stubLockContent(sourceName, sourceBytes) {
  const digest = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  return `${STUB_LOCK_HEADER}\n# source: ${sourceName}\n# sha256: ${digest}\n`;
}

function listSources(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) return [];
  return fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".md") && fs.statSync(path.join(workflowsDir, name)).isFile())
    .sort();
}

function runCompile(args, settings, cwd) {
  const mode = settings.mode ?? "ok";
  const noEmit = args.includes("--no-emit");
  const purge = args.includes("--purge");
  for (const flag of ["--strict", "--json"]) {
    if (!args.includes(flag)) {
      process.stderr.write(`stub compiler: the required flag ${flag} is missing\n`);
      return 4;
    }
  }
  if (!noEmit && !purge) {
    process.stderr.write("stub compiler: a real run must pass --purge\n");
    return 4;
  }
  const workflowsDir = path.join(cwd, ".github", "workflows");
  const sources = listSources(workflowsDir);
  const lockName = (name) => name.replace(/\.md$/, ".lock.yml");
  const writeLock = (name) =>
    fs.writeFileSync(
      path.join(workflowsDir, lockName(name)),
      settings.lockContent ?? stubLockContent(name, fs.readFileSync(path.join(workflowsDir, name))),
    );
  const purgeOrphans = () => {
    for (const entry of fs.readdirSync(workflowsDir)) {
      if (entry.endsWith(".lock.yml") && !sources.includes(entry.replace(/\.lock\.yml$/, ".md"))) {
        fs.rmSync(path.join(workflowsDir, entry), { force: true });
      }
    }
  };
  const generated = () =>
    sources.map((name) => ({
      workflow: name,
      valid: true,
      errors: [],
      warnings: [],
      ...(noEmit ? {} : { compiled_file: path.join(workflowsDir, lockName(name)) }),
      labels: [],
    }));
  const print = (value) => process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  const recorded = () => fs.readFileSync(settings.outputFile, "utf8");

  const writeSideFiles = () => {
    fs.mkdirSync(path.join(cwd, ".github", "aw"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".github", "aw", "actions-lock.json"), `{"entries":{"stub/action@v1":"0000000000000000000000000000000000000000"}}\n`);
    fs.writeFileSync(path.join(cwd, ".gitattributes"), ".github/workflows/*.lock.yml linguist-generated=true merge=ours\n");
  };

  switch (mode) {
    case "ok":
    case "ok-recorded":
    case "maintenance":
    case "no-locks":
    case "unsupported-protected-files": {
      if (mode === "unsupported-protected-files") {
        const configPath = path.join(workflowsDir, "aw.json");
        if (fs.existsSync(configPath) && fs.readFileSync(configPath, "utf8").includes("protected_files")) {
          process.stderr.write("error: repository config validation failed: additional properties 'protected_files' not allowed\n");
          return 1;
        }
      }
      if (!noEmit && mode !== "no-locks") {
        sources.filter((name) => !(settings.skip ?? []).includes(name)).forEach(writeLock);
        purgeOrphans();
        if (settings.sideFiles) writeSideFiles();
        if (mode === "maintenance") {
          fs.writeFileSync(path.join(workflowsDir, "agentics-maintenance-example-owner-example-repo.yml"), "name: stub maintenance\n");
        }
      }
      print(mode === "ok-recorded" ? recorded() : generated());
      return 0;
    }
    case "error-recorded": {
      print(recorded());
      return 1;
    }
    case "partial-error": {
      if (sources.length > 0) fs.writeFileSync(path.join(workflowsDir, lockName(sources[0])), "# partial output of an interrupted compile\n");
      purgeOrphans();
      if (settings.sideFiles) writeSideFiles();
      print(recorded());
      return 1;
    }
    case "crash": {
      process.stderr.write("panic: stub compiler crashed\n");
      return 2;
    }
    case "not-json": {
      print("compiled everything\n");
      return 0;
    }
    default: {
      process.stderr.write(`stub compiler: unknown mode ${mode}\n`);
      return 5;
    }
  }
}

function main() {
  const [tool, ...args] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(process.env.SDLC_SHIM_CONFIG, "utf8"));
  fs.appendFileSync(config.logPath, `${JSON.stringify({ tool, args, cwd: process.cwd() })}\n`);
  if (tool === "git") {
    const outcome = spawnSync(config.realGit, args, { stdio: "inherit", cwd: process.cwd() });
    process.exitCode = outcome.status ?? 1;
    return;
  }
  if (tool === "gh" && args[0] === "aw" && args[1] === "compile") {
    process.exitCode = runCompile(args, config.compile ?? {}, process.cwd());
    return;
  }
  process.stderr.write(`shim: unexpected ${tool} invocation: ${args.join(" ")}\n`);
  process.exitCode = 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
