// Declared dependency names and versions of a package manifest (SPEC-02 AC12), so that the agent can establish a library
// or framework upgrade such as 17 -> 18 against the version it corroborates.
//
// Supported: package.json, MSBuild project files (.csproj, .fsproj, .vbproj, .props, .targets), requirements*.txt and
// go.mod. Any other file is snapshotted without a dependency list (`parser: "none"`): the list is not guessed.

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const decodeXml = (value) =>
  String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function parsePackageJson(text) {
  const data = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("package.json is not a JSON object");
  const dependencies = [];
  for (const scope of NPM_SECTIONS) {
    const entries = data[scope];
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries).sort(compare)) {
      const version = entries[name];
      dependencies.push({ name, version: typeof version === "string" ? version : JSON.stringify(version), scope });
    }
  }
  const result = { parser: "package.json", dependencies };
  if (data.engines !== null && typeof data.engines === "object" && !Array.isArray(data.engines)) {
    result.engines = Object.fromEntries(Object.keys(data.engines).sort(compare).map((name) => [name, String(data.engines[name])]));
  }
  return result;
}

function attributesOf(text) {
  const attributes = {};
  for (const match of text.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1]] = decodeXml(match[2] ?? match[3]);
  return attributes;
}

function parseMsBuild(text) {
  const source = text.replace(/<!--[\s\S]*?-->/g, "");
  const dependencies = [];
  const pattern = /<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  for (const match of source.matchAll(pattern)) {
    const attributes = attributesOf(match[2]);
    const name = attributes.Include ?? attributes.Update;
    if (!name) continue;
    let version = attributes.Version ?? attributes.VersionOverride ?? null;
    if (version === null && match[3] !== undefined) {
      const child = /<Version(?:Override)?>([\s\S]*?)<\/Version(?:Override)?>/.exec(match[3]);
      if (child) version = decodeXml(child[1].trim());
    }
    dependencies.push({ name, version, scope: match[1] });
  }
  dependencies.sort((a, b) => compare(a.name, b.name) || compare(a.scope, b.scope) || compare(String(a.version), String(b.version)));
  const frameworks = [];
  for (const match of source.matchAll(/<TargetFrameworks?>([\s\S]*?)<\/TargetFrameworks?>/g)) {
    for (const value of decodeXml(match[1]).split(";")) if (value.trim() !== "") frameworks.push(value.trim());
  }
  return { parser: "msbuild", dependencies, frameworks: [...new Set(frameworks)].sort(compare) };
}

function parseRequirements(text) {
  const dependencies = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("-") || /^[a-z]+:\/\//i.test(line)) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([^;\s].*?)?\s*(?:;.*)?$/.exec(line);
    if (match) dependencies.push({ name: match[1], version: match[2] ?? null, scope: "requirements" });
  }
  dependencies.sort((a, b) => compare(a.name, b.name));
  return { parser: "requirements.txt", dependencies };
}

function parseGoMod(text) {
  const dependencies = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (inBlock) {
      if (line === ")") inBlock = false;
      else {
        const [name, version] = line.split(/\s+/);
        if (name && version) dependencies.push({ name, version, scope: "require" });
      }
      continue;
    }
    const goVersion = /^go\s+(\S+)$/.exec(line);
    if (goVersion) dependencies.push({ name: "go", version: goVersion[1], scope: "go" });
    else if (/^require\s*\($/.test(line)) inBlock = true;
    else {
      const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
      if (single) dependencies.push({ name: single[1], version: single[2], scope: "require" });
    }
  }
  dependencies.sort((a, b) => compare(a.scope, b.scope) || compare(a.name, b.name));
  return { parser: "go.mod", dependencies };
}

/**
 * @param {string} relativePath path of the file in the checkout (POSIX)
 * @param {Buffer} bytes its content
 * @returns {{ parser: string, dependencies: object[] | null, error?: string }}
 */
export function parseManifestFile(relativePath, bytes) {
  const base = relativePath.split("/").pop().toLowerCase();
  let parse = null;
  if (base === "package.json") parse = parsePackageJson;
  else if (/\.(?:csproj|fsproj|vbproj|props|targets)$/.test(base)) parse = parseMsBuild;
  else if (/^requirements[^/]*\.txt$/.test(base)) parse = parseRequirements;
  else if (base === "go.mod") parse = parseGoMod;
  if (parse === null) return { parser: "none", dependencies: null };
  try {
    return parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    return { parser: "none", dependencies: null, error: `could not parse ${base}: ${error.message}` };
  }
}
