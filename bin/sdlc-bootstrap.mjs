#!/usr/bin/env node
// One-command bootstrap of the AI SDLC orchestrator (contract C10, form a):
//
//   node bin/sdlc-bootstrap.mjs [--manifest sdlc.yaml] [--owner <user-or-org>] [--app-name <up to 34 characters>]
//     [--engine copilot|claude|codex|gemini|pi] [--deconflict-upstream-schedules] [--non-interactive]
//
// Secrets are never accepted as flags: the App private key and the engine credential come from the
// environment (APP_CLIENT_ID, APP_PRIVATE_KEY, COPILOT_GITHUB_TOKEN or the engine's API-key variable) or from a
// prompt that does not echo. Progress goes to stderr; stdout carries one BootstrapSummaryReport JSON document.

import { runBootstrap } from "./lib/bootstrap-run.mjs";

const interrupt = new AbortController();
const onSignal = () => interrupt.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

process.exitCode = await runBootstrap(process.argv.slice(2), { signal: interrupt.signal });

process.off("SIGINT", onSignal);
process.off("SIGTERM", onSignal);
