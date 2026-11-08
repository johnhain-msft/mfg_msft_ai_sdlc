// The structure of a test file and the constructs that a change must not add (SPEC-04 AC43-AC47).
//
// The check works on the tokens of `ts-scan.mjs`, not on text patterns: a quote style of a title, a comment, a string that mentions `it(` and a template
// literal never change what is found. Nothing here names a repository, a path or a title: the titles, the files and the locked modules are passed in.

import { resolveRelative, stripExtension } from "./paths.mjs";
import { matchingBracket, scan } from "./ts-scan.mjs";

const SUITE_NAMES = new Set(["describe", "it", "test"]);
const ASSIGNMENT = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "with", "function", "return", "typeof", "await", "yield", "new", "delete", "void", "throw", "case", "else", "do", "in", "of", "instanceof", "import", "export"]);
const LINE_CONTINUATION = new Set([".", "?.", "(", "[", ",", "?", ":", "+", "-", "*", "/", "%", "**", "&", "|", "^", "&&", "||", "??", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "=>"]);

const isMember = (tokens, i) => tokens[i - 1]?.type === "punct" && (tokens[i - 1].value === "." || tokens[i - 1].value === "?.");
const isPunct = (token, value) => token?.type === "punct" && token.value === value;
const isTitleToken = (token) => token !== undefined && (token.type === "string" || (token.type === "template" && token.text !== undefined));

// ---------------------------------------------------------------------------------------
// Test files: the prelude, the describe( headers and the named blocks
// ---------------------------------------------------------------------------------------

/** Every call of `describe`, `it` and `test` in a scan, in source order. A plain call (`it("title", ...)`) carries its title and its full extent. */
export function suiteCalls(scanned) {
  const { tokens } = scanned;
  const calls = [];
  tokens.forEach((token, i) => {
    if (token.type !== "ident" || !SUITE_NAMES.has(token.value) || isMember(tokens, i)) return;
    const next = tokens[i + 1];
    if (isPunct(next, "(")) {
      const close = matchingBracket(tokens, i + 1);
      if (close === -1) return;
      const end = isPunct(tokens[close + 1], ";") ? tokens[close + 1].end : tokens[close].end;
      const first = tokens[i + 2];
      const title = isTitleToken(first) && (isPunct(tokens[i + 3], ",") || isPunct(tokens[i + 3], ")")) ? first.text : null;
      calls.push({ name: token.value, form: "plain", title, start: token.start, end, line: token.line });
    } else if (isPunct(next, ".") || isPunct(next, "?.")) {
      calls.push({ name: token.value, form: "chained", title: null, start: token.start, end: token.end, line: token.line });
    }
  });
  return calls;
}

/**
 * The parts of a test file that the lock covers: the prelude (everything before the line of the first `describe(`, or of the first `it(` or `test(` when
 * there is no describe), the header line of every describe in order, and the calls of every suite function.
 */
export function analyzeTestFile(text) {
  const scanned = scan(text);
  const calls = suiteCalls(scanned);
  const first = calls.find((call) => call.name === "describe") ?? calls[0];
  return {
    text,
    scanned,
    calls,
    prelude: first === undefined ? text : text.slice(0, scanned.lineStart(first.line)),
    describeHeaders: calls.filter((call) => call.name === "describe").map((call) => text.slice(scanned.lineStart(call.line), scanned.lineEnd(call.line))),
  };
}

/** The exact source text of every `it(<title>, ...)` or `describe(<title>, ...)` call of the given title, in source order. */
export function blockTexts(analysis, kind, title) {
  return analysis.calls.filter((call) => call.form === "plain" && call.name === kind && call.title === title).map((call) => analysis.text.slice(call.start, call.end));
}

const same = (a, b) => a.length === b.length && a.every((entry, index) => entry === b[index]);

/** The text of the import declaration of each import binding of the given local name. */
function importTexts(analysis, name) {
  return parseImports(analysis.scanned)
    .filter((entry) => entry.bindings.some((binding) => binding.local === name))
    .map((entry) => analysis.text.slice(entry.start, entry.end));
}

/**
 * What differs between the base and the head of a companion test file, as one message per difference (none: the lock holds).
 * @param {{ baseText: string, headText: string, blocks: { kind: string, title: string }[], lockedImports?: string[] }} input
 */
export function compareStructure({ baseText, headText, blocks, lockedImports = [] }) {
  const problems = [];
  const base = analyzeTestFile(baseText);
  const head = analyzeTestFile(headText);
  if (base.prelude !== head.prelude) problems.push("the imports and the lines before the first describe( differ from the base");
  if (!same(base.describeHeaders, head.describeHeaders)) problems.push("the describe( header lines differ from the base");
  for (const { kind, title } of blocks) {
    const label = `${kind}(${JSON.stringify(title)})`;
    const before = blockTexts(base, kind, title);
    const after = blockTexts(head, kind, title);
    if (before.length === 0) problems.push(`${label} is missing in the base`);
    if (after.length === 0) problems.push(`${label} is missing in the head`);
    else if (before.length > 0 && !same(before, after)) problems.push(`${label} differs from the base`);
  }
  for (const name of lockedImports) {
    const before = importTexts(base, name);
    const after = importTexts(head, name);
    if (before.length === 0) problems.push(`the import of ${name} is missing in the base`);
    if (after.length === 0) problems.push(`the import of ${name} is missing in the head`);
    else if (before.length > 0 && !same(before, after)) problems.push(`the import of ${name} differs from the base`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------

/**
 * Every static import, re-export, dynamic import of a string and `require` of a string in a scan.
 * @returns {{ kind: string, specifier: string, bindings: { local: string, imported: string }[], start: number, end: number }[]}
 */
export function parseImports(scanned) {
  const { tokens } = scanned;
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "ident" || isMember(tokens, i)) continue;
    if (token.value === "require" && isPunct(tokens[i + 1], "(") && isTitleToken(tokens[i + 2]) && isPunct(tokens[i + 3], ")")) {
      found.push({ kind: "require", specifier: tokens[i + 2].text, bindings: [], start: token.start, end: tokens[i + 3].end });
      continue;
    }
    if (token.value === "import") {
      const next = tokens[i + 1];
      if (isPunct(next, "(")) {
        const close = matchingBracket(tokens, i + 1);
        if (isTitleToken(tokens[i + 2]) && (isPunct(tokens[i + 3], ")") || isPunct(tokens[i + 3], ","))) {
          found.push({ kind: "dynamic", specifier: tokens[i + 2].text, bindings: [], start: token.start, end: close === -1 ? tokens[i + 2].end : tokens[close].end });
        }
        continue;
      }
      if (isPunct(next, ".")) continue;
      const parsed = parseImportClause(tokens, i + 1);
      if (parsed !== null) found.push({ kind: "import", specifier: parsed.specifier, bindings: parsed.bindings, start: token.start, end: parsed.end });
      continue;
    }
    if (token.value === "export" && (isPunct(tokens[i + 1], "*") || isPunct(tokens[i + 1], "{"))) {
      let j = i + 1;
      if (isPunct(tokens[j], "*")) {
        j += 1;
        if (tokens[j]?.value === "as" && tokens[j + 1]?.type === "ident") j += 2;
      } else {
        const close = matchingBracket(tokens, j);
        if (close === -1) continue;
        j = close + 1;
      }
      if (tokens[j]?.type === "ident" && tokens[j].value === "from" && isTitleToken(tokens[j + 1])) {
        found.push({ kind: "reexport", specifier: tokens[j + 1].text, bindings: [], start: token.start, end: isPunct(tokens[j + 2], ";") ? tokens[j + 2].end : tokens[j + 1].end });
      }
    }
  }
  return found;
}

function parseImportClause(tokens, start) {
  let j = start;
  const bindings = [];
  const finish = (specifierToken) => ({ specifier: specifierToken.text, bindings, end: isPunct(tokens[tokens.indexOf(specifierToken) + 1], ";") ? tokens[tokens.indexOf(specifierToken) + 1].end : specifierToken.end });
  if (isTitleToken(tokens[j])) return finish(tokens[j]);
  if (tokens[j]?.type === "ident" && tokens[j].value === "type" && tokens[j + 1] !== undefined && tokens[j + 1].value !== "from" && (tokens[j + 1].type === "ident" || isPunct(tokens[j + 1], "{") || isPunct(tokens[j + 1], "*"))) j += 1;
  if (tokens[j]?.type === "ident" && tokens[j].value !== "from") {
    if (isPunct(tokens[j + 1], "=") && tokens[j + 2]?.value === "require" && isPunct(tokens[j + 3], "(") && isTitleToken(tokens[j + 4])) {
      bindings.push({ local: tokens[j].value, imported: "=" });
      return finish(tokens[j + 4]);
    }
    bindings.push({ local: tokens[j].value, imported: "default" });
    j += 1;
    if (isPunct(tokens[j], ",")) j += 1;
  }
  if (isPunct(tokens[j], "*")) {
    if (tokens[j + 1]?.value === "as" && tokens[j + 2]?.type === "ident") {
      bindings.push({ local: tokens[j + 2].value, imported: "*" });
      j += 3;
    } else return null;
  } else if (isPunct(tokens[j], "{")) {
    const close = matchingBracket(tokens, j);
    if (close === -1) return null;
    let k = j + 1;
    while (k < close) {
      if (tokens[k].type === "ident" && tokens[k].value === "type" && tokens[k + 1]?.type === "ident" && tokens[k + 1].value !== "as") k += 1;
      if (tokens[k].type === "ident" || tokens[k].type === "string") {
        const imported = tokens[k].type === "string" ? tokens[k].text : tokens[k].value;
        if (tokens[k + 1]?.value === "as" && tokens[k + 2]?.type === "ident") {
          bindings.push({ local: tokens[k + 2].value, imported });
          k += 3;
        } else {
          bindings.push({ local: imported, imported });
          k += 1;
        }
      } else k += 1;
    }
    j = close + 1;
  }
  if (tokens[j]?.type === "ident" && tokens[j].value === "from" && isTitleToken(tokens[j + 1])) return finish(tokens[j + 1]);
  return null;
}

// ---------------------------------------------------------------------------------------
// Binding names, for the shadowing check
// ---------------------------------------------------------------------------------------

/** Index of the first token at or after `i` that ends an expression: a `,` or `;` at depth 0, or a closing bracket that closes an outer bracket. */
function skipExpression(tokens, i, end = tokens.length) {
  let depth = 0;
  for (let j = i; j < end; j += 1) {
    const token = tokens[j];
    if (token.type === "punct") {
      if (token.value === "(" || token.value === "[" || token.value === "{") depth += 1;
      else if (token.value === ")" || token.value === "]" || token.value === "}") {
        if (depth === 0) return j;
        depth -= 1;
      } else if (depth === 0 && (token.value === "," || token.value === ";")) return j;
    }
    if (depth === 0 && j > i && tokens[j - 1] !== undefined && tokens[j].line > tokens[j - 1].line) {
      const previous = tokens[j - 1];
      const endsValue = ["ident", "number", "string", "template", "regex"].includes(previous.type) || [")", "]", "}"].includes(previous.value);
      const continues = (token.type === "punct" && LINE_CONTINUATION.has(token.value)) || token.type === "template" || (token.type === "ident" && ["instanceof", "in", "as", "satisfies"].includes(token.value));
      if (endsValue && !continues) return j;
    }
  }
  return end;
}

/** The names that one binding target declares (`a`, `{ a, b: c, ...d }`, `[a, , b]`), and the index after it. */
function patternNames(tokens, i) {
  const token = tokens[i];
  if (token === undefined) return { names: [], next: i };
  if (token.type === "ident") return { names: [token.value], next: i + 1 };
  const open = token.type === "punct" && (token.value === "{" || token.value === "[") ? token.value : null;
  if (open === null) return { names: [], next: i + 1 };
  const close = matchingBracket(tokens, i);
  const end = close === -1 ? tokens.length : close;
  const names = [];
  let j = i + 1;
  while (j < end) {
    if (isPunct(tokens[j], "...")) j += 1;
    if (j >= end) break;
    if (open === "[") {
      if (isPunct(tokens[j], ",")) {
        j += 1;
        continue;
      }
      const inner = patternNames(tokens, j);
      names.push(...inner.names);
      j = Math.max(inner.next, j + 1);
    } else {
      const key = tokens[j];
      if (isPunct(key, "[")) {
        const keyClose = matchingBracket(tokens, j);
        j = keyClose === -1 ? end : keyClose + 1;
      } else {
        j += 1;
      }
      if (isPunct(tokens[j], ":")) {
        const inner = patternNames(tokens, j + 1);
        names.push(...inner.names);
        j = Math.max(inner.next, j + 1);
      } else if (key.type === "ident") {
        names.push(key.value);
      }
    }
    if (isPunct(tokens[j], "=")) j = skipExpression(tokens, j + 1, end);
    if (isPunct(tokens[j], ",")) j += 1;
  }
  return { names, next: close === -1 ? end : close + 1 };
}

/** Skips a type annotation that starts after its colon: to the next `,` or `=` that is not inside brackets or angle brackets. */
function skipType(tokens, i, end) {
  let depth = 0;
  let angle = 0;
  for (let j = i; j < end; j += 1) {
    const token = tokens[j];
    if (token.type !== "punct") continue;
    if (token.value === "(" || token.value === "[" || token.value === "{") depth += 1;
    else if (token.value === ")" || token.value === "]" || token.value === "}") depth -= 1;
    else if (token.value === "<") angle += 1;
    else if (token.value === ">") angle = Math.max(0, angle - 1);
    else if (depth === 0 && angle === 0 && (token.value === "," || token.value === "=" || token.value === ";")) return j;
  }
  return end;
}

/** The names that a parameter list declares, given the index of its opening parenthesis. */
function parameterNames(tokens, open) {
  const close = matchingBracket(tokens, open);
  if (close === -1) return [];
  const names = [];
  let j = open + 1;
  while (j < close) {
    if (isPunct(tokens[j], "...")) j += 1;
    while (tokens[j]?.type === "ident" && ["public", "private", "protected", "readonly", "override"].includes(tokens[j].value) && tokens[j + 1]?.type === "ident") j += 1;
    const before = j;
    const { names: found, next } = patternNames(tokens, j);
    names.push(...found);
    j = next;
    if (isPunct(tokens[j], "?")) j += 1;
    if (isPunct(tokens[j], ":")) j = skipType(tokens, j + 1, close);
    if (isPunct(tokens[j], "=")) j = skipExpression(tokens, j + 1, close);
    if (isPunct(tokens[j], ",")) j += 1;
    else if (j === before) j += 1;
  }
  return names;
}

/** Index of the `(` that the `)` at `closeIndex` closes, or -1. */
function matchingOpen(tokens, closeIndex) {
  let depth = 0;
  for (let j = closeIndex; j >= 0; j -= 1) {
    if (tokens[j].type !== "punct") continue;
    if (tokens[j].value === ")") depth += 1;
    else if (tokens[j].value === "(") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Every name that the code binds, by a declaration, a function or class, a parameter list or a catch clause (not by an import). */
export function boundNames(scanned) {
  const { tokens } = scanned;
  const names = [];
  tokens.forEach((token, i) => {
    if (token.type === "ident" && !isMember(tokens, i)) {
      if (token.value === "const" || token.value === "let" || token.value === "var") {
        let j = i + 1;
        for (let guard = 0; guard < 64 && j < tokens.length; guard += 1) {
          const { names: found, next } = patternNames(tokens, j);
          names.push(...found);
          j = next;
          if (tokens[j]?.type === "ident" && (tokens[j].value === "of" || tokens[j].value === "in")) break;
          let angle = 0;
          let afterEquals = false;
          let k = j;
          for (; k < tokens.length; k += 1) {
            const current = tokens[k];
            if (current.type === "punct") {
              if (!afterEquals && current.value === "=") afterEquals = true;
              if (!afterEquals && current.value === "<") angle += 1;
              if (!afterEquals && current.value === ">") angle = Math.max(0, angle - 1);
              if (angle === 0 && (current.value === "," || current.value === ";")) break;
              if (current.value === "(" || current.value === "[" || current.value === "{") {
                const close = matchingBracket(tokens, k);
                if (close === -1) break;
                k = close;
                continue;
              }
              if (current.value === ")" || current.value === "]" || current.value === "}") break;
            }
            if (k > j && current.line > tokens[k - 1].line && afterEquals) {
              const previous = tokens[k - 1];
              const endsValue = ["ident", "number", "string", "template", "regex"].includes(previous.type) || [")", "]", "}"].includes(previous.value);
              const continues = (current.type === "punct" && LINE_CONTINUATION.has(current.value)) || current.type === "template" || (current.type === "ident" && ["instanceof", "in", "as", "satisfies"].includes(current.value));
              if (endsValue && !continues) break;
            }
          }
          j = k;
          if (isPunct(tokens[j], ",")) j += 1;
          else break;
        }
      } else if (token.value === "function") {
        let j = i + 1;
        if (isPunct(tokens[j], "*")) j += 1;
        if (tokens[j]?.type === "ident" && !isPunct(tokens[j + 1], ".")) {
          names.push(tokens[j].value);
          j += 1;
        }
        if (isPunct(tokens[j], "<")) {
          while (j < tokens.length && !isPunct(tokens[j], ">")) j += 1;
          j += 1;
        }
        if (isPunct(tokens[j], "(")) names.push(...parameterNames(tokens, j));
      } else if (["class", "enum", "namespace"].includes(token.value) && tokens[i + 1]?.type === "ident" && !["extends", "implements"].includes(tokens[i + 1].value)) {
        names.push(tokens[i + 1].value);
      } else if (token.value === "catch" && isPunct(tokens[i + 1], "(")) {
        names.push(...parameterNames(tokens, i + 1));
      } else if (!CONTROL_WORDS.has(token.value) && isPunct(tokens[i + 1], "(")) {
        // a method (`name(a, b) {`); a function declaration was handled by its keyword, which comes right before its name
        const named = tokens[i - 1]?.value === "function" || (isPunct(tokens[i - 1], "*") && tokens[i - 2]?.value === "function");
        const close = matchingBracket(tokens, i + 1);
        if (!named && close !== -1 && isPunct(tokens[close + 1], "{")) names.push(...parameterNames(tokens, i + 1));
      }
    }
    if (isPunct(token, "=>")) {
      const before = tokens[i - 1];
      if (isPunct(before, ")")) {
        const open = matchingOpen(tokens, i - 1);
        if (open !== -1) names.push(...parameterNames(tokens, open));
      } else if (before?.type === "ident" && !isMember(tokens, i - 1) && !isPunct(tokens[i - 2], ":")) {
        // `x => ...`; a name after a colon is the return type of an arrow function (`(a): string => ...`), not a parameter
        names.push(before.value);
      }
    }
  });
  return names;
}

// ---------------------------------------------------------------------------------------
// The constructs that a change must not add
// ---------------------------------------------------------------------------------------

/** The constructs of AC47, in the order that a report lists them. */
export const CONSTRUCTS = [".skip", ".only", ".todo", "vi.mock", "Object.assign", "Object.defineProperty", "Reflect", "property mutation", "new import of a locked module", "shadowing of an imported identifier"];

const BANNED_PROPERTIES = new Map([["skip", ".skip"], ["only", ".only"], ["todo", ".todo"]]);

const membersAfter = (tokens, i) => {
  // the members of the chain that starts after the identifier at i: `.a`, `?.a`, `["a"]`; returns the index after the chain and how many members it has
  let j = i + 1;
  let members = 0;
  for (;;) {
    if ((isPunct(tokens[j], ".") || isPunct(tokens[j], "?.")) && tokens[j + 1]?.type === "ident") {
      j += 2;
      members += 1;
    } else if (isPunct(tokens[j], "[")) {
      const close = matchingBracket(tokens, j);
      if (close === -1) break;
      j = close + 1;
      members += 1;
    } else break;
  }
  return { next: j, members };
};

/**
 * How often each construct occurs in a source text. `lockedModules` are the paths (without an extension) of the modules whose import is banned and
 * whose imported identifiers must not be mutated or shadowed; `filePath` is the repository-relative path of the text, to resolve its imports.
 * @returns {Record<string, number>}
 */
export function countConstructs(text, { filePath, lockedModules }) {
  const scanned = scan(text);
  const { tokens } = scanned;
  const counts = Object.fromEntries(CONSTRUCTS.map((name) => [name, 0]));
  const locked = new Set(lockedModules.map(stripExtension));

  tokens.forEach((token, i) => {
    if (isPunct(token, ".") || isPunct(token, "?.")) {
      const name = tokens[i + 1];
      if (name?.type === "ident" && BANNED_PROPERTIES.has(name.value)) counts[BANNED_PROPERTIES.get(name.value)] += 1;
    } else if (isPunct(token, "[") && tokens[i + 1]?.type === "string" && isPunct(tokens[i + 2], "]") && i > 0) {
      const previous = tokens[i - 1];
      const afterValue = previous.type === "ident" || isPunct(previous, ")") || isPunct(previous, "]");
      if (afterValue && BANNED_PROPERTIES.has(tokens[i + 1].text)) counts[BANNED_PROPERTIES.get(tokens[i + 1].text)] += 1;
    }
    if (token.type !== "ident" || isMember(tokens, i)) return;
    const member = isPunct(tokens[i + 1], ".") || isPunct(tokens[i + 1], "?.") ? tokens[i + 2] : isPunct(tokens[i + 1], "[") ? tokens[i + 2] : undefined;
    const memberName = member?.type === "ident" ? member.value : member?.type === "string" ? member.text : undefined;
    if (token.value === "vi" && (memberName === "mock" || memberName === "doMock")) counts["vi.mock"] += 1;
    else if (token.value === "Object" && memberName === "assign") counts["Object.assign"] += 1;
    else if (token.value === "Object" && memberName === "defineProperty") counts["Object.defineProperty"] += 1;
    else if (token.value === "Reflect" && !isPunct(tokens[i + 1], ":")) counts.Reflect += 1;
  });

  // imports of the locked modules, and the identifiers that they introduce
  const imports = parseImports(scanned);
  const lockedNames = new Set();
  for (const entry of imports) {
    const target = resolveRelative(filePath, entry.specifier);
    if (target === null || !locked.has(target)) continue;
    counts["new import of a locked module"] += 1;
    for (const binding of entry.bindings) lockedNames.add(binding.local);
  }

  if (lockedNames.size > 0) {
    tokens.forEach((token, i) => {
      if (token.type !== "ident" || !lockedNames.has(token.value) || isMember(tokens, i)) return;
      const { next, members } = membersAfter(tokens, i);
      if (members === 0) return;
      const after = tokens[next];
      const before = tokens[i - 1];
      const assigned = after?.type === "punct" && (ASSIGNMENT.has(after.value) || after.value === "++" || after.value === "--");
      const prefixed = before?.type === "punct" && (before.value === "++" || before.value === "--");
      const deleted = before?.type === "ident" && before.value === "delete";
      if (assigned || prefixed || deleted) counts["property mutation"] += 1;
    });
    for (const name of boundNames(scanned)) if (lockedNames.has(name)) counts["shadowing of an imported identifier"] += 1;
    for (const entry of imports) {
      const target = resolveRelative(filePath, entry.specifier);
      if (target !== null && locked.has(target)) continue;
      for (const binding of entry.bindings) if (lockedNames.has(binding.local)) counts["shadowing of an imported identifier"] += 1;
    }
  }
  return counts;
}

/** The constructs whose count in the head exceeds their count in the base: [{ construct, base, head }]. */
export function addedConstructs(baseCounts, headCounts) {
  return CONSTRUCTS.filter((name) => headCounts[name] > baseCounts[name]).map((name) => ({ construct: name, base: baseCounts[name], head: headCounts[name] }));
}
