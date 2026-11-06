// AC13: the manifest that /register posts, the default App name and the permission map in one data file.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { APP_NAME_MAX, buildManifest, defaultAppName, loadPermissionMap, registrationUrl } from "../../bin/lib/app-manifest.mjs";
import { REPO_ROOT } from "./helpers/harness.mjs";

const PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", actions: "write", variables: "write", metadata: "read" };

test("AC13: the manifest for port 41234 has every required key and value", () => {
  const manifest = buildManifest({
    name: "Example orchestrator",
    homepage: "https://github.com/example-owner/example-repo",
    redirectUrl: "http://127.0.0.1:41234/callback",
  });
  assert.equal(manifest.name, "Example orchestrator");
  assert.ok([...manifest.name].length <= 34);
  assert.equal(manifest.url, "https://github.com/example-owner/example-repo");
  assert.deepEqual(manifest.hook_attributes, { url: "https://github.com/example-owner/example-repo", active: false });
  assert.equal(manifest.redirect_url, "http://127.0.0.1:41234/callback");
  assert.equal(manifest.public, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal(typeof manifest.description, "string");
  assert.deepEqual(manifest.default_events, []);
  assert.deepEqual(manifest.default_permissions, PERMISSIONS);
  assert.deepEqual(Object.keys(manifest).sort(), ["default_events", "default_permissions", "description", "hook_attributes", "name", "public", "redirect_url", "request_oauth_on_install", "url"]);
});

test("AC13: the permission map lives in bin/lib/app-permissions.json and the manifest reads it", () => {
  const onDisk = JSON.parse(fs.readFileSync(`${REPO_ROOT}bin/lib/app-permissions.json`, "utf8"));
  assert.deepEqual(onDisk, PERMISSIONS);
  assert.deepEqual(loadPermissionMap(), onDisk);
  assert.deepEqual(buildManifest({ name: "x", homepage: "https://github.com/a/b", redirectUrl: "http://127.0.0.1:1/callback" }).default_permissions, onDisk);
  for (const level of Object.values(onDisk)) assert.ok(level === "read" || level === "write");
});

test("AC13: each call returns a fresh permission map, so a caller cannot change what the next one sees", () => {
  const first = loadPermissionMap();
  first.contents = "admin";
  assert.equal(loadPermissionMap().contents, "write");
});

test("AC13: defaultAppName cuts the repository name to 34 characters and is deterministic", () => {
  const slug = "example-owner/a-very-long-repository-name-for-sdlc-orchestration";
  const name = defaultAppName(slug);
  assert.ok([...name].length <= APP_NAME_MAX);
  assert.equal(name, defaultAppName(slug));
  assert.equal(name, "a-very-long-repository-name-for-sd");
  assert.equal(defaultAppName("o/short-name"), "short-name");
  assert.equal(defaultAppName("o/Example_Repo.Name"), "Example-Repo-Name");
  assert.equal(defaultAppName("o/---"), "sdlc-orchestrator");
  assert.equal(defaultAppName("o/" + "a".repeat(33) + "-bbbbbb"), "a".repeat(33), "a trailing hyphen left by the cut is removed");
});

test("AC13: a name longer than 34 characters is refused", () => {
  assert.throws(() => buildManifest({ name: "x".repeat(35), homepage: "https://github.com/a/b", redirectUrl: "http://127.0.0.1:1/callback" }), /longer than 34 characters/);
});

test("AC12: the registration URL is the personal one for a user and the organization one for an organization", () => {
  assert.equal(registrationUrl("User", "someone"), "https://github.com/settings/apps/new");
  assert.equal(registrationUrl("Organization", "example-org"), "https://github.com/organizations/example-org/settings/apps/new");
  assert.equal(registrationUrl("Organization", "weird name/../x"), "https://github.com/organizations/weird%20name%2F..%2Fx/settings/apps/new");
});

test("AC13: the manifest is JSON-encodable and survives a round trip, which is what the hidden form input carries", () => {
  const manifest = buildManifest({ name: "x", homepage: "https://github.com/a/b", redirectUrl: "http://127.0.0.1:1/callback", description: 'quote " and <tag> & ampersand' });
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});
