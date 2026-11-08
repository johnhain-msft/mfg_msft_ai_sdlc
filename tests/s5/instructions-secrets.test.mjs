// AC50: instructions/<projectKey>.md never holds a credential or the content of a secret file. An --instructions file is read only when it lies
// inside the working copy of the central orchestrator repository (symbolic links resolved) and is not a secret file by name; its text, like a
// literal --instructions text, is refused when it holds a credential of any provider that the scanner knows. The values below are assembled at
// run time, so that no literal credential is in this file, and no diagnostic may echo a value that was read.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoCredentials, readOperatorInstructions } from "../../bin/lib/instructions-file.mjs";
import { REPO_ROOT, assertNoSecrets, createScenario, fixtureRepos } from "./helpers/harness.mjs";

const AWS_KEY_ID = `AK${"IA"}${"Z".repeat(16)}`;
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
const ANTHROPIC = `sk-${"ant-api03-"}${"x".repeat(40)}`;
const OPENAI = `sk-${"proj-"}${"A1b2C3d4".repeat(6)}`;
const GOOGLE = `AI${"za"}${"A1b2C3d4E5".repeat(3)}A1b2C`;
const SLACK = `xox${"b"}-1234567890-abcdefghijklmnop`;
const JWT = [`eyJ${"hbGciOiJIUzI1NiJ9"}`, `eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}`, "abcdefghijklmnop"].join(".");
const NPM = `npm_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
const STRIPE = `sk_${"live"}_${"A1b2C3d4E5f6G7h8"}`;
const HUGGING_FACE = `hf_${"A1b2C3d4E5".repeat(3)}`;
const URL_PASSWORD = `postgres://svc:${"S3cr3tP4ss"}@db.example.com/app`;
const AZURE = `DefaultEndpointsProtocol=https;AccountName=store;AccountKey=${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo"}=`;
const ENV_LINE = `MY_SERVICE_SECRET=${"a1B2c3D4e5F6g7H8"}`;
const CREDENTIALS_FILE = `[default]\naws_access_key_id = ${AWS_KEY_ID}\naws_secret_access_key = ${AWS_SECRET}\n\nANTHROPIC_API_KEY=${ANTHROPIC}\n`;
const VALUES = [AWS_KEY_ID, AWS_SECRET, ANTHROPIC, OPENAI, GOOGLE, SLACK, JWT, NPM, STRIPE, HUGGING_FACE, "S3cr3tP4ss", ENV_LINE.split("=")[1]];
const echoes = (message) => VALUES.some((value) => message.includes(value));

function withTree(callback) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-instructions-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  try {
    return callback({ base, root, outside });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

// --- the scanner -----------------------------------------------------------------------------------------------------------

const CREDENTIALS = [
  ["a PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfixture\n-----END RSA PRIVATE KEY-----"],
  ["an OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n"],
  ["an AWS access key ID", `aws_access_key_id = ${AWS_KEY_ID}`],
  ["an AWS secret access key", `aws_secret_access_key = ${AWS_SECRET}`],
  ["an Anthropic API key", `use ${ANTHROPIC} for the checks`],
  ["an OpenAI API key", `OPENAI_KEY: ${OPENAI}`],
  ["a Google API key", `key=${GOOGLE}`],
  ["a Slack token", `post to Slack with ${SLACK}`],
  ["a JSON Web Token", `token ${JWT}`],
  ["an npm token", `//registry.npmjs.org/:_authToken=${NPM}`],
  ["a Stripe key", `charge with ${STRIPE}`],
  ["a Hugging Face token", `export ${HUGGING_FACE}`],
  ["a password inside a URL", `connect to ${URL_PASSWORD}`],
  ["an Azure storage connection string", AZURE],
  ["an Authorization header", `curl -H "Authorization: Bearer ${"abcdef0123456789abcdef"}" https://api.example.com`],
  ["an .env style assignment of a secret", `# settings\n${ENV_LINE}\n`],
  ["a JSON api_key", `{ "api_key": "${"a1B2c3D4e5F6g7H8"}" }`],
  ["a GitLab token", `glpat-${"A1b2C3d4E5f6G7h8I9j0"}`],
  ["a Twilio key", `SK${"0123456789abcdef".repeat(2)}`],
  ["the content of ~/.netrc", "machine github.com login svc password hunter2hunter2\n"],
  ["the key data of a kubeconfig", `users:\n- user:\n    client-key-data: ${"LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ"}\n`],
  ["the auth of a Docker config", `{ "auths": { "registry.example.com": { "auth": "${"dXNlcjpzM2NyM3RQNHNzdzByZA=="}" } } }`],
  ["the content of ~/.aws/credentials", CREDENTIALS_FILE],
];

for (const [label, text] of CREDENTIALS) {
  test(`AC50: ${label} is refused, and the diagnostic does not echo it`, () => {
    assert.throws(
      () => assertNoCredentials(text, "--instructions"),
      (error) => error.code === "instructions-credential" && /^--instructions appears to contain a credential/.test(error.message) && !echoes(error.message) && !error.message.includes(text.slice(0, 40)),
    );
  });
}

const BENIGN = [
  "Keep the docs current and rebuild the deck with `npm run build`.",
  "Set the OPENAI_API_KEY secret in the repository settings, then run the workflow again.",
  "- `GH_TOKEN`: a fine-grained personal access token owned by a user account.",
  "token: ${{ secrets.GITHUB_TOKEN }}",
  "git remote set-url origin https://x-access-token:${GIT_TOKEN}@github.com/owner/repo.git",
  "Clone git@github.com:owner/repo.git and see https://learn.microsoft.com/azure/overview.",
  "The password reset flow is described in docs/password-reset.md.",
  "Compare commit 0123456789abcdef0123456789abcdef01234567 with the previous release.",
  "secret scanning: enabled for every repository",
  "API_KEY=<your key here>",
  "token_count=1234567890123",
];

for (const text of BENIGN) {
  test(`AC50: ordinary instructions are not refused: ${JSON.stringify(text.slice(0, 60))}`, () => {
    assert.doesNotThrow(() => assertNoCredentials(text, "--instructions"));
  });
}

// --- a credential inside a name or a path ----------------------------------------------------------------------------------------
// What the inspection finds (a manifest path, a workflow path, the key of a provenance file) is held to this scanner too, and a credential
// sits as easily in the middle of such a name (`packages/backup_<token>/package.json`, `<token>_old`) as it stands alone. `\b` counts `_` as
// a part of a word, so it did not see a token after `backup_` or, for a token of a fixed length, before `_old`, while the same token standing
// alone was seen. Every provider that the scanner knows is therefore tried in each of those places. The tokens are assembled at run time.

const SAMPLE = "A1b2C3d4E5f6G7h8I9j0";
const HEX_32 = "0123456789abcdef".repeat(2);
const GITHUB_CLASSIC = ["ghp", SAMPLE.repeat(2)].join("_");
const GITHUB_FINE_GRAINED = ["github", "pat", SAMPLE.repeat(3)].join("_");
const GITHUB_SERVER = ["ghs", SAMPLE.repeat(2)].join("_");

const NAMED_CREDENTIALS = [
  ["a classic GitHub token", GITHUB_CLASSIC],
  ["a GitHub server-to-server token", GITHUB_SERVER],
  ["a fine-grained GitHub token", GITHUB_FINE_GRAINED],
  ["an AWS access key ID", AWS_KEY_ID],
  ["an Anthropic API key", ANTHROPIC],
  ["an OpenAI API key", OPENAI],
  ["a Google API key", GOOGLE],
  ["a Google OAuth client secret", `GOCSPX-${SAMPLE}`],
  ["a Slack token", SLACK],
  ["a Stripe key", STRIPE],
  ["an npm token", NPM],
  ["a Hugging Face token", HUGGING_FACE],
  ["a SendGrid key", `SG.${SAMPLE}.${SAMPLE}`],
  ["a JSON Web Token", JWT],
  ["a GitLab token", `glpat-${SAMPLE}`],
  ["a DigitalOcean token", `dop_v1_${"a1b2c3d4".repeat(8)}`],
  ["a Databricks token", `dapi${HEX_32}`],
  ["a Docker Hub token", `dckr_pat_${SAMPLE}`],
  ["a PyPI token", `pypi-AgEIcHlwaS5vcmc${SAMPLE}`],
  ["a Twilio key", `SK${HEX_32}`],
  ["a Shopify token", `shpat_${HEX_32}`],
  ["a Telegram bot token", `123456789:AA${SAMPLE.repeat(2).slice(0, 33)}`],
  ["the content of ~/.netrc", "machine github.com login svc password hunter2hunter2"],
  ["the key data of a kubeconfig", `client-key-data: ${"LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ"}`],
  ["a PuTTY key file", "PuTTY-User-Key-File-3: ssh-ed25519"],
  ["an Azure storage account key", `AccountKey=${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo"}=`],
  ["a password inside a URL", URL_PASSWORD],
  ["an Authorization header", `Authorization: Bearer ${"abcdef0123456789abcdef"}`],
];

const refusedAsCredential = (text, token) =>
  assert.throws(
    () => assertNoCredentials(text, "a name or a path detected in the inspected repository"),
    (error) => error.code === "instructions-credential" && /^a name or a path detected in the inspected repository appears to contain a credential/.test(error.message) && !error.message.includes(token),
    text.replace(token, "<credential>"),
  );

for (const [label, token] of NAMED_CREDENTIALS) {
  test(`AC50: ${label} is refused inside a name as it is standing alone: after a file-name prefix, before a suffix, in a path`, () => {
    for (const text of [token, `backup_${token}`, `${token}_old`, `backup_${token}_old`, `packages/backup_${token}/package.json`, `public/${token}_old/source.json`, `.github/workflows/backup_${token}.yml`]) {
      refusedAsCredential(text, token);
    }
  });
}

test("AC50: a GitHub token is refused wherever it stands in a name, also when letters or digits are glued to it", () => {
  for (const token of [GITHUB_CLASSIC, GITHUB_SERVER, GITHUB_FINE_GRAINED]) {
    for (const text of [`backup${token}`, `backup2${token}`, `packages/Backup7${token}/package.json`, `x${token}`]) refusedAsCredential(text, token);
  }
});

// The boundary is only widened to `_`: a name that merely contains the start of a token inside a word is still no token, or a repository with a long, hyphenated file name could not be onboarded.
for (const text of [
  "docs/task-description-for-the-long-running-migration-job.md", // `sk-` inside a word starts no API key
  "docs/risk_test_assessmentreportsforthequarter.md", // nor does `sk_test_`
  "public/laughs_and_giggles_for_everyone/source.json", // `ghs_` is not followed by the 20 letters or digits of a token
]) {
  test(`AC50: a name that only resembles the start of a token is still ordinary text: ${JSON.stringify(text)}`, () => {
    assert.doesNotThrow(() => assertNoCredentials(text, "a name or a path detected in the inspected repository"));
  });
}

test("AC50: the scan of a large text is linear: a megabyte of keywords and of colons is checked in well under the time that a quadratic scan would need", () => {
  for (const text of ["token".repeat(200000), `http://${"a:".repeat(300000)}`, `${"api_key ".repeat(120000)}`]) {
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => assertNoCredentials(text, "--instructions"));
    assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 5, `${text.slice(0, 12)}... took too long`);
  }
});

test("AC50: the instructions that this repository commits are not refused", () => {
  const directory = path.join(REPO_ROOT, "instructions");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".md"));
  assert.ok(files.length >= 1);
  for (const name of files) assert.doesNotThrow(() => assertNoCredentials(fs.readFileSync(path.join(directory, name), "utf8"), name), name);
});

// --- where a file may come from --------------------------------------------------------------------------------------------

test("AC50: a file outside the repository is refused whatever it holds: the content of ~/.aws/credentials never reaches instructions/<projectKey>.md", () => {
  withTree(({ root, outside }) => {
    const credentials = put(path.join(outside, "credentials"), CREDENTIALS_FILE);
    const harmless = put(path.join(outside, "notes.md"), "Keep the docs current.\n");
    const refused = (error) => error.code === "instructions-path" && /names a file outside the working copy of the central orchestrator repository/.test(error.message) && !echoes(error.message);
    assert.throws(() => readOperatorInstructions(credentials, root), refused, "an absolute path, the root defaulting to the working directory");
    assert.throws(() => readOperatorInstructions(credentials, root, root), refused);
    assert.throws(() => readOperatorInstructions(path.relative(root, credentials), root), refused, "a relative path that leaves the repository");
    assert.throws(() => readOperatorInstructions(harmless, root), refused, "where the file is decides, not what it holds");
    const sub = path.join(root, "docs");
    fs.mkdirSync(sub);
    assert.throws(() => readOperatorInstructions(credentials, sub, root), refused, "a working directory below the root does not widen the root");
  });
});

test("AC50: a file inside the repository is copied byte for byte, whether the path is relative, absolute or reaches the file through a parent directory", () => {
  withTree(({ root }) => {
    const text = "# Notes\r\n\r\nKeep the docs current — 日本語.\r\nno trailing newline";
    put(path.join(root, "notes", "instructions.md"), text);
    for (const value of ["notes/instructions.md", path.join(root, "notes", "instructions.md"), "notes/../notes/instructions.md"]) {
      assert.deepEqual(readOperatorInstructions(value, root), { text, literal: "" }, value);
    }
    assert.deepEqual(readOperatorInstructions("instructions.md", path.join(root, "notes"), root), { text, literal: "" }, "relative to a working directory inside the repository");
  });
});

test("AC50: a file that holds a credential is refused even inside the repository, with the file named and nothing echoed", () => {
  withTree(({ root }) => {
    put(path.join(root, "notes", "aws.txt"), CREDENTIALS_FILE);
    assert.throws(
      () => readOperatorInstructions("notes/aws.txt", root),
      (error) => error.code === "instructions-credential" && /^the instructions file notes\/aws\.txt appears to contain a credential/.test(error.message) && !echoes(error.message),
    );
  });
});

for (const relative of [".env", ".env.production", "config/.npmrc", "deploy/server.pem", "keys/tls.key", "keys/store.p12", "id_rsa", "ssh/id_ed25519", "credentials", "credentials.json", "config/secrets.yaml", ".aws/config", ".ssh/notes.md", ".git/notes.md", ".azure/notes.md"]) {
  test(`AC50: ${relative} inside the repository is refused because of what the file is, even when it holds harmless text`, () => {
    withTree(({ root }) => {
      put(path.join(root, ...relative.split("/")), "Keep the docs current.\n");
      assert.throws(() => readOperatorInstructions(relative, root), (error) => error.code === "instructions-secret-file" && /Nothing was written/.test(error.message) && error.message.includes(relative));
    });
  });
}

test("AC50: a file that is not text is refused", () => {
  withTree(({ root }) => {
    fs.writeFileSync(path.join(root, "store.bin"), Buffer.from([0x30, 0x82, 0x00, 0x01, 0x00, 0x02]));
    assert.throws(() => readOperatorInstructions("store.bin", root), (error) => error.code === "instructions-binary");
  });
});

test("AC50: a directory link inside the repository that leads out of it does not make the file inside it a file of the repository", (t) => {
  withTree(({ root, outside }) => {
    put(path.join(outside, "notes.md"), "Keep the docs current.\n");
    try {
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      t.skip(`this machine does not allow links (${error.code})`);
      return;
    }
    assert.throws(() => readOperatorInstructions("linked/notes.md", root), (error) => error.code === "instructions-path");
  });
});

test("AC50: a value that names no file and a directory are literal text, as before", () => {
  withTree(({ root }) => {
    fs.mkdirSync(path.join(root, "notes"));
    assert.deepEqual(readOperatorInstructions("notes/missing.md", root), { text: "notes/missing.md", literal: "notes/missing.md" });
    assert.deepEqual(readOperatorInstructions("notes", root), { text: "notes", literal: "notes" });
    assert.equal(readOperatorInstructions(undefined, root), null);
  });
});

// --- through the command ---------------------------------------------------------------------------------------------------

const REPOS = fixtureRepos({ "example-owner/node-app": "node-app" });

/** Runs bin/sdlc-onboard.mjs in process and expects a refusal that leaves the working copy exactly as committed and prints no value of the files. */
async function expectRefused({ argv, prepare, message }) {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-instructions-cli-"));
  try {
    prepare({ scenario, outside });
    scenario.workspace.commitAll();
    const run = await scenario.onboard(argv({ scenario, outside }), { env: scenario.env(scenario.appCredentials()) });
    assert.notEqual(run.code, 0, run.stdout);
    assert.match(run.stderr, message);
    assertNoSecrets({ stderr: run.stderr, stdout: run.stdout, "sdlc.yaml": scenario.workspace.read("sdlc.yaml") }, VALUES, "the refusal");
    assert.equal(scenario.workspace.status(), "", "no file was written");
    assert.equal(scenario.reconcile.calls.length, 0);
    assert.deepEqual(scenario.fake.nonGet(), [], "no write of any kind");
  } finally {
    await scenario.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test("AC50: bin/sdlc-onboard.mjs --instructions <a credentials file outside the repository> is refused before anything is written, and no value of the file is printed", async () => {
  await expectRefused({
    prepare: ({ outside }) => put(path.join(outside, "credentials"), CREDENTIALS_FILE),
    argv: ({ outside }) => ["--repo", "example-owner/node-app", "--instructions", path.join(outside, "credentials")],
    message: /--instructions .*credentials names a file outside the working copy of the central orchestrator repository/,
  });
});

test("AC50: bin/sdlc-onboard.mjs --instructions .env is refused before anything is written", async () => {
  await expectRefused({
    prepare: ({ scenario }) => scenario.workspace.write(".env", "DEBUG=true\n"),
    argv: () => ["--repo", "example-owner/node-app", "--instructions", ".env"],
    message: /--instructions \.env names a file that is not copied because its name \(\.env\) is that of a file that holds secrets/,
  });
});

test("AC50: bin/sdlc-onboard.mjs --instructions <a file of the repository with an AWS key and an Anthropic key> is refused, and none of the values is printed", async () => {
  await expectRefused({
    prepare: ({ scenario }) => scenario.workspace.write("notes/provider.txt", CREDENTIALS_FILE),
    argv: () => ["--repo", "example-owner/node-app", "--instructions", "notes/provider.txt"],
    message: /the instructions file notes\/provider\.txt appears to contain a credential/,
  });
});

test("AC50: bin/sdlc-onboard.mjs --instructions <literal text with a provider key> is refused, and the key is not printed", async () => {
  await expectRefused({
    prepare: () => {},
    argv: () => ["--repo", "example-owner/node-app", `--instructions=Use ${OPENAI} for the checks`],
    message: /--instructions appears to contain a credential/,
  });
});

test("AC50: a file of the repository without a credential is still copied into instructions/<projectKey>.md", async () => {
  const scenario = await createScenario({ fake: { repos: REPOS } });
  try {
    scenario.workspace.write("notes/for-the-agent.md", "Keep the docs current.\n");
    const run = await scenario.onboard(["--repo", "example-owner/node-app", "--instructions", "notes/for-the-agent.md"], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(scenario.workspace.read("instructions/node-app.md").startsWith("Keep the docs current.\n\n<!-- sdlc-onboard:generated -->"));
  } finally {
    await scenario.cleanup();
  }
});
