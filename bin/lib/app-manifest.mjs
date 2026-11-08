// The GitHub App manifest that the loopback /register page posts to GitHub (AC12, AC13), and the pure
// helpers around it. The least-privilege permission map lives in one data file, app-permissions.json,
// which the manifest builder, the installation check and the C1 request all read.

import fs from "node:fs";
import { SdlcError } from "./errors.mjs";

export const APP_NAME_MAX = 34;

const PERMISSIONS_FILE = new URL("./app-permissions.json", import.meta.url);

/** A fresh copy of the least-privilege map { permission name: "read" | "write" } from app-permissions.json. */
export function loadPermissionMap() {
  return JSON.parse(fs.readFileSync(PERMISSIONS_FILE, "utf8"));
}

/** Deterministic App name derived from the central repository name, at most 34 characters (AC13). */
export function defaultAppName(centralSlug) {
  const repo = String(centralSlug).slice(String(centralSlug).indexOf("/") + 1);
  const cleaned = repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned === "" ? "sdlc-orchestrator" : cleaned).slice(0, APP_NAME_MAX).replace(/-+$/g, "");
}

/** https://github.com/settings/apps/new for a user, https://github.com/organizations/<org>/settings/apps/new for an organization. */
export function registrationUrl(ownerType, owner) {
  return ownerType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

/**
 * @param {{ name: string, homepage: string, redirectUrl: string, description?: string }} input
 * @returns the manifest object that is JSON-encoded into the form's hidden `manifest` input
 */
export function buildManifest({ name, homepage, redirectUrl, description }) {
  if ([...name].length > APP_NAME_MAX) throw new SdlcError(`the App name '${name}' is longer than ${APP_NAME_MAX} characters`, { code: "app-name" });
  return {
    name,
    url: homepage,
    hook_attributes: { url: homepage, active: false },
    redirect_url: redirectUrl,
    public: false,
    request_oauth_on_install: false,
    description: description ?? "AI SDLC orchestrator: mints installation tokens for drift audits, cascades and onboarding.",
    default_events: [],
    default_permissions: loadPermissionMap(),
  };
}
