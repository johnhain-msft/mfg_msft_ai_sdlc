// A small evaluator for the job-level `if:` conditions that gh-aw compiles into a lock file, so that a test can ask
// which jobs of a compiled workflow run for a given set of job results under the GitHub Actions `needs` semantics
// (a live run is out of reach offline). It implements the subset those conditions use: parentheses, `!`, `==`,
// `!=`, `&&`, `||`, string, boolean and null literals, context lookups such as `needs.<job>.result`,
// `needs.<job>.outputs.<name>` and `inputs.<name>`, and the functions always(), cancelled(), failure(), success()
// and contains(). Equality is the loose comparison of the Actions expression language: strings compare
// case-insensitively and operands of different types compare as numbers.

const STATUS_FUNCTIONS = new Set(["always", "cancelled", "failure", "success"]);

function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "'") {
      let value = "";
      index += 1;
      for (;;) {
        if (index >= text.length) throw new Error(`unterminated string in: ${text}`);
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += text[index];
        index += 1;
      }
      tokens.push({ type: "string", value });
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(index));
      tokens.push({ type: "name", value: match[0] });
      index += match[0].length;
    } else if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/.exec(text.slice(index));
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
    } else {
      const two = text.slice(index, index + 2);
      if (["==", "!=", "&&", "||"].includes(two)) {
        tokens.push({ type: "op", value: two });
        index += 2;
      } else if ("()!,.".includes(char)) {
        tokens.push({ type: "op", value: char });
        index += 1;
      } else {
        throw new Error(`unexpected '${char}' in: ${text}`);
      }
    }
  }
  return tokens;
}

/** Recursive-descent parser: `||` binds loosest, then `&&`, then `==` / `!=`, then `!`. */
function parse(text) {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value) => peek()?.type === "op" && peek().value === value;
  const take = (value) => {
    if (!isOp(value)) throw new Error(`expected '${value}' in: ${text}`);
    position += 1;
  };

  const parseOr = () => {
    let left = parseAnd();
    while (isOp("||")) {
      position += 1;
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseEquality();
    while (isOp("&&")) {
      position += 1;
      left = { type: "and", left, right: parseEquality() };
    }
    return left;
  };
  const parseEquality = () => {
    let left = parseUnary();
    while (isOp("==") || isOp("!=")) {
      const operator = peek().value;
      position += 1;
      left = { type: "compare", operator, left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = () => {
    if (isOp("!")) {
      position += 1;
      return { type: "not", operand: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const token = peek();
    if (!token) throw new Error(`unexpected end of: ${text}`);
    if (isOp("(")) {
      position += 1;
      const inner = parseOr();
      take(")");
      return inner;
    }
    position += 1;
    if (token.type === "string" || token.type === "number") return { type: "literal", value: token.value };
    if (token.type !== "name") throw new Error(`unexpected '${token.value}' in: ${text}`);
    if (token.value === "true" || token.value === "false") return { type: "literal", value: token.value === "true" };
    if (token.value === "null") return { type: "literal", value: null };
    if (isOp("(")) {
      position += 1;
      const args = [];
      if (!isOp(")")) {
        args.push(parseOr());
        while (isOp(",")) {
          position += 1;
          args.push(parseOr());
        }
      }
      take(")");
      return { type: "call", name: token.value.toLowerCase(), args };
    }
    const path = [token.value];
    while (isOp(".")) {
      position += 1;
      const next = peek();
      if (next?.type !== "name") throw new Error(`expected a property name in: ${text}`);
      path.push(next.value);
      position += 1;
    }
    return { type: "reference", path };
  };

  const ast = parseOr();
  if (position !== tokens.length) throw new Error(`unexpected '${tokens[position].value}' in: ${text}`);
  return ast;
}

const truthy = (value) => !(value === false || value === null || value === undefined || value === 0 || value === "" || Number.isNaN(value));

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return Number.NaN;
}

function looseEquals(left, right) {
  const kind = (value) => (value === null || value === undefined ? "null" : typeof value);
  if (kind(left) === kind(right)) {
    if (kind(left) === "string") return left.toLowerCase() === right.toLowerCase();
    return kind(left) === "null" ? true : left === right;
  }
  return toNumber(left) === toNumber(right);
}

function evaluate(node, scope) {
  switch (node.type) {
    case "literal":
      return node.value;
    case "reference": {
      let value = scope.context;
      for (const part of node.path) value = value === null || value === undefined ? undefined : value[part];
      return value === undefined ? null : value;
    }
    case "not":
      return !truthy(evaluate(node.operand, scope));
    case "and": {
      const left = evaluate(node.left, scope);
      return truthy(left) ? evaluate(node.right, scope) : left;
    }
    case "or": {
      const left = evaluate(node.left, scope);
      return truthy(left) ? left : evaluate(node.right, scope);
    }
    case "compare": {
      const equal = looseEquals(evaluate(node.left, scope), evaluate(node.right, scope));
      return node.operator === "==" ? equal : !equal;
    }
    case "call": {
      const args = node.args.map((argument) => evaluate(argument, scope));
      if (node.name === "always") return true;
      if (node.name === "cancelled") return scope.cancelled;
      if (node.name === "success") return scope.success;
      if (node.name === "failure") return scope.failure;
      if (node.name === "contains") {
        const [search, item] = args;
        if (Array.isArray(search)) return search.some((entry) => looseEquals(entry, item));
        return String(search ?? "").toLowerCase().includes(String(item ?? "").toLowerCase());
      }
      throw new Error(`the function ${node.name}() is not supported`);
    }
    default:
      throw new Error(`unknown node ${node.type}`);
  }
}

function callsOf(node, found = new Set()) {
  if (node.type === "call") {
    found.add(node.name);
    node.args.forEach((argument) => callsOf(argument, found));
  } else if (node.type === "not") {
    callsOf(node.operand, found);
  } else if (node.left) {
    callsOf(node.left, found);
    callsOf(node.right, found);
  }
  return found;
}

const unwrap = (text) => {
  const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text);
  return (match ? match[1] : text).trim();
};

/** Evaluates one expression with the given context and status-function results. */
export function evaluateExpression(text, { context = {}, success = true, failure = false, cancelled = false } = {}) {
  return truthy(evaluate(parse(unwrap(String(text))), { context, success, failure, cancelled }));
}

const needsOf = (job) => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

/**
 * Which jobs of a compiled workflow run, in the GitHub Actions `needs` semantics: a job without an `if:` (or whose
 * `if:` names no status function) runs only when every job it needs succeeded; otherwise its condition decides.
 * `success()` is true when every needed job succeeded and `failure()` when any ancestor job failed.
 *
 * @param {Record<string, object>} jobs `jobs:` of a lock file
 * @param {{ results?: Record<string,string>, outputs?: Record<string,Record<string,string>>, inputs?: object, cancelled?: boolean }} scenario
 *   `results` is the result of each job that runs (default `success`); a job that does not run is `skipped`.
 * @returns {{ ran: string[], skipped: string[], results: Record<string,string> }}
 */
export function simulateJobs(jobs, { results = {}, outputs = {}, inputs = {}, cancelled = false } = {}) {
  const outcome = {};
  const resolving = new Set();
  const ancestorsOf = (name, found = new Set()) => {
    for (const parent of needsOf(jobs[name])) {
      if (!found.has(parent)) {
        found.add(parent);
        ancestorsOf(parent, found);
      }
    }
    return found;
  };
  const resolve = (name) => {
    if (outcome[name] !== undefined) return outcome[name];
    if (resolving.has(name)) throw new Error(`the needs of ${name} are circular`);
    resolving.add(name);
    const job = jobs[name];
    const needs = needsOf(job);
    for (const parent of needs) resolve(parent);
    const context = {
      needs: Object.fromEntries(needs.map((parent) => [parent, { result: outcome[parent], outputs: outputs[parent] ?? {} }])),
      inputs,
    };
    const success = needs.every((parent) => outcome[parent] === "success");
    const failure = [...ancestorsOf(name)].some((ancestor) => outcome[ancestor] === "failure");
    let runs;
    if (job.if === undefined) {
      runs = success && !cancelled;
    } else {
      const text = unwrap(String(job.if).replace(/\s+/g, " "));
      const hasStatusFunction = [...callsOf(parse(text))].some((call) => STATUS_FUNCTIONS.has(call));
      runs = evaluateExpression(text, { context, success, failure, cancelled });
      if (!hasStatusFunction) runs = runs && success && !cancelled;
    }
    outcome[name] = runs ? results[name] ?? "success" : "skipped";
    resolving.delete(name);
    return outcome[name];
  };
  for (const name of Object.keys(jobs)) resolve(name);
  const ran = Object.keys(outcome).filter((name) => outcome[name] !== "skipped").sort();
  const skipped = Object.keys(outcome).filter((name) => outcome[name] === "skipped").sort();
  return { ran, skipped, results: outcome };
}
