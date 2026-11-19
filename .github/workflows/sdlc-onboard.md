---
on:
  workflow_dispatch:
    inputs:
      repo:
        description: Repository to onboard (owner/name)
        type: string
      downstream:
        description: Optional downstream repository (owner/name) that receives cascades from it
        type: string
      strategy:
        description: "Upkeep strategy: auto or one of the four strategies"
        type: string
      watch_url:
        description: Optional URL to watch (changelog, blog or documentation)
        type: string
      schedule:
        description: Optional five-field cron for the upkeep schedule
        type: string
      mode:
        description: "Edge mode: auto, mechanical or ai-adaptation"
        type: string
      instructions:
        description: Registration instructions text or the path of an instructions file
        type: string
      manifest:
        description: Manifest path (defaults to sdlc.yaml)
        type: string
  bots:
    - mfg-msft-ai-sdlc[bot]
concurrency:
  group: sdlc-onboard
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
engine:
  id: copilot
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
network:
  allowed: []
checkout:
  - repository: ${{ github.repository }}
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
pre-agent-steps:
  - name: Record the onboarding inputs
    env:
      INPUT_REPO: ${{ inputs.repo }}
      INPUT_DOWNSTREAM: ${{ inputs.downstream }}
      INPUT_STRATEGY: ${{ inputs.strategy }}
      INPUT_WATCH_URL: ${{ inputs.watch_url }}
      INPUT_SCHEDULE: ${{ inputs.schedule }}
      INPUT_MODE: ${{ inputs.mode }}
      INPUT_INSTRUCTIONS: ${{ inputs.instructions }}
      INPUT_MANIFEST: ${{ inputs.manifest }}
    run: |-
      mkdir -p /tmp/gh-aw/agent
      node --input-type=module -e 'import { writeFileSync } from "node:fs"; const e = process.env; writeFileSync("/tmp/gh-aw/agent/onboard-inputs.json", JSON.stringify({ repo: e.INPUT_REPO, downstream: e.INPUT_DOWNSTREAM, strategy: e.INPUT_STRATEGY, watch_url: e.INPUT_WATCH_URL, schedule: e.INPUT_SCHEDULE, mode: e.INPUT_MODE, instructions: e.INPUT_INSTRUCTIONS, manifest: e.INPUT_MANIFEST }, null, 2) + "\n");'
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
  threat-detection:
    continue-on-error: false
  create-pull-request:
    title-prefix: "chore(onboard): "
    labels:
      - automated
      - sdlc-onboard
      - needs-review
    draft: false
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: true
    close-older-pull-requests: true
    close-older-key: sdlc-onboard
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude: []
    auto-merge: false
    fallback-as-issue: true
    max: 1
tools:
  bash:
    - cat
    - date
    - find
    - git
    - grep
    - head
    - ls
    - node
    - tail
    - wc
  edit: {}
jobs:
  detection:
    if: needs.agent.result == 'success'
  safe_outputs:
    if: needs.agent.result == 'success'
---

# Onboard a repository into the fleet

Add one repository to the fleet manifest. The dispatch inputs are recorded in `/tmp/gh-aw/agent/onboard-inputs.json`.

1. Run `node node_modules/ai-sdlc-factory/bin/sdlc-onboard.mjs --repo <repo>` with the `repo` input, adding `--downstream`, `--strategy`, `--watch-url`, `--schedule`, `--mode`, `--instructions` and `--manifest` for every input that is not empty. The command also accepts the repository as a positional `<owner/repo>`.
2. The command inspects the repository and writes its project and edge entries to the manifest and its instructions to `instructions/<projectKey>.md`. Check that what it wrote matches the inspected repository.
3. Commit the manifest and instruction files to the working branch and call `create_pull_request`.

Do not edit generated workflow files. Never merge. The pull request is created only through the safe output.
