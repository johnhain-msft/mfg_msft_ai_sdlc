import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("AI SDLC presentation deck builds cleanly in strict check mode and has up-to-date outputs", () => {
  const buildScript = path.join(ROOT, "presentation", "build.mjs");
  const out = execFileSync(process.execPath, [buildScript, "--check", "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /12 slides · 12 script sections/);
  assert.match(out, /strict/);

  const distHtml = path.join(ROOT, "presentation", "dist", "index.html");
  const presenterMd = path.join(ROOT, "presenter", "PRESENTER-SCRIPT.md");
  assert.equal(fs.existsSync(distHtml), true, "presentation/dist/index.html exists");
  assert.equal(fs.existsSync(presenterMd), true, "presenter/PRESENTER-SCRIPT.md exists");

  const html = fs.readFileSync(distHtml, "utf8");
  const dataMatch = html.match(/<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, "deck-data JSON script block is present");
  assert.equal(/<\/script|<!--/.test(dataMatch[1]), false, "no unsafe sequences inside deck-data JSON");
  const parsed = JSON.parse(dataMatch[1]);
  assert.equal(parsed.slides.length, 12);
  assert.ok(html.includes('<div class="topbar-left">'), "topbar-left hook present for portfolio importer");
  assert.ok(html.includes('<div class="sp-title">'), "sp-title hook present for portfolio importer");

  assert.ok(
    html.includes("p.toggleAttribute('hidden', i !== idx)"),
    "Slide 9 SVG pilot stepper toggles the hidden attribute on <g> panels",
  );
  for (const expected of [
    "sources/manifest.json",
    "docs/19-licenses-billing.md",
    "Clarify GHAS cost center heading in licenses &amp; billing doc",
    "Tracking GitHub Advanced Security via Cost Centers",
    "public/ghec-admin/source.json",
    "public/ghec-admin/labs/index.html",
    "public/ghec-admin/workshop/index.html",
    "sites.spec.ts",
  ]) {
    assert.ok(html.includes(expected), `Slide 9 telemetry contains exact artifact text: ${expected}`);
  }
});

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

test("AI SDLC presentation deck is built from its current sources", () => {
  const html = read("presentation", "dist", "index.html");
  for (const file of ["styles.css", "app.js"]) {
    assert.ok(html.includes(read("presentation", "src", file)), `dist/index.html embeds the current src/${file}: run node presentation/build.mjs`);
  }
  // everything of the shell around the build placeholders survives into the page, so a markup edit cannot be left unbuilt
  for (const part of read("presentation", "src", "shell.html").split(/\{\{[A-Z_]+\}\}/)) {
    assert.ok(html.includes(part.trim()), `dist/index.html carries the shell markup: ${part.trim().slice(0, 48)}...`);
  }
});

// Facts that the deck states about this repository are derived from the repository, not retyped:
// the counts come from sdlc.yaml, the source lines from the files that exist, the size from the build.
const content = (...parts) => read("presentation", "content", ...parts);

function fleetOf(manifest) {
  const edges = manifest.dependencyEdges;
  const upstreams = new Set(edges.map((e) => e.upstreamRepo));
  const downstreams = new Set(edges.map((e) => e.downstreamRepo));
  return {
    edges,
    upstreams,
    downstreams,
    repos: new Set([...manifest.projects.map((p) => p.repo), ...upstreams, ...downstreams]),
    self: edges.find((e) => e.edgeId === "ai-sdlc"), // this repository, cascading itself (slides 3 and 10)
  };
}

test("deck states the fleet that sdlc.yaml declares: the slide 2 tile, the slide 3 diagram and the cover glyph", () => {
  const { edges, upstreams, downstreams, repos, self } = fleetOf(YAML.parse(read("sdlc.yaml")));
  assert.ok(self, "sdlc.yaml has the ai-sdlc self-cascade edge that slides 3 and 10 describe");

  const tile = content("slides", "01-overview-and-security.md").match(/^(\d+) \| Tracked Fleet Repos \| (.+)$/m);
  assert.ok(tile, "slide 2 has the Tracked Fleet Repos tile");
  assert.equal(Number(tile[1]), repos.size, `sdlc.yaml tracks ${repos.size} repositories`);
  assert.equal(tile[2], `${upstreams.size} upstreams + ${downstreams.size} downstreams`);

  // slide 3 lists the upstreams other than this repository, which S5 names as the sixth, and every downstream
  const svg = content("diagrams", "fleet-topology.html");
  const labels = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].trim());
  const listed = edges.filter((e) => e !== self);
  const downNames = [...downstreams].map((r) => r.split("/")[1]);
  const noun = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}:`; // "1 downstream repo:", "4 upstream repos:"
  assert.ok(labels.includes(noun(listed.length, "upstream repo")), `slide 3 labels its upstream group "${noun(listed.length, "upstream repo")}"`);
  assert.ok(labels.includes(noun(downstreams.size, "downstream repo")), `slide 3 labels its downstream group "${noun(downstreams.size, "downstream repo")}"`);
  const alternatives = [...svg.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(" | ");
  for (const name of [...listed.map((e) => e.upstreamKey), ...downNames]) {
    assert.ok(labels.includes(name), `slide 3 draws ${name}`);
    assert.ok(alternatives.includes(name), `slide 3's text alternatives name ${name}`);
  }
  assert.ok(labels.some((t) => t.includes(self.upstreamRepo.split("/")[1])), "S5 names this repository as the sixth upstream");
  assert.equal(listed.length + 1, upstreams.size, "the drawn upstreams plus this repository are all of the manifest's upstreams");

  const html = read("presentation", "dist", "index.html");
  assert.equal((html.match(/<circle class="g-node" /g) || []).length, upstreams.size, "the cover glyph has a node for every upstream");
  assert.equal((html.match(/<circle class="g-node g-node-out" /g) || []).length, downstreams.size, "the cover glyph has a node for every downstream");
});

test("script sources are files of this repository or public repositories, with no engine paths or retracted claims", () => {
  // The notes are shown to everyone, so a source may link only to a repository that is known to be public. The instance, the engine,
  // the pilot's upstream and the portfolio are. Any other repository of the account is not on this list until it is made public.
  const PUBLIC_REPOS = new Set(["mfg_msft_ai_sdlc", "ai-sdlc-factory", "gh-admin-msft", "portfolio"]);
  const scriptDir = path.join(ROOT, "presentation", "content", "script");
  let cited = 0;
  for (const file of fs.readdirSync(scriptDir).filter((f) => f.endsWith(".md"))) {
    for (const line of content("script", file).split("\n").filter((l) => /^SOURCE:/i.test(l))) {
      for (const item of line.replace(/^SOURCE:\s*/i, "").split(" · ").map((s) => s.trim()).filter(Boolean)) {
        const owned = item.match(/github\.com\/johnhain-msft\/([\w.-]+)/i);
        assert.ok(!owned || PUBLIC_REPOS.has(owned[1].toLowerCase()), `${file}: ${item} points at a repository that is not known to be public; cite the file instead`);
        if (!/^https?:/i.test(item)) assert.ok(fs.existsSync(path.join(ROOT, item)), `${file}: source ${item} is not a file of this repository`);
        cited += 1;
      }
    }
  }
  assert.ok(cited >= 12, `every script section cites its sources (${cited})`);

  // the engine is the ai-sdlc-factory package now: its files are no longer paths of this repository
  const enginePath = /\b(?:bin\/(?:lib\/)?[\w.-]+|src\/[\w./-]+\.mjs|schemas\/[\w.-]+\.json)\b/;
  const claims = [/hosted portfolio reader/i, /eight-frame animated SVG/i];
  for (const [dir, ext] of [["slides", ".md"], ["script", ".md"], ["diagrams", ".html"]]) {
    for (const file of fs.readdirSync(path.join(ROOT, "presentation", "content", dir)).filter((f) => f.endsWith(ext))) {
      const text = content(dir, file);
      assert.equal(enginePath.test(text), false, `${dir}/${file} names ${text.match(enginePath)?.[0]}, which is not a path of this repository`);
      for (const claim of claims) assert.equal(claim.test(text), false, `${dir}/${file} still says "${text.match(claim)?.[0]}"`);
    }
  }
});

test("the presentation README states the size of the built deck", () => {
  const claim = read("presentation", "README.md").match(/\babout (\d+(?:\.\d+)?) (KB|MB)\b/);
  assert.ok(claim, "the README says about how large dist/index.html is");
  const claimed = Number(claim[1]) * (claim[2] === "MB" ? 1024 * 1024 : 1024);
  const actual = fs.statSync(path.join(ROOT, "presentation", "dist", "index.html")).size;
  assert.ok(Math.abs(actual - claimed) / actual < 0.15, `the README says ${claim[0]}, dist/index.html is ${Math.round(actual / 1024)} KB`);
});

// Run the entire shipped IIFE, not extracted/reimplemented handlers. This deliberately small DOM
// implements only the APIs used by app.js; its elements and slide data come from the built document.
// Geometry, clock and selection are controlled inputs, not a claim to emulate browser layout.
const decode = (s) => s.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi,
  (_, hex, num, name) => hex || num ? String.fromCodePoint(parseInt(hex || num, hex ? 16 : 10))
    : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name.toLowerCase()]);

function simpleMatch(el, selector) {
  let ok = true;
  let rest = selector.replace(/:not\(([^)]+)\)/g, (_, inner) => { if (simpleMatch(el, inner)) ok = false; return ""; });
  rest = rest.replace(/\[([\w:-]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_, name, value) => {
    if (!el.hasAttribute(name) || (value !== undefined && el.getAttribute(name) !== value)) ok = false;
    return "";
  }).replace(/:root/g, () => { if (el !== el.ownerDocument.documentElement) ok = false; return ""; });
  if (rest.includes(":")) return false; // no invented hover/focus/pseudo-element state
  rest = rest.replace(/#([\w-]+)/g, (_, id) => { if (el.id !== id) ok = false; return ""; })
    .replace(/\.([\w-]+)/g, (_, cls) => { if (!el.classList.contains(cls)) ok = false; return ""; });
  return ok && (!rest || rest === "*" || rest.toUpperCase() === el.tagName);
}

function matches(el, selector) {
  return selector.split(",").some((branch) => {
    const parts = branch.trim().replace(/\s*>\s*/g, " > ").match(/(?:\[[^\]]*\]|:not\([^)]*\)|[^\s])+/g) || [];
    function at(node, i) {
      if (!node || !simpleMatch(node, parts[i])) return false;
      if (i === 0) return true;
      if (parts[i - 1] === ">") return at(node.parentElement, i - 2);
      for (let p = node.parentElement; p; p = p.parentElement) if (at(p, i - 1)) return true;
      return false;
    }
    return parts.length > 0 && at(el, parts.length - 1);
  });
}

class DeckElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentElement = null;
    this.childNodes = []; this.attrs = new Map(); this.events = new Map();
    this.scrollTop = 0; this.scrollLeft = 0;
    this.clientWidth = this.scrollWidth = 320; this.clientHeight = this.scrollHeight = 300;
    this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ""; } };
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_, key, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value); return true; },
    });
  }
  get children() { return this.childNodes.filter((n) => n instanceof DeckElement); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => tokens().includes(c),
      add: (...cs) => { this.className = [...new Set([...tokens(), ...cs])].join(" "); },
      remove: (...cs) => { this.className = tokens().filter((c) => !cs.includes(c)).join(" "); },
      toggle: (c, force) => {
        const on = force ?? !tokens().includes(c);
        this.classList[on ? "add" : "remove"](c); return on;
      },
    };
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(s) { this.replaceChildren({ textContent: String(s) }); }
  get innerHTML() { return this.markup || ""; }
  set innerHTML(s) { this.markup = String(s); this.replaceChildren(); parseMarkup(this.markup, this); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { this.toggleAttribute("hidden", v); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { this.toggleAttribute("disabled", v); }
  get open() { return this.hasAttribute("open"); }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  get value() { return this.getAttribute("value") || ""; }
  set value(v) { this.setAttribute("value", v); }
  get href() { return this.getAttribute("href") || ""; }
  set href(v) { this.setAttribute("href", v); }
  get selectedIndex() { return this.options.findIndex((o) => o.value === this.value); }
  get viewBox() { return { baseVal: { width: Number((this.getAttribute("viewBox") || "").split(/\s+/)[2]) } }; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  toggleAttribute(k, on = !this.hasAttribute(k)) { if (on) this.setAttribute(k, ""); else this.removeAttribute(k); return on; }
  appendChild(n) { n.remove?.(); n.parentElement = this; this.childNodes.push(n); return n; }
  replaceChildren(...nodes) { for (const n of this.childNodes) n.parentElement = null; this.childNodes = []; nodes.forEach((n) => this.appendChild(n)); }
  replaceWith(n) { const p = this.parentElement; const i = p.childNodes.indexOf(this); n.remove?.(); p.childNodes[i] = n; n.parentElement = p; this.parentElement = null; }
  remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter((n) => n !== this); this.parentElement = null; }
  matches(s) { return matches(this, s); }
  closest(s) { for (let n = this; n; n = n.parentElement) if (n.matches(s)) return n; return null; }
  querySelectorAll(s) { return this.children.flatMap((c) => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(type, fn, options) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push({ fn, options }); }
  fire(type, details = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...details };
    for (let n = this; n; n = n.parentElement) for (const { fn } of n.events.get(type) || []) fn(e);
    return e;
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) return this.fire("click"); }
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  scrollBy({ top = 0, left = 0 }) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + top));
    this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
  }
}

function parseMarkup(html, root) {
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<(script|style)\b([^>]*?)>([\s\S]*?)<\/\1\s*>|<\/?[\w:-]+\b[^>]*>|[^<]+|</gi;
  for (const m of html.matchAll(tokens)) {
    const token = m[0];
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim().toUpperCase();
      const i = stack.findLastIndex((n) => n.tagName === name);
      if (i > 0) stack.length = i;
    } else if (token.startsWith("<") && token !== "<") {
      const tag = m[1] || token.match(/^<([\w:-]+)/)[1];
      const attributes = m[1] ? m[2] : token.slice(tag.length + 1).replace(/\/?>$/, "");
      const el = new DeckElement(tag, root.ownerDocument);
      for (const a of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s=<>`]+)))?/g)) {
        el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      stack.at(-1).appendChild(el);
      if (m[1]) el.textContent = m[3];
      else if (!/\/>$/.test(token) && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag)) stack.push(el);
    } else stack.at(-1).appendChild({ textContent: decode(token) });
  }
}

// Parse nested @media blocks and evaluate both sides of their boundaries. Unlike a substring
// assertion this catches a rule moved under the wrong parent query, and honours !important.
function parseStyles(css, conditions = []) {
  const rules = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let pos = 0; pos < css.length;) {
    const open = css.indexOf("{", pos);
    if (open < 0) break;
    let end = open + 1; let depth = 1;
    for (; depth && end < css.length; end++) { if (css[end] === "{") depth++; else if (css[end] === "}") depth--; }
    assert.equal(depth, 0, "balanced stylesheet");
    const head = css.slice(pos, open).trim(); const body = css.slice(open + 1, end - 1);
    if (head.startsWith("@media ")) rules.push(...parseStyles(body, [...conditions, head.slice(7)]));
    else if (!head.startsWith("@")) {
      const declarations = body.split(";").filter((d) => d.includes(":")).map((d) => {
        const colon = d.indexOf(":"); return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
      });
      rules.push({ selectors: head.split(",").map((s) => s.trim()), conditions, declarations });
    }
    pos = end;
  }
  return rules;
}

const STYLES = parseStyles(read("presentation", "src", "styles.css"));
const screen = (overrides = {}) => ({ width: 390, height: 844, pointer: "fine", motion: "no-preference", ...overrides });
function mediaMatches(query, v) {
  return query.split(",").some((branch) => {
    const features = [...branch.matchAll(/\(([\w-]+):\s*([^)]+)\)/g)];
    const rest = branch.replace(/\([^)]+\)|\band\b|\bscreen\b|\ball\b/g, "").trim();
    if (rest === "print") return false;
    assert.equal(rest, "", `unsupported media syntax: ${branch}`);
    return features.every(([, name, value]) => {
      const size = name.match(/^(min|max)-(width|height)$/);
      if (size) return size[1] === "min" ? v[size[2]] >= parseFloat(value) : v[size[2]] <= parseFloat(value);
      if (name === "orientation") return value === (v.height >= v.width ? "portrait" : "landscape");
      if (name === "pointer") return value === v.pointer;
      if (name === "prefers-reduced-motion") return value === v.motion;
      assert.fail(`unsupported media feature: ${name}`);
    });
  });
}
function declarations(select, v) {
  const result = {};
  const important = new Set();
  for (const r of STYLES) {
    if (!r.conditions.every((q) => mediaMatches(q, v)) || !r.selectors.some(select)) continue;
    for (const [key, raw] of r.declarations) {
      const priority = /!important$/.test(raw);
      if (important.has(key) && !priority) continue;
      result[key] = raw.replace(/\s*!important$/, "");
      if (priority) important.add(key);
    }
  }
  return result;
}
const css = (selector, v = screen()) => declarations((s) => s === selector, v);

function mountDeck({ speaker = false, viewport = screen(), popup = null, initialSlide = 3 } = {}) {
  const doc = new DeckElement("document", null); doc.ownerDocument = doc;
  parseMarkup(read("presentation", "dist", "index.html"), doc);
  doc.documentElement = doc.querySelector("html"); doc.body = doc.querySelector("body");
  doc.createElement = (tag) => new DeckElement(tag, doc);
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  const $ = (s) => { const el = doc.querySelector(s); assert.ok(el, `fixture contains ${s}`); return el; };
  const data = JSON.parse($("#deck-data").textContent);
  const storage = new Map(); const messages = []; const opened = []; const observers = [];
  if (speaker) storage.set("ai-sdlc-deck:state", JSON.stringify({ id: data.slides[initialSlide - 1].id, frag: 0 }));
  const win = { events: new Map(), addEventListener: DeckElement.prototype.addEventListener, fire: DeckElement.prototype.fire };
  const location = { hash: speaker ? "#/speaker" : `#/${data.slides[initialSlide - 1].id}`, reload() {} };
  Object.defineProperty(location, "href", { get: () => `file:///deck.html${location.hash}` });
  win.location = location; win.visualViewport = { scale: 1 }; win.getSelection = () => selection;
  win.open = (...args) => { opened.push(args); return popup; }; win.print = () => {};
  win.matchMedia = () => ({ matches: false });
  let clock = 0; let selection = "";
  const computed = (el) => {
    const values = declarations((s) => el.matches(s), viewport);
    return { overflowX: el.style["overflow-x"] || values["overflow-x"] || "visible", getPropertyValue: (key) => el.style[key] || values[key] || "" };
  };
  const resize = (next = viewport) => {
    viewport = screen(next); $("#deck").clientWidth = viewport.width; $("#deck").clientHeight = viewport.height - 100;
    observers.forEach((fn) => fn()); win.fire("resize");
  };
  resize();
  vm.runInNewContext(doc.querySelectorAll("script").at(-1).textContent, {
    document: doc, window: win, Element: DeckElement, getComputedStyle: computed,
    history: { replaceState: (_state, _unused, hash) => { location.hash = hash; } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)); if (key === "ai-sdlc-deck:msg") messages.push(JSON.parse(value)); },
    },
    performance: { now: () => clock },
    ResizeObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    setTimeout: () => 1, setInterval: () => 1,
  }, { filename: "presentation/dist/index.html:app.js", timeout: 5000 });
  return {
    $, doc, win, data, messages, storage, opened, resize,
    active: () => $("#stage .slide.active").dataset.id,
    go(n) { location.hash = `#/${data.slides[n - 1].id}`; win.fire("hashchange"); },
    key(key, target = doc.activeElement || doc.body, extra = {}) { return target.fire("keydown", { key, ...extra }); },
    elapse(ms) { clock += ms; },
    select(s) { selection = s; },
    style: computed,
  };
}
const point = (clientX, clientY) => ({ clientX, clientY });
function touch(h, target, { dx = -100, dy = 0, moveY = dy, ms = 100, touches = 1, cancel = false } = {}) {
  target.fire("touchstart", { touches: Array.from({ length: touches }, () => point(180, 160)) });
  target.fire("touchmove", { touches: Array.from({ length: touches }, () => point(180 + dx, 160 + moveY)) });
  h.elapse(ms);
  if (cancel) target.fire("touchcancel");
  target.fire("touchend", { changedTouches: [point(180 + dx, 160 + dy)] });
}

test("mobile: horizontal swipes navigate once, reverse direction, and clamp at deck boundaries", () => {
  const h = mountDeck(); const target = h.$("#stage .slide.active h1");
  const start = h.active();
  touch(h, target); assert.equal(h.active(), h.data.slides[3].id);
  h.$("#presentation").fire("pointerup", { target, pointerType: "touch", clientX: 80, clientY: 160 });
  assert.equal(h.active(), h.data.slides[3].id, "compatibility pointerup cannot advance a second time");
  touch(h, h.$("#stage .slide.active h1"), { dx: 100 }); assert.equal(h.active(), start);
  h.go(1); touch(h, h.$("#stage .slide.active h1"), { dx: 100 }); assert.equal(h.active(), h.data.slides[0].id);
  h.go(12); touch(h, h.$("#stage .slide.active h1")); assert.equal(h.active(), h.data.slides[11].id);
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup"]) {
    assert.equal(h.$("#presentation").events.get(type)?.[0].options.passive, true, `${type} must not block native scrolling`);
  }
  h.go(3); h.doc.fullscreenElement = h.doc.documentElement;
  h.$("#stage .slide.active h1").fire("click", { clientX: 350 }); assert.equal(h.active(), h.data.slides[3].id);
  h.$("#stage .slide.active h1").fire("click", { clientX: 20 }); assert.equal(h.active(), start);
  h.go(11); h.$("#stage .quiz-q").fire("click", { clientX: 350 });
  assert.equal(h.active(), h.data.slides[10].id, "fullscreen taps also respect interactive containers");
});

test("mobile: vertical, diagonal, short and slow gestures do not navigate", () => {
  const h = mountDeck(); const target = h.$("#stage .slide.active h1"); const id = h.active();
  for (const gesture of [{ dx: 0, dy: 120 }, { dx: -100, dy: 80 }, { dx: -100, moveY: 180 }, { dx: -55 }, { ms: 901 }]) {
    touch(h, target, gesture); assert.equal(h.active(), id, JSON.stringify(gesture));
  }
  touch(h, target, { dx: -56, ms: 900 }); assert.equal(h.active(), h.data.slides[3].id, "inclusive distance/time boundary works");
});

test("mobile: multitouch, cancellation and non-primary pointers cannot become a swipe", () => {
  const h = mountDeck(); const target = h.$("#stage .slide.active h1"); const root = h.$("#presentation"); const id = h.active();
  touch(h, target, { touches: 2 }); assert.equal(h.active(), id);
  touch(h, target, { cancel: true }); assert.equal(h.active(), id);
  root.fire("touchstart", { target, touches: [point(180, 160)] });
  root.fire("touchmove", { target, touches: [point(100, 160), point(120, 160)] });
  root.fire("touchend", { target, changedTouches: [point(80, 160)] }); assert.equal(h.active(), id, "second finger clears an existing gesture");
  for (const pointerType of ["touch", "pen", "mouse"]) {
    root.fire("pointerdown", { target, pointerType, isPrimary: false, clientX: 180, clientY: 160 });
    root.fire("pointerup", { target, pointerType, clientX: 80, clientY: 160 }); assert.equal(h.active(), id);
  }
  for (const pointerType of ["touch", "pen"]) {
    h.go(3);
    root.fire("pointerdown", { target, pointerType, isPrimary: true, clientX: 180, clientY: 160 });
    root.fire("pointermove", { target, pointerType, clientX: 100, clientY: 160 });
    root.fire("pointerup", { target, pointerType, clientX: 80, clientY: 160 });
    root.fire("touchend", { target, changedTouches: [point(80, 160)] });
    assert.equal(h.active(), h.data.slides[3].id, `${pointerType} alone navigates exactly once`);
  }
});

test("mobile: interactive descendants and horizontally scrollable figures keep their gestures", () => {
  const h = mountDeck();
  for (const selector of [".quiz", "[data-decision]", "[data-pilot]", "button", "#stage a", "[data-pilot-step]", "[data-hl]", ".chrome", "dialog"]) {
    const control = h.$(selector);
    const slide = control.closest(".slide");
    if (slide) h.go(h.data.slides.find((s) => s.id === slide.dataset.id).n);
    const id = h.active();
    const target = control.children[0] || control;
    for (const dx of [-100, 100]) {
      touch(h, target, { dx });
      assert.equal(h.active(), id, `gesture owned by ${selector}, dx=${dx} (including its descendants)`);
    }
  }
  const id = h.active();
  const fig = h.$("#stage .diagram");
  fig.scrollWidth = 900; fig.clientWidth = 300;
  touch(h, fig.querySelector("svg title"));
  assert.equal(h.active(), id, "a wide figure keeps horizontal panning even before it takes tabindex");
  fig.scrollWidth = fig.clientWidth;
  touch(h, fig.querySelector("svg title"));
  assert.notEqual(h.active(), id, "a non-scrolling, non-interactive figure does not blanket-disable navigation");
});

test("mobile: pinch zoom and text selection suppress navigation without poisoning the next swipe", () => {
  const h = mountDeck(); const target = h.$("#stage .slide.active h1"); const root = h.$("#presentation"); const id = h.active();
  h.win.visualViewport.scale = 1.1; touch(h, target); assert.equal(h.active(), id);
  h.win.visualViewport.scale = 1;
  root.fire("touchstart", { target, touches: [point(180, 160)] }); h.select("selected text");
  root.fire("touchend", { target, changedTouches: [point(80, 160)] }); assert.equal(h.active(), id);
  touch(h, target); assert.equal(h.active(), h.data.slides[3].id);
});

test("mobile: Notes opens the in-page sheet, follows slides, clamps font size and closes", () => {
  const h = mountDeck(); const dlg = h.$("#dlg-notes");
  h.$("#btn-speaker .ico").fire("click");
  assert.equal(dlg.open, true); assert.equal(h.opened.length, 0, "compact Notes never opens a popup");
  assert.equal(h.$("#notes-body").innerHTML, h.data.slides[2].notes);
  assert.equal(dlg.closest("#stage") === null, true, "notes add no words to the slide");
  h.$("#btn-speaker").click(); assert.equal(dlg.open, true, "repeated open is safe");
  h.$("#notes-body").scrollTop = 100; h.$("#notes-next").click();
  assert.equal(h.active(), h.data.slides[3].id); assert.equal(h.$("#notes-body").innerHTML, h.data.slides[3].notes);
  assert.equal(h.$("#notes-body").scrollTop, 0);
  h.key("ArrowLeft"); assert.equal(h.active(), h.data.slides[2].id);
  for (let i = 0; i < 30; i++) h.$("#notes-font-inc").click();
  assert.equal(h.$("#notes-body").style["--notes-size"], "40px"); assert.equal(h.storage.get("ai-sdlc-deck:notes-size"), "40");
  for (let i = 0; i < 30; i++) h.$("#notes-font-dec").click();
  assert.equal(h.$("#notes-body").style["--notes-size"], "14px");
  h.go(1); h.$("#notes-prev").focus(); h.$("#notes-prev").click();
  assert.equal(h.active(), h.data.slides[0].id); assert.equal(h.$("#notes-prev").getAttribute("aria-disabled"), "true");
  assert.equal(h.doc.activeElement?.id, "notes-prev"); assert.equal(h.$("#notes-prev").disabled, false);
  h.go(12); h.$("#notes-next").click(); assert.equal(h.active(), h.data.slides[11].id);
  assert.equal(h.$("#notes-next").getAttribute("aria-disabled"), "true");
  h.$("#notes-close").click(); assert.equal(dlg.open, false);
  h.key("s"); assert.equal(dlg.open, true); h.key("s"); assert.equal(dlg.open, false);
  const wide = mountDeck({ viewport: screen({ width: 1440, height: 900 }) });
  wide.$("#btn-speaker").click(); assert.equal(wide.opened.length, 1); assert.equal(wide.$("#dlg-notes").open, true, "blocked popup falls back to notes");
  const popup = { closed: false, postMessage() {} };
  const desktop = mountDeck({ viewport: screen({ width: 1440, height: 900 }), popup });
  desktop.$("#btn-speaker").click(); assert.equal(desktop.opened.length, 1); assert.equal(desktop.$("#dlg-notes").open, false);
});

test("responsive: width, height and portrait boundaries switch off the scaled canvas only in compact layout", () => {
  // The documented 'under 900 / under 520' boundaries are max-width:899 / max-height:519.
  // The implementation calls compact layout 'flow', not 'compact'.
  for (const [width, height, flow] of [[899, 600, true], [900, 600, false], [1440, 519, true], [1440, 520, false],
    [1199, 1300, true], [1200, 1300, false], [1024, 1366, true], [1366, 1024, false], [1440, 900, false]]) {
    const v = screen({ width, height });
    assert.equal(css(":root", v)["--layout"], flow ? "flow" : "canvas", `${width}x${height}`);
    assert.equal(css("#stage", v).width, flow ? "100%" : "1920px");
    assert.equal(css("#stage", v).height, flow ? "100%" : "1080px");
    assert.equal(css("#stage", v).transform, flow ? "none" : "translate(-50%, -50%) scale(var(--scale))");
  }
  const h = mountDeck();
  assert.equal(h.style(h.doc.documentElement).getPropertyValue("--layout"), "flow");
  h.resize(screen({ width: 1440, height: 900 }));
  assert.equal(h.$("#stage").style["--scale"], String(Math.min(1440 / 1920, 800 / 1080)), "desktop fit still uses the available 1920x1080 canvas");
  assert.equal(h.style(h.doc.documentElement).getPropertyValue("--layout"), "canvas");
  const viewport = h.$('meta[name="viewport"]').getAttribute("content");
  assert.match(viewport, /width=device-width/); assert.doesNotMatch(viewport, /user-scalable|maximum-scale/);
});

test("responsive: 320px reflow and 400 percent zoom keep content and toolbar in shrinking tracks", () => {
  for (const height of [568, 180]) {
    const v = screen({ width: 320, height });
    for (const selector of ["#stage .cols", "#stage .cards", "#stage .stats", "#stage .kv-row"]) {
      assert.equal(css(selector, v)["grid-template-columns"], "minmax(0, 1fr)", `${selector} at 320x${height}`);
    }
    assert.equal(css("#stage .slide", v)["overflow-y"], "auto"); assert.equal(css("#stage .slide", v)["overflow-x"], "hidden");
    assert.equal(css("#stage .slide", v)["overflow-wrap"], "anywhere");
    assert.equal(css("#stage .slide", v)["touch-action"], "pan-y pinch-zoom");
    assert.equal(css("#stage .diagram", v)["overflow-x"], "auto");
    assert.equal(css("#bottombar .bottombar-row", v)["flex-wrap"], "wrap");
    assert.equal(css("#bottombar .toolbar .btn kbd", v).display, "none");
    assert.equal(css(".grid", v)["grid-template-columns"], "repeat(auto-fill, minmax(min(100%, 220px), 1fr))");
  }
  const zoom = screen({ width: 320, height: 180 });
  assert.equal(css("#presentation", zoom)["--tap"], "28px", "mouse at 400% zoom leaves room for the slide");
  assert.equal(css("#presentation", screen({ width: 320, height: 340 }))["--tap"], "40px");
  assert.equal(css("#presentation", screen({ width: 320, height: 341 }))["--tap"], "44px");
  assert.equal(css("#bottombar .toolbar", zoom)["min-width"], "0");
  assert.equal(css("#bottombar .toolbar", screen({ width: 320, height: 180, pointer: "coarse" }))["min-width"], undefined, "mouse-only zoom override cannot shrink touch controls");
});

test("responsive: speaker columns and short-height speaker and notes rules apply only inside their media queries", () => {
  for (const [width, height, single] of [[839, 900, true], [840, 900, false], [960, 519, true], [961, 519, false], [960, 520, false]]) {
    const v = screen({ width, height });
    assert.equal(css(".sp-body", v).display, single ? "flex" : "grid", `${width}x${height}`);
  }
  for (const width of [840, 1100]) {
    const v = screen({ width, height: 900 });
    assert.equal(css(".sp-notes-tools", v)["flex-wrap"], "wrap"); assert.equal(css(".sp-notes-tools", v)["min-width"], "0");
  }
  assert.equal(css(".sp-notes-tools", screen({ width: 1101, height: 900 }))["flex-wrap"], undefined);
  for (const height of [420, 421]) {
    const v = screen({ width: 390, height });
    assert.equal(css("#speaker", v).display, height === 420 ? "block" : "grid");
    assert.equal(css(".sp-position", v).position, height === 420 ? "static" : "sticky");
    assert.equal(css(".sp-position", v).order, height === 420 ? "0" : "3");
    assert.equal(css(".notes-head::before", v).display, height === 420 ? "none" : undefined);
  }
  assert.equal(css("#speaker", screen({ width: 390, height: 420 }))["overflow-y"], "auto");
  assert.equal(css(".dlg.dlg-notes[open]", screen({ height: 280 }))["overflow-y"], "auto");
  assert.equal(css(".dlg.dlg-notes[open]", screen({ height: 280 })).display, "block");
  assert.equal(css(".dlg.dlg-notes[open]", screen({ height: 281 })).display, undefined);
  assert.equal(css(".dlg-notes[open]", screen({ height: 281 })).display, "flex");
  assert.equal(css(".notes-head", screen({ height: 280 })).position, "sticky");
  assert.equal(css(".dlg-notes .sp-notes", screen({ height: 280 })).overflow, "visible");
});

test("responsive: coarse pointers get 44px speaker and overlay targets even on the desktop canvas", () => {
  for (const [width, height] of [[1366, 768], [390, 844], [844, 390]]) {
    const v = screen({ width, height, pointer: "coarse" });
    for (const selector of ["#speaker .btn", "#topbar .btn", "#bottombar .btn", ".dlg .btn", ".tabs button", ".grid-item", ".tz-label select"]) {
      const heightRule = css(selector, v)["min-height"];
      const pixels = heightRule === "var(--tap)" ? css("#presentation", v)["--tap"] : heightRule;
      assert.ok(parseFloat(pixels) >= 44, `${selector} at ${width}x${height}`);
    }
    assert.equal(css("#speaker .btn", v)["min-width"], "44px");
    assert.equal(css(".agenda-table .ag-go", v)["min-width"], "44px");
  }
  assert.equal(css("#speaker .btn", screen({ width: 1366, height: 768 }))["min-width"], undefined, "mouse desktop is unchanged");
});

test("responsive: reduced motion disables all animated states and the notes sheet entrance", () => {
  const reduced = screen({ motion: "reduce" });
  for (const selector of [".slide", "#progress-bar", ".fragment", ".outcome", ".ledger-row", ".diagram [data-hl]", ".diagram .d-panel"]) {
    assert.equal(css(selector, reduced).transition, "none", selector);
  }
  assert.equal(css(".dlg.dlg-notes[open]", reduced).animation, undefined);
  assert.equal(css(".dlg.dlg-notes[open]").animation, "sheet-up 0.2s ease-out", "positive control: no-preference enables entrance");
  assert.notEqual(css(".slide").transition, "none");
});

test("a11y: Space and Enter defer to focused native controls on both surfaces", () => {
  for (const speaker of [false, true]) {
    const h = mountDeck({ speaker }); const before = h.messages.length;
    for (const selector of speaker ? ["#sp-timer-toggle", "#sp-font-inc", "#sp-next"] : ["#btn-agenda", "#btn-theme", "#stage a", "#stage .quiz-option", "#stage [data-dactions] button", "#stage .ledger-row"]) {
      const control = h.$(selector); const target = control.children[0] || control;
      control.focus();
      for (const key of [" ", "Enter"]) {
        const e = h.key(key, target);
        assert.equal(e.defaultPrevented, false, `${selector} keeps native ${JSON.stringify(key)}`);
        assert.equal(h.messages.length, before, `${selector} cannot also drive the deck`);
      }
    }
    const control = h.$(speaker ? "#sp-timer-toggle" : "#btn-theme");
    control.click();
    if (speaker) assert.equal(JSON.parse(h.storage.get("ai-sdlc-deck:timer")).running, true);
    else assert.equal(h.doc.documentElement.getAttribute("data-theme"), "light");
    const count = h.messages.length;
    assert.equal(h.key(" ", speaker ? h.$("#sp-notes") : h.$("#deck")).defaultPrevented, true);
    assert.ok(h.messages.slice(count).some((m) => m.type === (speaker ? "next" : "state")), "non-control Space still navigates");
  }
  const h = mountDeck();
  h.$("#btn-theme").focus(); h.key("5"); h.key("Enter");
  assert.equal(h.active(), h.data.slides[4].id, "typed slide number still accepts Enter with a button focused");
  const id = h.active(); h.key("ArrowRight", h.$("#deck"), { ctrlKey: true }); assert.equal(h.active(), id);
});

test("a11y: skip links move focus without changing the slide hash and bare anchors do not reset slides", () => {
  for (const speaker of [false, true]) {
    const h = mountDeck({ speaker }); const hash = h.win.location.hash; const before = h.messages.length;
    h.$(".skip-link").focus();
    const e = h.$(".skip-link").click();
    assert.equal(e.defaultPrevented, true); assert.equal(h.win.location.hash, hash);
    assert.equal(h.doc.activeElement?.id, speaker ? "sp-notes" : "deck");
    assert.equal(h.$(".skip-link").getAttribute("href"), speaker ? "#sp-notes" : "#deck");
    assert.equal(h.messages.length, before);
    if (!speaker) {
      h.win.location.hash = "#deck"; h.win.fire("hashchange"); assert.equal(h.active(), h.data.slides[2].id);
      h.go(4); assert.equal(h.active(), h.data.slides[3].id, "real slide hashes still route");
    }
  }
});

test("a11y: speaker previews are inert aria-hidden pictures with no live diagram or pilot controls", () => {
  const h = mountDeck({ speaker: true, initialSlide: 8 });
  const wraps = h.doc.querySelectorAll("#speaker .sp-preview-wrap"); assert.equal(wraps.length, 2);
  for (const wrap of wraps) {
    assert.equal(wrap.inert, true); assert.equal(wrap.hasAttribute("inert"), true);
    assert.equal(wrap.getAttribute("aria-hidden"), "true");
    for (const el of wrap.querySelectorAll("a, [tabindex]")) assert.equal(el.getAttribute("tabindex"), "-1");
    for (const el of wrap.querySelectorAll("button")) assert.equal(el.disabled, true);
    for (const el of wrap.querySelectorAll("[data-hl]")) assert.equal(el.events.size, 0, "preview highlights have no listeners");
    for (const el of wrap.querySelectorAll("[data-pilot-prev], [data-pilot-next]")) assert.equal(el.getAttribute("aria-disabled"), "true");
  }
  assert.ok(h.$("#sp-next-title").textContent.includes(h.data.slides[8].title), "accessible next label carries the hidden picture's title");
  const deck = mountDeck(); assert.equal(deck.$("#stage [data-hl]").getAttribute("tabindex"), "0", "live diagrams remain interactive");
});

test("a11y: ledger list items contain native buttons that update exactly one telemetry panel", () => {
  const h = mountDeck(); const ledger = h.$("#stage ol.ledger");
  assert.equal(ledger.children.length, 6);
  const rows = ledger.children.map((li) => {
    assert.equal(li.tagName, "LI"); assert.equal(li.className, "ledger-item"); assert.equal(li.hasAttribute("role"), false);
    const button = li.querySelector("button.ledger-row"); assert.ok(button); assert.equal(button.parentElement === li, true);
    assert.equal(button.getAttribute("type"), "button"); return button;
  });
  const panels = h.doc.querySelectorAll("#stage [data-pilot-panel]"); assert.equal(panels.length, 6);
  function selected(index) {
    panels.forEach((p, i) => { assert.equal(p.hidden, i !== index); assert.equal(p.style.display, i === index ? "" : "none"); });
    rows.forEach((r, i) => { assert.equal(r.getAttribute("aria-pressed"), String(i === index)); assert.equal(r.classList.contains("is-active"), i === index); });
  }
  selected(0);
  rows.forEach((r, i) => { r.click(); selected(i); });
  h.$("#stage [data-pilot-next]").click(); selected(0);
  h.$("#stage [data-pilot-prev]").fire("keydown", { key: "Enter" }); selected(5);
  h.$("#stage [data-pilot-next]").fire("keydown", { key: " " }); selected(0);
});

test("a11y: live and prerendered slide subheadings use h2 directly below h1", () => {
  const h = mountDeck();
  const staticDoc = new DeckElement("document", h.doc);
  parseMarkup(read("presentation", "dist", "index.html"), staticDoc);
  for (const root of [staticDoc, h.doc]) {
    const slides = root.querySelectorAll("#stage .slide"); assert.equal(slides.length, 12);
    for (const s of slides) { assert.equal(s.querySelectorAll("h1").length, 1); assert.equal(s.querySelectorAll("h3, h4").length, 0); }
    for (const selector of [".col", ".card", ".outcome", ".decision-panel"]) {
      const containers = root.querySelectorAll(`#stage ${selector}`); assert.ok(containers.length > 0);
      for (const c of containers) assert.ok(c.querySelector("h2"), selector);
    }
  }
});

test("a11y: selection changes outlines not informative text opacity and keyboard focus stays visible", () => {
  const h = mountDeck(); const node = h.$("#stage [data-hl]");
  node.fire("focus");
  assert.equal(node.classList.contains("is-hl"), true); assert.equal(node.closest(".diagram").classList.contains("has-focus"), true);
  assert.equal(css(".diagram.has-focus [data-hl].is-hl .d-panel")["stroke-width"], "5.5");
  h.$("#stage [data-dactions] button").click();
  assert.ok(h.doc.querySelectorAll("#stage .outcome.is-dim").length > 0, "real decision result dims an unselected outcome");
  for (const el of h.doc.querySelectorAll("#stage .outcome, #stage [data-hl]")) {
    assert.equal(declarations((s) => el.matches(s), screen()).opacity ?? "1", "1", "informative text retains full opacity");
  }
  for (const selector of ["button:focus-visible", "a:focus-visible", "[tabindex]:focus-visible", ".diagram [data-hl]:focus-visible"]) {
    assert.equal(css(selector).outline, "3px solid var(--accent)", selector);
  }
  node.fire("blur"); assert.equal(node.classList.contains("is-hl"), false);
});

test("a11y: overlay bodies scroll separately from their Close controls", () => {
  const h = mountDeck();
  for (const id of ["dlg-help", "dlg-grid", "dlg-agenda"]) {
    const dlg = h.$(`#${id}`); const body = dlg.querySelector(".dlg-body"); const form = dlg.querySelector("form");
    assert.ok(body && form); assert.equal(body.parentElement === dlg, true); assert.equal(form.parentElement === dlg, true);
    assert.equal(body.querySelector("form") === null, true);
  }
  const help = h.$("#dlg-help .dlg-body");
  assert.equal(help.getAttribute("tabindex"), "0"); assert.equal(help.getAttribute("role"), "region"); assert.equal(help.getAttribute("aria-label"), "Shortcut list");
  assert.equal(css(".dlg-body")["overflow-y"], "auto"); assert.equal(css(".dlg-body")["min-height"], "0");
  assert.notEqual(css(".dlg form").position, "sticky");
  h.$("#btn-help").click(); assert.equal(h.$("#dlg-help").open, true);
  h.$("#dlg-help").fire("click", { clientX: -1, clientY: -1 }); assert.equal(h.$("#dlg-help").open, false);
});

test("mobile: keyboard reads tall slides and pans figures before navigating and resize removes obsolete tab stops", () => {
  const h = mountDeck(); const s = h.$("#stage .slide.active"); const fig = h.$("#stage .diagram"); const id = h.active();
  s.clientHeight = 200; s.scrollHeight = 900; fig.clientWidth = 300; fig.scrollWidth = 900; h.resize();
  assert.equal(s.getAttribute("tabindex"), "0"); assert.equal(fig.getAttribute("tabindex"), "0");
  assert.ok(fig.getAttribute("aria-label").endsWith("Scrolls sideways."));
  assert.ok(Number(fig.querySelector("svg").style["--vb-w"]) > 0, "natural SVG width is supplied to the reflow stylesheet");
  h.key("ArrowDown", s); assert.equal(s.scrollTop, 64); assert.equal(h.active(), id);
  h.key("PageDown", s); assert.equal(s.scrollTop, 234); assert.equal(h.active(), id);
  h.key("ArrowUp", s); assert.equal(s.scrollTop, 170);
  h.key("ArrowRight", fig); assert.equal(fig.scrollLeft, 80); assert.equal(h.active(), id);
  h.key("ArrowLeft", fig); assert.equal(fig.scrollLeft, 0); assert.equal(h.active(), id);
  s.scrollTop = 700; h.key("ArrowDown", s); assert.equal(h.active(), h.data.slides[3].id);
  s.scrollTop = 200; h.go(3); assert.equal(s.scrollTop, 0, "returning to a tall slide starts at its top");
  h.resize(screen({ width: 1440, height: 900 }));
  assert.equal(s.hasAttribute("tabindex"), false); assert.equal(fig.hasAttribute("tabindex"), false); assert.equal(fig.hasAttribute("aria-label"), false);
  h.resize(); // remains canvas until a real viewport change
  assert.equal(s.hasAttribute("tabindex"), false);
  h.resize(screen());
  assert.equal(s.getAttribute("tabindex"), "0"); assert.equal(fig.getAttribute("tabindex"), "0");
});

// ---------------------------------------------------------------------------------------------------------------------
// The briefing for the public instance: what it says about the engine, the fleet and visibility, and the three widgets that
// show it. The facts come from sdlc.yaml and package.json; the widgets run in the same shipped runtime as every test above.
// ---------------------------------------------------------------------------------------------------------------------
const WORD = /[A-Za-z0-9][A-Za-z0-9\-\u2019'.]*/g;
/** The words a room can see at this moment: the same measure as the build's budget (no SVG, scripts or hidden elements). */
function visibleWords(el) {
  let n = 0;
  (function walk(node) {
    if (!(node instanceof DeckElement)) { n += (String(node.textContent).match(WORD) || []).length; return; }
    if (["SVG", "SCRIPT", "STYLE"].includes(node.tagName) || node.hasAttribute("hidden")) return;
    node.childNodes.forEach(walk);
  })(el);
  return n;
}
const embeddedJson = (name) => JSON.parse(content("diagrams", `${name}.html`).match(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)[1]);
const everyContentFile = () => [["slides", ".md"], ["script", ".md"], ["diagrams", ".html"]].flatMap(([dir, ext]) =>
  fs.readdirSync(path.join(ROOT, "presentation", "content", dir)).filter((f) => f.endsWith(ext)).map((f) => ({ file: `${dir}/${f}`, text: content(dir, f) })));
const semver = (v) => v.replace(/^v/, "").split(".").map(Number);
const atLeast = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

test("the briefing is public: no GitHub App id, no private-repository or collaborator wording, and the engine install is explained both ways", () => {
  for (const { file, text } of everyContentFile()) {
    assert.doesNotMatch(text, /\b5671833\b|GitHub App #\d+/, `${file} states a GitHub App id`);
    assert.doesNotMatch(text, /repositories are private|\bcollaborators?\b/i, `${file} still talks about private repositories or collaborators`);
  }
  const chips = content("slides", "01-overview-and-security.md").match(/:::chips\n([\s\S]*?)\n:::/)[1].split("\n");
  assert.deepEqual(chips, ["- ai-sdlc-factory v0.2.0 Engine", "- Zero External Servers", "- Human-Merged PRs"]);
  const spoken = content("script", "03-pilot-and-onboarding.md");
  for (const phrase of ["These repositories are public", "the manifest says private is false", "plain npm ci that ignores install scripts", "No factory token is minted",
    "you set private to true instead", "mints a read token from the App", "three git config URL rewrites"]) assert.ok(spoken.includes(phrase), `the S5 script says: ${phrase}`);
  assert.match(content("slides", "03-pilot-and-onboarding.md"), /factory:\n {2}package: ai-sdlc-factory\n {2}private: false/, "slide 10 shows the factory block");
});

test("the deck names the engine ai-sdlc-factory and its version, never the old reconcile.mjs, and is never behind the pin in package.json", () => {
  for (const { file, text } of everyContentFile()) assert.doesNotMatch(text, /reconcile\.mjs/, `${file} still names reconcile.mjs, which is now sdlc-reconcile of the engine`);
  assert.ok(content("diagrams", "fleet-topology.html").includes("sdlc.yaml → sdlc-reconcile (ai-sdlc-factory v0.2.0)"), "the S1 band of the topology names the command and the engine version");
  const s1 = content("slides", "02-workstreams-and-cascade.md").split("\n---\n")[1];
  for (const name of ["Instance · This Repo", "Engine · Public Package", "`ai-sdlc-factory v0.2.0`", "`sdlc-reconcile`", "`sdlc-bootstrap`", "`sdlc-onboard`", "`.github/workflows/`"]) assert.ok(s1.includes(name), `slide 5 lists ${name}`);
  const script = content("script", "02-workstreams-and-cascade.md");
  for (const phrase of ["the instance, this repository", "a public package called ai-sdlc-factory", "plain npm ci"]) assert.ok(script.includes(phrase), `the S1 script says: ${phrase}`);
  // the engine version that the briefing documents is the one that package.json pins, or newer while the bump is in flight
  const pin = JSON.parse(read("package.json")).dependencies["ai-sdlc-factory"].match(/#v?(\d+\.\d+\.\d+)$/);
  assert.ok(pin, "package.json pins ai-sdlc-factory at a tag");
  const named = new Set((everyContentFile().map((f) => f.text).join("\n").match(/ai-sdlc-factory v(\d+\.\d+\.\d+)/g) || []).map((m) => m.match(/v(.+)$/)[1]));
  assert.ok(named.size >= 1, "the deck states the engine version");
  for (const version of named) assert.ok(atLeast(semver(version), semver(pin[1])), `the deck documents ai-sdlc-factory v${version}, which is older than the v${pin[1]} that package.json pins`);
});

test("slide 8 lists every edge of sdlc.yaml in the card of its mode, and the script gives the same counts", () => {
  const { edges } = fleetOf(YAML.parse(read("sdlc.yaml")));
  const html = content("diagrams", "cascade-decision.html");
  const tree = embeddedJson("cascade-decision");
  const [, mechanical, ai] = html.split(/data-outcome="(?:mechanical|ai)"/);
  const chipsIn = (block) => [...block.matchAll(/data-edge="([^"]+)"/g)].map((m) => m[1]).sort();
  const byMode = (mode) => edges.filter((e) => e.mode === mode).map((e) => e.edgeId).sort();
  assert.deepEqual(chipsIn(mechanical), byMode("mechanical"), "the Mechanical card lists the mechanical edges");
  assert.deepEqual(chipsIn(ai), byMode("ai-adaptation"), "the AI-Adaptation card lists the AI-adaptation edges");
  for (const e of edges) {
    const node = tree[`edge-${e.edgeId}`];
    assert.ok(node, `a result for ${e.edgeId}`);
    assert.equal(node.result, e.mode === "mechanical" ? "mechanical" : "ai"); assert.equal(node.edge, e.edgeId);
  }
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const script = content("script", "02-workstreams-and-cascade.md");
  assert.ok(script.includes(`declares ${words[edges.length]} edges today: ${words[byMode("mechanical").length]} mechanical and ${words[byMode("ai-adaptation").length]} AI-adaptation`),
    "the S4 script states how many edges sdlc.yaml declares, and how many are mechanical and AI-adaptation");
});

test("the changePolicy explorer files findings by the three policies, names real projects, and agrees with every changePolicy that sdlc.yaml declares", () => {
  const manifest = YAML.parse(read("sdlc.yaml"));
  const cfg = embeddedJson("upkeep-explorer");
  assert.deepEqual(Object.keys(cfg.policies).sort(), ["corrections-and-additions", "corrections-only", "judgement-and-flag"]);
  const projectKeys = new Set(manifest.projects.map((p) => p.projectKey));
  for (const [name, p] of Object.entries(cfg.policies)) {
    for (const key of p.projects) assert.ok(projectKeys.has(key), `${name} names ${key}, which is not a project of sdlc.yaml`);
    for (const key of p.projects) {
      const declared = manifest.projects.find((x) => x.projectKey === key).driftAudit.changePolicy;
      if (declared !== undefined) assert.equal(declared, name, `sdlc.yaml gives ${key} the policy ${declared}, the explorer files it under ${name}`);
    }
    // the findings that a policy leaves for a human are exactly those that it does not file as recommended
    const filed = new Set(p.recommended);
    assert.deepEqual([...new Set([...p.recommended, ...p.human])].sort(), ["add", "fix", "judge"], `${name} accounts for every finding`);
    assert.deepEqual(p.human.filter((k) => filed.has(k)), [], `${name} does not file a finding twice`);
    assert.deepEqual(p.pr, p.recommended.filter((k) => !p.flag.includes(k)), `${name}: the pull request holds what is recommended, minus what it flags`);
  }
  for (const project of manifest.projects) {
    const declared = project.driftAudit.changePolicy;
    if (declared === undefined) continue;
    assert.ok(cfg.policies[declared], `${project.projectKey} declares the unknown policy ${declared}`);
    if (declared !== "corrections-only") assert.ok(cfg.policies[declared].projects.includes(project.projectKey), `the explorer names ${project.projectKey} under ${declared}`);
  }
  assert.deepEqual(cfg.policies["corrections-only"].projects, [], "the default policy is not claimed by any project");
});

test("workstream inspector: pinning S2 swaps the callout for its role, inputs and outputs and a link to its slide; a second press or Escape restores it", () => {
  const h = mountDeck({ initialSlide: 3 });
  const callout = h.$("#stage .callout"); const fig = h.$("#stage .diagram"); const slide = h.$("#stage .slide.active");
  const nodes = h.doc.querySelectorAll("#stage [data-hl]"); assert.equal(nodes.length, 5);
  for (const n of nodes) { assert.equal(n.getAttribute("role"), "button"); assert.equal(n.getAttribute("aria-pressed"), "false"); assert.equal(n.getAttribute("tabindex"), "0"); }
  const panel = h.$("#stage .inspector"); assert.equal(panel.hidden, true); assert.equal(callout.hidden, false);
  assert.equal(h.$("#stage .callout-title").textContent.includes("Zero-Infrastructure State"), true);
  const s2 = h.$('#stage [data-hl="s2"]');
  s2.click();
  assert.equal(panel.hidden, false); assert.equal(callout.hidden, true); assert.equal(fig.classList.contains("is-inspecting"), true);
  assert.equal(s2.getAttribute("aria-pressed"), "true"); assert.equal(s2.classList.contains("is-selected"), true);
  assert.equal(nodes.filter((n) => n.getAttribute("aria-pressed") === "true").length, 1, "one group is pinned at a time");
  for (const text of ["S2", "Upstream Drift", "watchUrls", "citedPages", "packageManifests", "drift report issue", "one reviewable PR"]) assert.ok(panel.textContent.includes(text), `the inspector shows ${text}`);
  assert.equal(panel.querySelector("a.insp-go").getAttribute("href"), "#/s2-drift-harness");
  assert.ok(visibleWords(slide) <= 70, `slide 3 shows ${visibleWords(slide)} words with S2 pinned`);
  // another group replaces it; the same key (Enter or Space) or Escape closes it
  h.$('#stage [data-hl="s5"]').click(); assert.equal(s2.getAttribute("aria-pressed"), "false"); assert.ok(panel.textContent.includes("Bootstrap & Self-Cascade"));
  assert.equal(panel.querySelector("a.insp-go").getAttribute("href"), "#/self-cascade-onboard");
  const enter = h.key("Enter", h.$('#stage [data-hl="s5"]')); assert.equal(enter.defaultPrevented, true); assert.equal(panel.hidden, true); assert.equal(callout.hidden, false);
  h.key(" ", s2); assert.equal(panel.hidden, false);
  h.key("Escape", s2); assert.equal(panel.hidden, true); assert.equal(callout.hidden, false); assert.equal(fig.classList.contains("is-inspecting"), false);
  assert.equal(h.active(), h.data.slides[2].id, "pinning a workstream never changes slide");
  for (const key of ["s1", "s2", "s3", "s4", "s5"]) {
    h.$(`#stage [data-hl="${key}"]`).click(); assert.ok(visibleWords(slide) <= 70, `${key} pinned: ${visibleWords(slide)} words`);
    assert.ok(h.data.slides.some((s) => `#/${s.id}` === panel.querySelector("a.insp-go").getAttribute("href")), `${key} links to a slide of the deck`);
    h.$(`#stage [data-hl="${key}"]`).click();
  }
  const focus = h.$('#stage [data-hl="s3"]'); focus.fire("focus"); assert.equal(focus.classList.contains("is-hl"), true, "hover and focus highlight still work");
});

test("changePolicy explorer: each policy files the three findings under Recommended or For a human and shapes the pull request", () => {
  const h = mountDeck({ initialSlide: 6 });
  const box = h.$("#stage [data-upkeep]"); const slide = h.$("#stage .slide.active");
  const items = (key) => box.querySelectorAll(`[data-uk-items="${key}"] .uk-item`).map((e) => e.textContent);
  const human = box.querySelector('[data-uk-sec="human"]'); const flag = box.querySelector('[data-uk-sec="flag"]');
  const pressed = () => box.querySelectorAll("[data-policy]").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.policy);
  assert.deepEqual(pressed(), ["corrections-only"]);
  assert.deepEqual(items("recommended"), ["Correction"]); assert.deepEqual(items("human"), ["Addition", "Judgement call"]); assert.deepEqual(items("pr"), ["Correction"]);
  assert.equal(flag.hidden, true); assert.equal(box.querySelector("[data-uk-used]").textContent, "Default when unset");
  assert.equal(box.querySelector("[data-uk-note]").textContent, "Opens every source, then applies corrections.");
  assert.ok(visibleWords(slide) <= 58, `the default state shows ${visibleWords(slide)} words`);
  box.querySelector('[data-policy="corrections-and-additions"]').click();
  assert.deepEqual(pressed(), ["corrections-and-additions"]);
  assert.deepEqual(items("recommended"), ["Correction", "Addition"]); assert.deepEqual(items("human"), ["Judgement call"]); assert.deepEqual(items("pr"), ["Correction", "Addition"]);
  assert.equal(flag.hidden, true); assert.equal(human.classList.contains("is-omitted"), false);
  assert.equal(box.querySelector("[data-uk-used]").textContent, "Used by gh-admin-msft, copilot-lab, github-intermediate, pipeline-showcase");
  assert.ok(visibleWords(slide) <= 70, `${visibleWords(slide)} words`);
  box.querySelector('[data-policy="judgement-and-flag"]').click();
  assert.deepEqual(pressed(), ["judgement-and-flag"]);
  assert.deepEqual(items("recommended"), ["Correction", "Addition", "Judgement call"]); assert.deepEqual(items("pr"), ["Correction", "Addition"]);
  assert.equal(human.classList.contains("is-omitted"), true); assert.ok(human.textContent.includes("Omitted when empty"), "an empty For a human is shown as omitted");
  assert.equal(flag.hidden, false); assert.ok(flag.textContent.includes("## Judgement calls — review these")); assert.deepEqual(items("flag"), ["Judgement call"]);
  assert.equal(box.querySelector("[data-uk-used]").textContent, "Used by ai-sdlc");
  assert.ok(visibleWords(slide) <= 70, `${visibleWords(slide)} words`);
  const key = h.key("Enter", box.querySelector('[data-policy="corrections-only"]'));
  assert.equal(key.defaultPrevented, false, "a focused policy button keeps its native Enter"); assert.equal(h.active(), h.data.slides[5].id, "Enter and Space never change slide from inside the explorer");
  box.querySelector('[data-policy="corrections-only"]').click();
  assert.deepEqual(items("human"), ["Addition", "Judgement call"]); assert.equal(flag.hidden, true); assert.equal(flag.textContent, "");
  // the markup that a static reader gets is the state that the script draws first
  const staticDoc = new DeckElement("document", h.doc); parseMarkup(read("presentation", "dist", "index.html"), staticDoc);
  const flat = (el) => el.textContent.replace(/\s+/g, " ").trim();
  assert.equal(flat(staticDoc.querySelector("#stage [data-upkeep]")), flat(mountDeck({ initialSlide: 6 }).$("#stage [data-upkeep]")), "static markup and first render agree");
});

test("cascade decision: edge chips walk the tree to their edge's mode, explain it, and Start over resets them", () => {
  const h = mountDeck({ initialSlide: 8 });
  const tree = h.$("#stage [data-decision]");
  const chip = (name) => tree.querySelector(`[data-edge="${name}"]`);
  const outcome = (name) => tree.querySelector(`[data-outcome="${name}"]`);
  const note = tree.querySelector("[data-dnote]"); const question = tree.querySelector("[data-dq]");
  assert.equal(note.hidden, true);
  assert.equal(tree.querySelectorAll("[data-edge]").length, 5);
  chip("github-intermediate").click();
  assert.equal(outcome("mechanical").classList.contains("is-picked"), true); assert.equal(outcome("ai").classList.contains("is-dim"), true);
  assert.equal(chip("github-intermediate").getAttribute("aria-pressed"), "true"); assert.equal(chip("github-intermediate").classList.contains("is-picked"), true);
  assert.equal(chip("copilot-lab").getAttribute("aria-pressed"), "false");
  assert.equal(note.hidden, false); assert.ok(note.textContent.includes("It began as AI-adaptation"), "the note says why github-intermediate is mechanical");
  assert.ok(note.textContent.includes("npm run import:github-intermediate"));
  assert.equal(question.classList.contains("decision-result"), true);
  assert.deepEqual(tree.querySelectorAll("[data-dactions] button").map((b) => b.textContent), ["Start over"]);
  chip("copilot-lab").click();
  assert.equal(outcome("ai").classList.contains("is-picked"), true); assert.equal(outcome("mechanical").classList.contains("is-dim"), true);
  assert.equal(chip("github-intermediate").getAttribute("aria-pressed"), "false"); assert.equal(chip("copilot-lab").getAttribute("aria-pressed"), "true");
  tree.querySelector("[data-dactions] button").click();
  assert.equal(note.hidden, true); assert.equal(tree.querySelectorAll("[data-edge]").filter((c) => c.getAttribute("aria-pressed") === "true").length, 0);
  assert.equal(outcome("mechanical").classList.contains("is-picked") || outcome("ai").classList.contains("is-picked"), false);
  // the walk still ends where it did, and now says what the agent may run
  tree.querySelector("[data-dactions] button").click();                    // Yes
  assert.equal(outcome("mechanical").classList.contains("is-picked"), true);
  tree.querySelector("[data-dactions] button").click();                    // Start over
  const [, no] = tree.querySelectorAll("[data-dactions] button"); no.click();
  tree.querySelector("[data-dactions] button").click();                    // second question: Yes
  assert.equal(outcome("ai").classList.contains("is-picked"), true);
  for (const phrase of ["`cd`", "`agentSandbox.bashCommands`", "`curl`, `gh` and `wget` stay refused"]) assert.ok(embeddedJson("cascade-decision").ai.note.includes(phrase), `the AI-adaptation note says ${phrase}`);
  assert.ok(visibleWords(h.$("#stage .slide.active")) <= 70);
});

test("a11y: the new controls are disabled pictures in the speaker previews of slides 3, 6 and 8", () => {
  const widgets = { 3: ["[data-hl]", 5], 6: ["[data-policy]", 3], 8: ["[data-edge]", 5] };
  for (const [initialSlide, [selector, count]] of Object.entries(widgets)) {
    const h = mountDeck({ speaker: true, initialSlide: Number(initialSlide) });
    const wraps = h.doc.querySelectorAll("#speaker .sp-preview-wrap");
    assert.equal(wraps[0].querySelectorAll(selector).length, count, `slide ${initialSlide} draws its ${selector} controls in the current preview`);
    for (const wrap of wraps) {
      assert.equal(wrap.querySelectorAll(".inspector").length, 0, "a preview builds no inspector");
      for (const el of wrap.querySelectorAll("button")) assert.equal(el.disabled, true, `${initialSlide}: ${el.className}`);
      for (const el of wrap.querySelectorAll("a, [tabindex]")) assert.equal(el.getAttribute("tabindex"), "-1");
      for (const el of wrap.querySelectorAll("[data-hl], [data-policy], [data-edge]")) assert.equal(el.events.size, 0, `${el.tagName} in a preview has no listeners`);
      for (const el of wrap.querySelectorAll("[data-hl]")) assert.equal(el.getAttribute("role"), "img", "preview groups stay pictures");
    }
  }
});

// Contrast is computed from the tokens in styles.css, for both themes, on every surface a text token sits on (the flat ones and the
// accent, orange, purple and green tints over them). Text holds 5:1, the tone colours 4.5:1 and a control's outline 3:1.
const toRgb = (value) => {
  const v = value.trim(); const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(",").map(Number); return { rgb: p.slice(0, 3), a: p[3] ?? 1 }; }
  const h = v.replace("#", ""); const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return { rgb: [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)), a: 1 };
};
const luminance = ([r, g, b]) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrastOf = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const blend = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));

for (const theme of ["dark", "light"]) {
  test(`contrast (${theme}): text tokens hold 5:1 on every surface, tones 4.5:1, controls 3:1`, () => {
    const tokens = { ...css(":root"), ...(theme === "light" ? css(':root[data-theme="light"]') : {}) };
    const t = (name) => toRgb(tokens[`--${name}`]);
    const flat = Object.fromEntries(["bg", "bg-deep", "surface", "surface-hi", "surface-2", "code-bg"].map((n) => [n, t(n).rgb]));
    const tinted = {};
    for (const tint of ["accent", "orange", "purple", "green"]) for (const under of ["bg", "surface"]) tinted[`${tint}-soft over ${under}`] = blend(t(`${tint}-soft`), flat[under]);
    const surfaces = { ...flat, ...tinted };
    for (const [name, bg] of Object.entries(surfaces)) {
      const texts = name.startsWith("accent-soft") || name.startsWith("bg") || name in flat ? ["text", "text-2", "muted", "accent"] : ["text", "text-2"];
      for (const text of texts) {
        if (text === "muted" && /^(orange|purple|green)-soft/.test(name)) continue;
        assert.ok(contrastOf(t(text).rgb, bg) >= 5, `${theme}: --${text} on ${name} is ${contrastOf(t(text).rgb, bg).toFixed(2)}:1`);
      }
    }
    for (const tone of ["green", "orange", "purple", "red"]) for (const under of ["bg", "surface", "code-bg"]) {
      assert.ok(contrastOf(t(tone).rgb, flat[under]) >= 4.5, `${theme}: --${tone} on ${under} is ${contrastOf(t(tone).rgb, flat[under]).toFixed(2)}:1`);
    }
    for (const tone of ["accent", "purple"]) assert.ok(contrastOf(t("accent-ink").rgb, t(tone).rgb) >= 4.5, `${theme}: --accent-ink on --${tone} is ${contrastOf(t("accent-ink").rgb, t(tone).rgb).toFixed(2)}:1`);
    for (const under of ["bg", "surface"]) assert.ok(contrastOf(t("line-strong").rgb, flat[under]) >= 3, `${theme}: --line-strong on ${under} is ${contrastOf(t("line-strong").rgb, flat[under]).toFixed(2)}:1`);
  });
}

test("responsive: the new components reflow to one column on a phone and keep 44px targets", () => {
  const phone = screen({ width: 390, height: 844 });
  assert.equal(css("#stage .uk-flow", phone)["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(css("#stage .uk-flow", phone)["min-height"], "0", "the fixed-height flow of the canvas is released on a phone");
  assert.equal(css("#stage .callout.inspector", phone)["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(css("#stage .insp-fields", phone)["grid-template-columns"], "minmax(0, 1fr)");
  for (const selector of ["#stage .uk-opt", "#stage .edge-chip", "#stage .insp-go"]) assert.equal(css(selector, phone)["min-height"], "var(--tap)", selector);
  assert.equal(css("#stage .uk-flow", screen({ width: 1440, height: 900 }))["grid-template-columns"], undefined, "the canvas keeps its four-stage row");
  assert.match(css(".uk-flow")["grid-template-columns"], /^minmax\(0, 1fr\) 40px /, "four stages joined by three links");
  const reduced = screen({ motion: "reduce" });
  for (const selector of [".uk-opt", ".edge-chip", ".btn"]) assert.equal(css(selector, reduced).transition, "none", selector);
  assert.equal(css(".uk-item", reduced).animation, "none"); assert.notEqual(css(".uk-item").animation, "none", "positive control: the entrance runs when motion is allowed");
});

test("immersion deck and PDF handout are built, single-presenter, and ready for the portfolio importer", () => {
  const htmlPath = path.join(ROOT, "immersion", "dist", "index.html");
  const scriptPath = path.join(ROOT, "immersion", "docs", "SPEAKER-SCRIPT.md");
  const pdfPath = path.join(ROOT, "immersion", "docs", "Scaling-the-Agentic-SDLC.pdf");
  assert.equal(fs.existsSync(htmlPath), true, "immersion/dist/index.html exists");
  assert.equal(fs.existsSync(scriptPath), true, "immersion/docs/SPEAKER-SCRIPT.md exists");
  assert.equal(fs.existsSync(pdfPath), true, "immersion/docs/Scaling-the-Agentic-SDLC.pdf exists");

  const html = fs.readFileSync(htmlPath, "utf8");
  assert.ok(html.includes('<div class="brand topbar-left">'), "immersion deck carries the topbar-left hook for the portfolio importer");
  assert.equal((html.match(/<section class="slide\b/g) || []).length, 25, "immersion deck renders all 25 slides in #stage");
  assert.ok(html.includes("Scaling the Agentic SDLC · AI-DLC Immersion"), "immersion deck title is sanitized");
  assert.ok(html.includes("John Hain"), "immersion deck names single presenter John Hain");

  const pdfHeader = fs.readFileSync(pdfPath).subarray(0, 5).toString("ascii");
  assert.equal(pdfHeader, "%PDF-", "immersion handout is a valid PDF document");
});

