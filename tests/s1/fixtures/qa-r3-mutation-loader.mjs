// Opt-in mutation proof, in memory only: never edit src/ or the repository's workflow artifacts.
//   SDLC_QA_R3_MUTATION=stage-write node --import ./tests/s1/fixtures/qa-r3-mutation-loader.mjs \
//     --test --test-name-pattern="AC10 delta: staged" tests/s1/qa-r3-delta.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const mutations = {
  "instruction-base": [
    "/src/reconcile.mjs",
    "readInstructionFile(context.cwd, audit.instructionsFile);",
    "readInstructionFile(path.dirname(path.resolve(context.cwd, request.manifestPath)), audit.instructionsFile);",
  ],
  "detection-scalar": [
    "/src/reconcile.mjs",
    /\} else if \(!isObj\(detection\)\) \{[\s\S]*?\n      \} else \{/,
    "} else if (isObj(detection)) {",
  ],
  "detection-object": [
    "/src/reconcile.mjs",
    'if (detection["continue-on-error"] !== false)',
    'if (detection["continue-on-error"] === true)',
  ],
  "detection-enabled": [
    "/src/reconcile.mjs",
    "if (detection.enabled !== undefined && detection.enabled !== true)",
    "if (detection.enabled === false)",
  ],
  "copy-spy": [
    "/tests/s1/helpers/fs-spy.mjs",
    'if (name === "copyFileSync" || name === "cpSync")',
    "if (false)",
  ],
  "stage-write": [
    "/src/reconcile.mjs",
    "writeRendered(stage, prepared.files);",
    "writeRendered(prepared.cwd, prepared.files);",
  ],
  "stage-error": [
    "/src/reconcile.mjs",
    'const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-reconcile-"));',
    'let stage; try { stage = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-reconcile-")); } catch { return finish(prepared, []); }',
  ],
  "path-end-anchor": [
    "/src/reconcile.mjs",
    'const allowed = `^(${edge.allowedFiles.map(allowedFileEre).join("|")})$`;',
    'const allowed = `^(${edge.allowedFiles.map(allowedFileEre).join("|")})`;',
  ],
  "bash-engine": [
    "/src/reconcile.mjs",
    'return BASH_ALLOWLIST_ENGINES.has(engineSection(ctx, { sdk: false }).id) ? bashAllowlist(commands) : ["*"];',
    "return bashAllowlist(commands);",
  ],
};

const selected = process.env.SDLC_QA_R3_MUTATION;
if (selected) {
  assert.ok(Object.hasOwn(mutations, selected), `unknown QA mutation: ${selected}`);
  const [suffix, before, after] = mutations[selected];
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith(suffix)) return loaded;
      const source = String(loaded.source);
      const mutated = source.replace(before, after);
      assert.notEqual(mutated, source, `QA mutation ${selected} must actually change its target`);
      return { ...loaded, source: mutated };
    },
  });
}
