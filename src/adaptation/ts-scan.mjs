// A small scanner for TypeScript and JavaScript source (SPEC-04 AC37, AC43, AC47).
//
// The helpers of the AI adaptation stream have to tell code from comments and strings (a SHA in a `//` comment stays as it is; a `//` inside the
// string of a URL is not a comment) and have to find named test blocks, imports and a handful of banned constructs by their tokens, not by a regular
// expression over text. This scanner has no dependency, so it loads under `node --frozen-intrinsics` and in a job that never ran `npm ci`.
//
// It is a scanner, not a parser: it knows comments, string literals, template literals (and the code inside their `${}`), regular expression
// literals (by the usual rule on the token before the slash), identifiers, numbers and punctuators. That is everything that the callers need.
// A construct that it cannot scan (an unterminated string, a stray character) ends at the end of its line or becomes a one-character punctuator,
// and scanning goes on: a damaged file never makes the scanner throw or loop.

const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
];

/** Keywords after which a slash starts a regular expression and not a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** The punctuators after which a slash is a division: the token before it ends a value. */
const VALUE_END_PUNCT = new Set([")", "]", "++", "--"]);

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$\u200c\u200d]/u;

/**
 * @typedef {{ type: "ident" | "number" | "string" | "template" | "regex" | "punct", value: string, start: number, end: number, line: number,
 *   templateDepth: number, text?: string }} Token
 * `text` is the decoded content of a string token (and of a template without substitutions). `templateDepth` is how many template substitutions
 * the token sits in (0 for code outside every template literal).
 * @typedef {{ type: "line" | "block", start: number, end: number, line: number }} Comment
 */

/** Decodes the escapes of the body of a string literal (the text between the quotes). */
export function decodeString(body) {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    i += 1;
    const next = body[i];
    if (next === undefined) break;
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": out += "\0"; break;
      case "\r": if (body[i + 1] === "\n") i += 1; break;
      case "\n": break;
      case "x": {
        const hex = body.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; } else out += "x";
        break;
      }
      case "u": {
        if (body[i + 1] === "{") {
          const close = body.indexOf("}", i + 2);
          const hex = close === -1 ? "" : body.slice(i + 2, close);
          if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) { out += String.fromCodePoint(parseInt(hex, 16)); i = close; } else out += "u";
        } else {
          const hex = body.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; } else out += "u";
        }
        break;
      }
      default: out += next;
    }
  }
  return out;
}

/**
 * @param {string} source
 * @returns {{ tokens: Token[], comments: Comment[], lineOf: (offset: number) => number, lineStart: (line: number) => number, lineEnd: (line: number) => number }}
 * `lineOf` is 1-based; `lineStart` and `lineEnd` give the offsets of a line's first character and of its end, before the line terminator.
 */
export function scan(source) {
  const text = String(source);
  const length = text.length;
  const tokens = [];
  const comments = [];
  const lineStarts = [0];
  for (let k = 0; k < length; k += 1) if (text[k] === "\n") lineStarts.push(k + 1);

  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const lineStart = (line) => lineStarts[line - 1] ?? length;
  const lineEnd = (line) => {
    const next = lineStarts[line];
    if (next === undefined) return length;
    let end = next - 1;
    if (end > lineStart(line) && text[end - 1] === "\r") end -= 1;
    return end;
  };

  let position = 0;
  let previous = null;

  const push = (type, start, end, extra, depth) => {
    const token = { type, value: text.slice(start, end), start, end, line: lineOf(start), templateDepth: depth, ...extra };
    tokens.push(token);
    previous = token;
    return token;
  };

  const slashStartsRegex = () => {
    if (previous === null) return true;
    if (previous.type === "number" || previous.type === "string" || previous.type === "template" || previous.type === "regex") return false;
    if (previous.type === "ident") return REGEX_AFTER_WORD.has(previous.value);
    return !VALUE_END_PUNCT.has(previous.value);
  };

  /** The end of the regular expression literal that starts at the slash at `start`, or -1 when its line ends before it closes. */
  const regexEnd = (start) => {
    let k = start + 1;
    let inClass = false;
    while (k < length) {
      const char = text[k];
      if (char === "\n" || char === "\r") return -1;
      if (char === "\\") {
        k += 2;
        continue;
      }
      if (inClass) {
        if (char === "]") inClass = false;
      } else if (char === "[") {
        inClass = true;
      } else if (char === "/") {
        k += 1;
        while (k < length && /[A-Za-z]/.test(text[k])) k += 1;
        return k;
      }
      k += 1;
    }
    return -1;
  };

  /** Scans code until the end of the text or, inside a template substitution, until the `}` that closes it. */
  const scanCode = (depth, insideSubstitution) => {
    let braces = 0;
    while (position < length) {
      const char = text[position];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\v" || char === "\f" || char === "\u00a0" || char === "\ufeff") {
        position += 1;
        continue;
      }
      const next = text[position + 1];
      if (char === "/" && next === "/") {
        const start = position;
        while (position < length && text[position] !== "\n") position += 1;
        const end = text[position - 1] === "\r" ? position - 1 : position;
        comments.push({ type: "line", start, end, line: lineOf(start) });
        continue;
      }
      if (char === "/" && next === "*") {
        const start = position;
        const close = text.indexOf("*/", position + 2);
        position = close === -1 ? length : close + 2;
        comments.push({ type: "block", start, end: position, line: lineOf(start) });
        continue;
      }
      if (char === "#" && next === "!" && position === 0) {
        while (position < length && text[position] !== "\n") position += 1;
        comments.push({ type: "line", start: 0, end: position, line: 1 });
        continue;
      }
      if (char === '"' || char === "'") {
        const start = position;
        position += 1;
        while (position < length && text[position] !== char && text[position] !== "\n") position += text[position] === "\\" ? 2 : 1;
        const closed = text[position] === char;
        const bodyEnd = Math.min(position, length);
        if (closed) position += 1;
        position = Math.min(position, length);
        push("string", start, position, { text: decodeString(text.slice(start + 1, bodyEnd)) }, depth);
        continue;
      }
      if (char === "`") {
        const start = position;
        position += 1;
        let cooked = "";
        let simple = true;
        const firstInner = tokens.length;
        while (position < length && text[position] !== "`") {
          if (text[position] === "\\") {
            cooked += text.slice(position, position + 2);
            position += 2;
            continue;
          }
          if (text[position] === "$" && text[position + 1] === "{") {
            simple = false;
            position += 2;
            previous = null;
            scanCode(depth + 1, true);
            continue;
          }
          cooked += text[position];
          position += 1;
        }
        if (text[position] === "`") position += 1;
        position = Math.min(position, length);
        // the template token comes first, then the tokens of its substitutions, which were pushed while it was scanned
        const token = { type: "template", value: text.slice(start, position), start, end: position, line: lineOf(start), templateDepth: depth, ...(simple ? { text: decodeString(cooked) } : {}) };
        tokens.splice(firstInner, 0, token);
        previous = token;
        continue;
      }
      if (char === "/" && slashStartsRegex()) {
        const end = regexEnd(position);
        if (end !== -1) {
          push("regex", position, end, {}, depth);
          position = end;
          continue;
        }
      }
      if (IDENT_START.test(char)) {
        const start = position;
        position += 1;
        while (position < length && IDENT_PART.test(text[position])) position += 1;
        push("ident", start, position, {}, depth);
        continue;
      }
      if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(next ?? ""))) {
        const start = position;
        position += 1;
        while (position < length && /[0-9A-Za-z_.]/.test(text[position]) && !(text[position] === "." && text[position + 1] === ".")) position += 1;
        push("number", start, position, {}, depth);
        continue;
      }
      if (insideSubstitution) {
        if (char === "{") {
          braces += 1;
        } else if (char === "}") {
          if (braces === 0) {
            position += 1;
            return;
          }
          braces -= 1;
        }
      }
      const matched = PUNCTUATORS.find((candidate) => text.startsWith(candidate, position));
      const value = matched ?? char;
      push("punct", position, position + value.length, {}, depth);
      position += value.length;
    }
  };

  scanCode(0, false);
  return { tokens, comments, lineOf, lineStart, lineEnd };
}

/** True when `offset` lies inside a comment of the scan. */
export function inComment(comments, offset) {
  return comments.some((comment) => offset >= comment.start && offset < comment.end);
}

/** Index of the token that closes the bracket opened at `openIndex` (`(`, `[` or `{`), or -1 when it does not close. */
export function matchingBracket(tokens, openIndex) {
  const open = tokens[openIndex]?.value;
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  if (close === undefined || tokens[openIndex].type !== "punct") return -1;
  let depth = 0;
  for (let k = openIndex; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.type !== "punct") continue;
    if (token.value === open) depth += 1;
    else if (token.value === close) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}
