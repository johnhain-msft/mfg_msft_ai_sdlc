// A reader for the subset of YAML that the fleet manifest (sdlc.yaml) uses.
//
// The pre-agent steps of a drift workflow run before any `npm ci`, so the `yaml` package may not be installed. This
// reader is the fallback of `yaml-load.mjs`: it has no dependency and it fails loudly (never guesses) on a construct it
// does not support. Supported: block mappings and sequences (a sequence may sit at the indentation of its key), compact
// `- key: value` mappings, one-line and multi-line flow collections, plain, single-quoted and double-quoted scalars
// (multi-line too), block scalars (| and >, with chomping and indentation indicators) and comments.
// Not supported, and refused: anchors, aliases, tags, directives, complex keys, tabs as indentation, several documents.
// Scalars resolve as in the YAML 1.2 core schema, which is what the `yaml` package does by default.

export class YamlSubsetError extends Error {
  constructor(message) {
    super(message);
    this.name = "YamlSubsetError";
  }
}

const SEQUENCE_ENTRY = /^-(?:\s|$)/;

const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029" };

/** A plain scalar as the YAML 1.2 core schema resolves it. */
export function resolvePlain(text) {
  if (text === "" || text === "~" || /^(?:null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return Number.NaN;
  return text;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function setKey(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The text without its trailing comment (a # that follows white space), for a scalar that is not quoted. */
function stripComment(text) {
  const match = /(?:^|\s)#/.exec(text);
  return (match === null ? text : text.slice(0, match.index)).trimEnd();
}

class Reader {
  constructor(text) {
    this.lines = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    this.index = 0;
  }

  fail(message, line = this.index) {
    throw new YamlSubsetError(`line ${line + 1}: ${message}`);
  }

  indentOf(line, at = this.index, { allowTab = false } = {}) {
    let count = 0;
    while (count < line.length && line[count] === " ") count += 1;
    if (!allowTab && line[count] === "\t" && line.slice(count).trim() !== "") this.fail("a tab is not allowed as indentation", at);
    return count;
  }

  isTrivia(line) {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  }

  /** The next line that holds content: { indent, text, index }, or null at the end. */
  peek() {
    let at = this.index;
    while (at < this.lines.length && this.isTrivia(this.lines[at])) at += 1;
    if (at >= this.lines.length) return null;
    const line = this.lines[at];
    const indent = this.indentOf(line, at);
    return { indent, text: line.slice(indent), index: at };
  }

  parseDocument() {
    let first = this.peek();
    if (first !== null && /^---(?:\s|$)/.test(first.text)) {
      const rest = first.text.slice(3).trim();
      if (rest !== "" && !rest.startsWith("#")) this.fail("content on the document start line is not supported", first.index);
      this.index = first.index + 1;
      first = this.peek();
    }
    if (first === null) return null;
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(first.text)) this.fail("several documents are not supported", first.index);
    const value = this.parseNode(-1);
    const rest = this.peek();
    if (rest !== null) {
      if (/^\.\.\.(?:\s|$)/.test(rest.text)) return value;
      this.fail("unexpected content after the document", rest.index);
    }
    return value;
  }

  /** A node that is indented deeper than `parentIndent`, or null when there is none. */
  parseNode(parentIndent) {
    const next = this.peek();
    if (next === null || next.indent <= parentIndent) return null;
    if (SEQUENCE_ENTRY.test(next.text)) return this.parseSequence(next.indent);
    if (this.mapEntry(next.text, next.index) !== null) return this.parseMapping(next.indent);
    this.index = next.index + 1;
    return this.parseInline(next.text, { parentIndent, lineIndex: next.index });
  }

  parseSequence(indent) {
    const result = [];
    for (;;) {
      const next = this.peek();
      if (next === null || next.indent < indent) break;
      if (next.indent > indent) this.fail("unexpected indentation", next.index);
      if (!SEQUENCE_ENTRY.test(next.text)) break;
      const after = next.text.slice(1);
      const rest = after.trimStart();
      const column = indent + 1 + (after.length - rest.length);
      if (rest === "" || rest.startsWith("#")) {
        this.index = next.index + 1;
        result.push(this.parseNode(indent));
      } else if (SEQUENCE_ENTRY.test(rest) || this.mapEntry(rest, next.index) !== null) {
        this.lines[next.index] = `${" ".repeat(column)}${rest}`;
        this.index = next.index;
        result.push(SEQUENCE_ENTRY.test(rest) ? this.parseSequence(column) : this.parseMapping(column));
      } else {
        this.index = next.index + 1;
        result.push(this.parseInline(rest, { parentIndent: indent, lineIndex: next.index }));
      }
    }
    return result;
  }

  parseMapping(indent) {
    const result = {};
    for (;;) {
      const next = this.peek();
      if (next === null || next.indent < indent) break;
      if (next.indent > indent) this.fail("unexpected indentation", next.index);
      const entry = this.mapEntry(next.text, next.index);
      if (entry === null) {
        if (SEQUENCE_ENTRY.test(next.text)) this.fail("a sequence entry where a key was expected", next.index);
        this.fail("a key was expected", next.index);
      }
      if (hasOwn(result, entry.key)) this.fail(`duplicate key '${entry.key}'`, next.index);
      this.index = next.index + 1;
      let value;
      const rest = entry.rest;
      if (rest === "" || rest.startsWith("#")) {
        const following = this.peek();
        if (following !== null && following.indent === indent && SEQUENCE_ENTRY.test(following.text)) value = this.parseSequence(indent);
        else value = this.parseNode(indent);
      } else {
        value = this.parseInline(rest, { parentIndent: indent, lineIndex: next.index });
      }
      setKey(result, entry.key, value);
    }
    return result;
  }

  /** `key: rest` at the start of a line: { key, rest }, or null when the text is not a mapping entry. */
  mapEntry(text, at) {
    const first = text[0];
    if (first === '"' || first === "'") {
      const scanned = scanQuoted(text, first);
      if (scanned === null) return null;
      const after = text.slice(scanned.end);
      const match = /^\s*:(?:\s+|$)/.exec(after);
      if (match === null) return null;
      return { key: foldedQuoted(scanned.inner, first, this, at), rest: after.slice(match[0].length).trim() };
    }
    if (first === "?" && /^\?(?:\s|$)/.test(text)) this.fail("complex keys are not supported", at);
    if ("[{|>&*!%@`#".includes(first)) return null;
    let from = 0;
    for (;;) {
      const colon = text.indexOf(":", from);
      if (colon === -1) return null;
      if (colon + 1 === text.length || text[colon + 1] === " ") {
        const key = text.slice(0, colon).trimEnd();
        if (key === "" || /(?:^|\s)#/.test(key)) return null;
        if (/^[&*!]/.test(key)) this.fail("anchors, aliases and tags are not supported", at);
        return { key, rest: text.slice(colon + 1).trim() };
      }
      from = colon + 1;
    }
  }

  /** The value that starts on a line after `key:` or `- `; its further lines are read from `this.index`. */
  parseInline(rest, ctx) {
    const first = rest[0];
    if (first === '"' || first === "'") return this.parseQuoted(rest, ctx);
    if (first === "[" || first === "{") return this.parseFlowCollection(rest, ctx);
    if (first === "|" || first === ">") return this.parseBlockScalar(rest, ctx);
    if ("&*!".includes(first)) this.fail("anchors, aliases and tags are not supported", ctx.lineIndex);
    if ("@`%".includes(first)) this.fail(`'${first}' cannot start a plain scalar`, ctx.lineIndex);
    return this.parsePlain(rest, ctx);
  }

  parsePlain(rest, ctx) {
    const parts = [this.plainPart(stripComment(rest), ctx.lineIndex)];
    for (;;) {
      let at = this.index;
      while (at < this.lines.length && this.lines[at].trim() === "") at += 1;
      if (at >= this.lines.length) break;
      const line = this.lines[at];
      if (line.trim().startsWith("#")) break;
      if (this.indentOf(line, at) <= ctx.parentIndent) break;
      const blanks = at - this.index;
      const piece = this.plainPart(stripComment(line.trim()), at);
      parts.push(blanks > 0 ? "\n".repeat(blanks) : " ", piece);
      this.index = at + 1;
    }
    return parts.length === 1 ? resolvePlain(parts[0]) : parts.join("");
  }

  plainPart(text, at) {
    if (/:(?:\s|$)/.test(text)) this.fail("a mapping value is not allowed here", at);
    return text;
  }

  parseQuoted(rest, ctx) {
    const quote = rest[0];
    let buffer = rest;
    let scanned = scanQuoted(buffer, quote);
    while (scanned === null) {
      if (this.index >= this.lines.length) this.fail("unterminated quoted scalar", ctx.lineIndex);
      buffer += `\n${this.lines[this.index]}`;
      this.index += 1;
      scanned = scanQuoted(buffer, quote);
    }
    const trailing = buffer.slice(scanned.end).trim();
    if (trailing !== "" && !trailing.startsWith("#")) this.fail("unexpected text after a quoted scalar", ctx.lineIndex);
    return foldedQuoted(scanned.inner, quote, this, ctx.lineIndex);
  }

  parseFlowCollection(rest, ctx) {
    let buffer = rest;
    while (!flowIsClosed(buffer)) {
      if (this.index >= this.lines.length) this.fail("unterminated flow collection", ctx.lineIndex);
      buffer += `\n${this.lines[this.index]}`;
      this.index += 1;
    }
    const flow = new FlowReader(buffer, (message) => this.fail(message, ctx.lineIndex), this);
    const value = flow.value();
    flow.skipSpace();
    if (!flow.done() && !flow.atComment()) this.fail("unexpected text after a flow collection", ctx.lineIndex);
    return value;
  }

  parseBlockScalar(rest, ctx) {
    const header = /^([|>])([1-9]?)([+-]?)([1-9]?)\s*(?:#.*)?$/.exec(rest.trimEnd());
    if (header === null) this.fail("a block scalar header was expected after '|' or '>'", ctx.lineIndex);
    const folded = header[1] === ">";
    const chomp = header[3];
    const explicit = Number(header[2] || header[4] || 0);
    const collected = [];
    let contentIndent = explicit > 0 ? Math.max(ctx.parentIndent, 0) + explicit : null;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line.trim() === "") {
        collected.push(contentIndent !== null && line.length > contentIndent ? line.slice(contentIndent) : "");
        this.index += 1;
        continue;
      }
      const indent = this.indentOf(line, this.index, { allowTab: true });
      if (contentIndent === null) {
        if (indent <= ctx.parentIndent) break;
        contentIndent = indent;
      }
      if (indent < contentIndent) break;
      collected.push(line.slice(contentIndent));
      this.index += 1;
    }
    let trailing = 0;
    while (collected.length > 0 && collected[collected.length - 1] === "") {
      collected.pop();
      trailing += 1;
    }
    let body;
    if (!folded) {
      body = collected.join("\n");
    } else {
      body = "";
      let pending = 0;
      let previousMore = false;
      let started = false;
      for (const line of collected) {
        if (line === "") {
          pending += 1;
          continue;
        }
        const more = /^[ \t]/.test(line);
        if (!started) body += "\n".repeat(pending) + line;
        else if (!more && !previousMore) body += (pending === 0 ? " " : "\n".repeat(pending)) + line;
        else body += "\n".repeat(pending + 1) + line;
        started = true;
        previousMore = more;
        pending = 0;
      }
    }
    if (collected.length === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    if (chomp === "-") return body;
    if (chomp === "+") return `${body}\n${"\n".repeat(trailing)}`;
    return `${body}\n`;
  }
}

/** { inner, end }: the raw text between the quotes and the index after the closing quote, or null when it is not closed. */
function scanQuoted(text, quote) {
  for (let at = 1; at < text.length; at += 1) {
    const char = text[at];
    if (quote === '"' && char === "\\") {
      at += 1;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && text[at + 1] === "'") {
        at += 1;
        continue;
      }
      return { inner: text.slice(1, at), end: at + 1 };
    }
  }
  return null;
}

/** The value of a quoted scalar: line breaks folded (one break is a space, n blank lines are n breaks), escapes processed. */
function foldedQuoted(inner, quote, reader, at) {
  const raw = inner.split("\n");
  const pieces = raw.map((line, position) => {
    let text = position > 0 ? line.trimStart() : line;
    let escaped = false;
    if (position < raw.length - 1) {
      if (quote === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(text)) {
        escaped = true;
        text = text.slice(0, -1);
      } else {
        text = text.trimEnd();
      }
    }
    return { text, escaped };
  });
  let out = pieces[0].text;
  let previousEscaped = pieces[0].escaped;
  let blanks = 0;
  for (let position = 1; position < pieces.length; position += 1) {
    const { text, escaped } = pieces[position];
    if (text === "" && position < pieces.length - 1) {
      blanks += 1;
      continue;
    }
    out += blanks === 0 ? (previousEscaped ? "" : " ") : "\n".repeat(blanks);
    out += text;
    blanks = 0;
    previousEscaped = escaped;
  }
  return quote === "'" ? out.replace(/''/g, "'") : unescapeDouble(out, reader, at);
}

function unescapeDouble(text, reader, at) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    index += 1;
    const code = text[index];
    if (code === "x" || code === "u" || code === "U") {
      const width = code === "x" ? 2 : code === "u" ? 4 : 8;
      const digits = text.slice(index + 1, index + 1 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) reader.fail(`invalid \\${code} escape`, at);
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      index += width;
    } else if (hasOwn(ESCAPES, code)) {
      out += ESCAPES[code];
    } else {
      reader.fail(`unknown escape \\${code ?? ""}`, at);
    }
  }
  return out;
}

/** True when every flow collection that starts in `text` is closed. */
function flowIsClosed(text) {
  let depth = 0;
  let quote = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== null) {
      if (quote === '"' && char === "\\") at += 1;
      else if (char === quote) {
        if (quote === "'" && text[at + 1] === "'") at += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#" && (at === 0 || /\s/.test(text[at - 1]))) {
      const newline = text.indexOf("\n", at);
      at = newline === -1 ? text.length : newline;
    }
  }
  return depth <= 0 && quote === null;
}

class FlowReader {
  constructor(text, fail, reader) {
    this.text = text;
    this.at = 0;
    this.fail = fail;
    this.reader = reader;
  }

  done() {
    return this.at >= this.text.length;
  }

  atComment() {
    return this.text[this.at] === "#";
  }

  skipSpace() {
    for (;;) {
      while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at += 1;
      if (this.text[this.at] === "#" && (this.at === 0 || /\s/.test(this.text[this.at - 1]))) {
        const newline = this.text.indexOf("\n", this.at);
        if (newline === -1) return;
        this.at = newline;
        continue;
      }
      return;
    }
  }

  value() {
    this.skipSpace();
    const char = this.text[this.at];
    if (char === "[") return this.sequence();
    if (char === "{") return this.mapping();
    if (char === '"' || char === "'") return this.quoted();
    if (char === "&" || char === "*" || char === "!") this.fail("anchors, aliases and tags are not supported");
    return this.plain();
  }

  quoted() {
    const quote = this.text[this.at];
    const scanned = scanQuoted(this.text.slice(this.at), quote);
    if (scanned === null) this.fail("unterminated quoted scalar in a flow collection");
    this.at += scanned.end;
    return foldedQuoted(scanned.inner, quote, this.reader, this.reader.index);
  }

  plain(inMapping = false) {
    const start = this.at;
    while (this.at < this.text.length) {
      const char = this.text[this.at];
      if (char === "," || char === "]" || char === "}" || char === "\n") break;
      if (char === ":" && (inMapping || /\s|,|\]|\}/.test(this.text[this.at + 1] ?? " "))) {
        if (inMapping || /\s/.test(this.text[this.at + 1] ?? " ")) break;
      }
      if (char === "#" && /\s/.test(this.text[this.at - 1] ?? "")) break;
      this.at += 1;
    }
    return resolvePlain(this.text.slice(start, this.at).trim());
  }

  sequence() {
    this.at += 1;
    const items = [];
    for (;;) {
      this.skipSpace();
      if (this.text[this.at] === "]") {
        this.at += 1;
        return items;
      }
      if (this.done()) this.fail("unterminated flow sequence");
      items.push(this.value());
      this.skipSpace();
      if (this.text[this.at] === ",") this.at += 1;
      else if (this.text[this.at] !== "]") this.fail("a comma or ] was expected in a flow sequence");
    }
  }

  mapping() {
    this.at += 1;
    const result = {};
    for (;;) {
      this.skipSpace();
      if (this.text[this.at] === "}") {
        this.at += 1;
        return result;
      }
      if (this.done()) this.fail("unterminated flow mapping");
      const char = this.text[this.at];
      const key = char === '"' || char === "'" ? this.quoted() : this.plain(true);
      if (typeof key !== "string" && key !== null && typeof key !== "number" && typeof key !== "boolean") this.fail("a flow mapping key must be a scalar");
      const name = String(key);
      if (hasOwn(result, name)) this.fail(`duplicate key '${name}'`);
      this.skipSpace();
      let value = null;
      if (this.text[this.at] === ":") {
        this.at += 1;
        this.skipSpace();
        if (this.text[this.at] !== "," && this.text[this.at] !== "}") value = this.value();
      }
      setKey(result, name, value);
      this.skipSpace();
      if (this.text[this.at] === ",") this.at += 1;
      else if (this.text[this.at] !== "}") this.fail("a comma or } was expected in a flow mapping");
    }
  }
}

/** The document as a JavaScript value; throws YamlSubsetError for an unsupported or malformed construct. */
export function parseYamlSubset(text) {
  return new Reader(text).parseDocument();
}
