# AI SDLC Orchestrator: architecture briefing deck

`dist/index.html` is the briefing: one self-contained HTML file (about 230 KB, with the production walkthrough drawn inline), no server, no dependencies. It is generated from the Markdown under `content/` by `build.mjs`, which also writes the read-aloud script to `../presenter/PRESENTER-SCRIPT.md`. Edit the sources, rebuild, commit both outputs.

12 slides, 30 minutes. The deck follows the specs in `../specs/` and the plan in `../plan.md`; every spec path on a slide is a real file in this repository.

```bash
node presentation/build.mjs                    # build dist/index.html and presenter/PRESENTER-SCRIPT.md
node presentation/build.mjs --check            # validate only, write nothing
node presentation/build.mjs --check --strict   # validate only; warnings fail the run too
```

Exit codes: `0` clean, `1` problems (or warnings under `--strict`), `2` unknown flag. A rebuild with unchanged content changes no bytes: the `built` stamp in the HTML and the date in the script are kept.

## Presenting

Open `dist/index.html`. The deck remembers the theme, the agenda time zone and the notes font size per browser.

| Key | Does |
|---|---|
| `→` `↓` `Space` `PgDn` / `←` `↑` `PgUp` | next / previous slide |
| `Home` / `End` | first / last slide |
| `1`–`9` then `Enter` | jump to a slide number (up to three digits) |
| `S` | speaker window: current and next slide, the script, a timer against the planned minutes. Open it before `F`, because a new window leaves fullscreen |
| `F` | present fullscreen · `B` or `.` blank the screen · `T` light/dark · `P` print to PDF |
| `A` · `G` · `?` | agenda · overview grid · shortcut help (each closes with its own key) |

`#/7`, `#/s3-event-router` and `#/speaker` are deep links. The decision tree on slide 8 and the knowledge check on slide 11 are clickable. `Space` and `Enter` press whichever button, link or tab has focus instead of changing slide (in the deck and in the speaker window); with the slides themselves focused, `Space` advances. The *Skip to slides* link moves focus to the slides without changing the slide or the address (in `#/speaker` it reads *Skip to speaker notes* and lands on the notes).

### Phones and tablets

Under 900px wide, under 520px tall, or in a portrait window up to 1199px wide, the deck stops scaling the 1920×1080 stage and lays each slide out as a page: one column (two or three where there is room), the slide scrolls on its own, and the toolbar becomes 44px icon buttons. The stylesheet records its choice in `--layout` (`canvas` or `flow`) and `app.js` reads it, so the breakpoint is written once, in the `@media` block of `src/styles.css`. Above it, the stage and the speaker window are exactly as before.

| Gesture | Does |
|---|---|
| swipe left / right | next / previous slide. A vertical drag scrolls the slide, a sideways drag inside a wide diagram pans it, and the quiz, decision tree, pilot stepper, links and buttons keep their own taps |
| tap the arrows | previous / next slide; in fullscreen, the right and left halves of the screen do the same |
| **Notes** button or `S` | this slide's speaker notes in a bottom sheet, so no pop-up is needed (a blocked speaker window falls back to it too); `←` `→` still change slide while it is open |
| `↑` `↓` `Space` | read down a tall slide first, then change slide at its end |

Diagrams are drawn for a wide stage, so on a narrow screen they keep a readable size and pan sideways; while one overflows it takes focus and the arrow keys. `#/speaker` is one column at these sizes: the slide preview, the notes, and a Prev / Next row pinned below. At 400% browser zoom a laptop window is about 320×180 CSS pixels, so with a mouse (not a touch screen) the bottom bar folds into a single 28px row and the slide keeps the room. On a window that short, nothing stays pinned: the speaker page, and the notes sheet (under about 280px tall), scroll as one page, with Prev / Next directly under the speaker header and the sheet's Close button held at its top. Overlays keep their body in its own scrolling region above the Close button, so a focused control is never behind it. The speaker window's previews are inert pictures: no tab stops, hidden from assistive technology (the *Next* label carries the next slide's title).

## Authoring

### Slides: `content/slides/NN-name.md`

Front matter sets the section name and the day. Slides are separated by a line containing only `---`. A slide starts with `@key: value` lines, then Markdown; the first `# heading` is the title.

```markdown
@id: s3-event-router      # required, unique; used in URLs, the agenda and the script
@layout: timeline         # default | title | section | lab | break | quiz | end | cards | diagram | timeline | decision | media | split
@minutes: 3               # planned minutes; the speaker timer and the pace lint use them
@kicker: Custom label     # optional; defaults to the section name
@exempt: reason           # optional; emits data-density-exempt (worksheets only)
```

Containers open with `:::name` and close with `:::`. `:::diagram`, `:::spec` and `:::glyph` are one-liners with no closing line.

| Container | Use |
|---|---|
| `:::cols 1fr 1fr` + `:::col Title` | columns; the argument is the grid template; the title renders as an `h2` under the slide's `h1` |
| `:::cards 3` + `:::card [icon=key] Title` | cards; the bracket takes an `icon=` and an optional tone (`good`, `warn`, `bad`, `purple`, `muted`). This deck uses no tones: one accent colour. The title renders as an `h2` |
| `:::callout kind Title` | `note`, `tip` or `warn` |
| `:::stats` / `:::kv` / `:::ledger` | rows `value \| label \| note`, `key \| value`, `key \| value` |
| `:::timeline` | rows `label \| text \| state`; state `poll` renders the dashed scheduled step |
| `:::chips`, `:::aside`, `:::big`, `:::center` | chips from list items, small print, emphasis, centering |
| `:::quiz` | `Q:`, `- A) …` options and `Answer: B — why`; interactive |
| `:::labtile` | one row `S1 \| SPEC-01 · Reconciler \| specs/01-manifest-and-reconciler.md`; the path becomes a `lab-path` the portfolio importer rewrites |
| `:::spec path` | a repository link such as `specs/02-upstream-drift-automation.md` or `plan.md`; the runtime resolves it to GitHub |
| `:::diagram name` | embeds `content/diagrams/name.html` (or `.svg`) |

### Diagrams: `content/diagrams/`

Inline SVG or HTML fragments styled with the `d-*` classes in `src/styles.css`, so they follow the theme. Every SVG `<text>` is at least 22px (the build checks it) so labels stay near 18px on screen. Elements with `data-hl="group"` highlight together on hover or focus: give the group's main box the `d-panel` class and it takes a heavier outline while the other groups stay at full strength (text is never faded below 5:1). A heading inside a diagram follows the slide's `h1` as an `h2`, as `cascade-decision.html` does, so the outline never skips a level. `cascade-decision.html` holds the `[data-decision]` tree as an embedded JSON object.

`live-pipeline-demo.html` is the six-step production walkthrough of slide 9, drawn as inline SVG: the `data-pilot` stepper in `src/app.js` shows one `data-pilot-panel` at a time and keeps it in step with the ledger rows. It does not embed `docs/media/gh-admin-sdlc-pipeline-demo.svg`. A fragment that does want a repository file inlined can use `{{data-uri:path|transform}}`; the `legible-captions` transform then enlarges that SVG's 16–17px captions to 22px on a build-time copy, and the file in `docs/media/` is never modified.

### Script: `content/script/NN-name.md`

One section per slide, keyed by id.

```markdown
## [s3-event-router] S3 · Hybrid Push + ETag Event Router

Plain paragraphs are what you say. Say the point first.

SHOW: the element you point at.
DO: an action for you, never read aloud.
ASK: a question to the room.
PAUSE: how long to wait.
CLICK: press the on-screen control.
CHECK: re-verify before this delivery.

> The bridge: one sentence into the next slide.

SOURCE: specs/03-event-routing-and-mechanical-cascade.md
```

The generated `PRESENTER-SCRIPT.md` gives each slide a `#### [SLIDE n] · Sn · title` heading, and puts the timing and source lines in blockquotes so density tools score only the spoken words.

### Agenda: `content/agenda.json`

One day, four blocks totalling 30 minutes. The start times are a placeholder (10:00 America/New_York); set the real time before sharing. The `@minutes` of each block's slides must add up to the block, and the build reports the totals.

## Checks

The builder lints as it builds: at most 58 visible words per slide (hard ceiling 90), 7 to 16 body words in any container that has a heading, existing spec links, agenda sums, script pace (150 words a minute) and verbatim overlap between script and slide, and diagram label size. `--strict` turns warnings into failures.

Run both visual gates after any layout change, from the repository root:

```powershell
$env:PYTHONIOENCODING = 'utf-8'
python "$env:USERPROFILE\.copilot\skills\deck-standards\scripts\deck-density.py" presentation/dist/index.html --script presenter/PRESENTER-SCRIPT.md
python "$env:USERPROFILE\.copilot\skills\slide-review\scripts\review.py" --headless presentation/dist/index.html
```

`slide-review` writes screenshots and `report.json` to `presentation/dist/review/`. These are review artifacts, not deliverables: view them, then delete the folder.

After a change to `src/styles.css`, `src/app.js` or `src/shell.html`, also open the deck at 320×568, 390×844, 844×390 and 768×1024 (and at 1440×900, which must look exactly as before): no horizontal scrollbar, no clipped or overlapping text, every control at least 44px on the compact layout.

## Portfolio import

The deck is built to be imported unchanged by the portfolio importer. Do not rename these:

- `<div class="topbar-left">` and `<div class="sp-title">` in `src/shell.html`, where the importer injects its Back button.
- `<script type="application/json" id="deck-data">{{DATA}}</script>`, whose JSON strings the importer rewrites.
- the `lab-path` and root-relative `specs/…` and `plan.md` links.

State and channel names use the `ai-sdlc-deck` prefix.
