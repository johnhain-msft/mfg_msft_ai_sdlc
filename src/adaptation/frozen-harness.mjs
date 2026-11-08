// The in-process harness of the immutable-gate check (SPEC-04 AC48, AC49).
//
// Running under `node --frozen-intrinsics`, it loads the locked rule and sanitiser modules of the downstream checkout, freezes every value that they
// export (recursively), and only then imports the editable content modules, so that a module that tries to change a locked rule at import time or
// later gets a TypeError instead of a changed rule. It then calls the downstream's own checks directly, in this process: the rule checker over the
// course, the constants that the manifest pins, and the customer-name sanitiser over the text of every changed file.
//
// TypeScript is loaded through the downstream checkout's own `tsx` (its `register()` API, which loads under frozen intrinsics), and, in a checkout
// that has none, through Node's built-in type stripping with a resolver for extensionless specifiers and JSON, which is all that such a checkout needs.

import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { HarnessError } from "./vitest-run.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");

/** True when this process was started with `--frozen-intrinsics`. */
export const intrinsicsAreFrozen = () => Object.isFrozen(Object.prototype) && Object.isFrozen(Array.prototype) && Object.isFrozen(Function.prototype);

/**
 * The `inProcessInvariants` data of an edge, checked. All of it is optional: a workflow that has no course to check names none.
 * @returns {{ frozenModules: string[], course: { module: string, export: string } | null, check: { module: string, export: string } | null,
 *   constants: { module: string, export: string, value: unknown }[], customerTerms: { module: string, export: string } | null }}
 */
export function readInvariants(raw) {
  const label = "immutableGates.inProcessInvariants";
  if (!isObject(raw)) throw new HarnessError(`${label} must be a mapping`);
  const reference = (value, name) => {
    if (value === undefined) return null;
    if (!isObject(value) || typeof value.module !== "string" || typeof value.export !== "string" || value.module === "" || value.export === "") {
      throw new HarnessError(`${label}.${name} needs a module and an export`);
    }
    return { module: value.module, export: value.export };
  };
  if (raw.frozenModules !== undefined && !isStringList(raw.frozenModules)) throw new HarnessError(`${label}.frozenModules must be a list of module paths`);
  const constants = raw.constants ?? [];
  if (!Array.isArray(constants)) throw new HarnessError(`${label}.constants must be a list`);
  return {
    frozenModules: raw.frozenModules ?? [],
    course: reference(raw.course, "course"),
    check: reference(raw.check, "check"),
    constants: constants.map((entry, index) => {
      const ref = reference(entry, `constants[${index}]`);
      if (!Object.hasOwn(entry, "value")) throw new HarnessError(`${label}.constants[${index}] needs the expected value`);
      return { ...ref, value: entry.value };
    }),
    customerTerms: reference(raw.customerTerms, "customerTerms"),
  };
}

const NATIVE_CODE = /\{\s*\[native code\]\s*\}\s*$/;

/** True for the prototype of a built-in (Object.prototype, Map.prototype, ...): frozen intrinsics already froze those, and a test must never freeze one. */
function isBuiltInPrototype(prototype) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return typeof constructor === "function" && NATIVE_CODE.test(Function.prototype.toString.call(constructor));
}

/** `Object.freeze` of a value and, recursively, of everything that its own properties and the prototype of a user-defined class hold. */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
    else {
      deepFreeze(descriptor.get, seen);
      deepFreeze(descriptor.set, seen);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && !Object.isFrozen(prototype) && !isBuiltInPrototype(prototype)) deepFreeze(prototype, seen);
  try {
    Object.freeze(value);
  } catch (error) {
    // a typed array with elements cannot be frozen; everything else can
    if (!ArrayBuffer.isView(value)) throw error;
  }
}

/** Registers the way of loading TypeScript and returns the function that undoes it. */
export function installTypeScriptLoader(portfolio) {
  const require = createRequire(path.join(portfolio, "package.json"));
  let tsx = null;
  try {
    tsx = require("tsx/esm/api");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw new HarnessError(`tsx of ${portfolio} failed to load: ${error?.message ?? error}`);
  }
  if (tsx !== null) {
    const unregister = tsx.register();
    return { kind: "tsx", unregister: () => unregister() };
  }
  if (typeof registerHooks !== "function") throw new HarnessError("this Node.js has no module.registerHooks and the downstream checkout has no tsx: TypeScript cannot be loaded");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!/^\.{1,2}\//.test(specifier) || (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT")) throw error;
        for (const suffix of [".ts", ".mts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // the next suffix
          }
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".json")) {
        return { format: "module", source: `export default ${fs.readFileSync(fileURLToPath(url), "utf8").trim()};\n`, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  return { kind: "native", unregister: () => hooks.deregister() };
}

const normal = (file) => String(file).replace(/\\/g, "/");

/** The repository-relative path of the file that an error came from, read from its stack, or `fallback`. */
function implicatedFile(error, portfolio, fallback) {
  const root = normal(path.resolve(portfolio)).toLowerCase().replace(/\/+$/, "");
  const text = String(error?.stack ?? "");
  for (const match of text.matchAll(/(file:\/\/\/[^\s)]+?|[A-Za-z]:[\\/][^\s):]+?|\/[^\s):]+?)\.(?:[cm]?[jt]sx?)(?=[:)\s]|$)/g)) {
    let candidate = match[0];
    try {
      candidate = candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate;
    } catch {
      continue;
    }
    const absolute = normal(candidate);
    if (absolute.toLowerCase().startsWith(`${root}/`) && !absolute.includes("/node_modules/")) return absolute.slice(root.length + 1);
  }
  return fallback;
}

/**
 * @param {{ portfolio: string, invariants: ReturnType<typeof readInvariants>, editableModules: string[], texts: { file: string, text: string }[] }} input
 * `editableModules` are the repository-relative paths of the changed editable modules that are imported besides the course module.
 * @returns {Promise<{ file: string, message: string }[]>} one entry per violation
 */
export async function runInProcessChecks({ portfolio, invariants, editableModules, texts }) {
  const violations = [];
  const violate = (file, message) => violations.push({ file, message });
  const referenced = [
    ...invariants.frozenModules,
    ...(invariants.check ? [invariants.check.module] : []),
    ...(invariants.customerTerms ? [invariants.customerTerms.module] : []),
    ...invariants.constants.map((entry) => entry.module),
  ];
  const locked = [...new Set(referenced)];
  const nothingToDo = locked.length === 0 && invariants.course === null;
  if (nothingToDo) return violations;
  if (!intrinsicsAreFrozen()) throw new HarnessError("the in-process checks must run under node --frozen-intrinsics");

  const loader = installTypeScriptLoader(portfolio);
  const namespaces = new Map();
  const load = async (relative) => {
    if (!namespaces.has(relative)) namespaces.set(relative, await import(pathToFileURL(path.join(portfolio, ...relative.split("/"))).href));
    return namespaces.get(relative);
  };
  try {
    // 1. the locked modules, loaded and frozen before anything editable is imported
    for (const relative of locked) {
      try {
        const namespace = await load(relative);
        for (const value of Object.values(namespace)) deepFreeze(value);
      } catch (error) {
        violate(implicatedFile(error, portfolio, relative), `the locked module ${relative} cannot be imported: ${error?.message ?? error}`);
      }
    }

    // 2. the editable modules: the course, and every changed module beside it
    let course;
    let courseLoaded = false;
    const imports = [...(invariants.course ? [invariants.course.module] : []), ...editableModules.filter((module) => !locked.includes(module))];
    for (const relative of [...new Set(imports)]) {
      try {
        const namespace = await load(relative);
        if (invariants.course && relative === invariants.course.module) {
          course = namespace[invariants.course.export];
          courseLoaded = true;
        }
      } catch (error) {
        const file = implicatedFile(error, portfolio, relative);
        violate(file, `importing the editable module ${relative} failed${file === relative ? "" : ` in ${file}`} (${error?.name ?? "Error"}): ${error?.message ?? error}`);
      }
    }

    // 3. the invariants, executed here and not in another program
    const valueOf = (reference) => namespaces.get(reference.module)?.[reference.export];
    for (const constant of invariants.constants) {
      const actual = valueOf(constant);
      if (!isDeepStrictEqual(actual, constant.value)) {
        violate(constant.module, `${constant.export} is ${JSON.stringify(actual)}, not the pinned ${JSON.stringify(constant.value)}`);
      }
    }
    if (invariants.check && invariants.course) {
      const check = valueOf(invariants.check);
      if (typeof check !== "function") {
        violate(invariants.check.module, `${invariants.check.export} is not a function`);
      } else if (course === undefined) {
        // when the course module itself could not be imported, that failure is the violation; there is nothing more to say about its export
        if (courseLoaded) violate(invariants.course.module, `${invariants.course.export} is not exported by the course module`);
      } else {
        const changed = editableModules.filter((module) => !locked.includes(module));
        const blame = changed.length > 0 ? changed : [invariants.course.module];
        try {
          const findings = check(course);
          if (!Array.isArray(findings)) {
            for (const file of blame) violate(file, `${invariants.check.export} did not return a list of findings`);
          } else {
            for (const finding of findings) {
              for (const file of blame) violate(file, `${finding?.level ?? "finding"} ${finding?.rule ?? ""} ${finding?.where ?? ""}: ${finding?.message ?? ""}`.replace(/\s+/g, " ").trim());
            }
          }
        } catch (error) {
          violate(implicatedFile(error, portfolio, blame[0]), `${invariants.check.export} threw (${error?.name ?? "Error"}): ${error?.message ?? error}`);
        }
      }
    }
    if (invariants.customerTerms) {
      const find = valueOf(invariants.customerTerms);
      if (typeof find !== "function") {
        violate(invariants.customerTerms.module, `${invariants.customerTerms.export} is not a function`);
      } else {
        for (const { file, text } of texts) {
          let hits;
          try {
            hits = find(text);
          } catch (error) {
            violate(file, `${invariants.customerTerms.export} threw (${error?.name ?? "Error"}): ${error?.message ?? error}`);
            continue;
          }
          if (!Array.isArray(hits)) violate(file, `${invariants.customerTerms.export} did not return a list`);
          else if (hits.length > 0) violate(file, `${invariants.customerTerms.export} found ${hits.length} protected phrase(s)`);
        }
      }
    }
  } finally {
    loader.unregister();
  }
  return violations;
}
