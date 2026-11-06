#!/usr/bin/env node
// Points the AI SDLC orchestrator at one more repository (contract C10, form b):
//
//   node bin/sdlc-onboard.mjs --repo <owner/repo-or-path> [--downstream <owner/repo>]
//     [--strategy auto|content-and-docs-sync|dependency-and-pattern-modernization|code-quality-and-improvement-scan|custom]
//     [--watch-url <url>]... [--schedule <cron>] [--mode auto|mechanical|ai-adaptation]
//     [--instructions <text-or-path>] [--manifest sdlc.yaml]
//
// The repository may also be given as one positional <owner/repo>. The App credentials (APP_CLIENT_ID and
// APP_PRIVATE_KEY) come from the environment; they resolve the App slug that contract C1 needs. Progress goes to
// stderr; stdout carries one BootstrapSummaryReport JSON document.

import { runOnboard } from "./lib/onboard-run.mjs";

const interrupt = new AbortController();
const onSignal = () => interrupt.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

process.exitCode = await runOnboard(process.argv.slice(2), { signal: interrupt.signal });

process.off("SIGINT", onSignal);
process.off("SIGTERM", onSignal);
