import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deck } from '../src/content';
import { analyzeDeckHtml, analyzeSectionHtml, anchorCount, checkArtifacts, checkDeck, parseScriptMarkdown, screenTokens, spokenText, svgLabelWordCount, visibleWordCount, words } from '../src/content/rules';
import { presenterLabel, type Slide } from '../src/content/types';
import { renderBeatsMarkdown, groupBeats } from '../src/shell/script';
import { renderSlideSection, renderStage } from '../src/shell/render';
import { renderDocument } from '../src/shell/page';
import { renderPresenterScript } from '../src/build/markdown';

const lower = (t: string[]) => t.map((x) => x.toLowerCase());
const withoutSvgLabels = (s: Slide): Slide => ({ ...s, diagram: undefined });

describe('the committed deck', () => {
  it('passes every rule with zero findings', () => {
    const r = checkDeck(deck);
    expect(r.findings).toEqual([]);
    expect(deck.slides).toHaveLength(25);
    expect(deck.modules).toHaveLength(7);
  });

  it('keeps the planned ids, modules, one presenter and 25 distinct layout archetypes in deck order', () => {
    expect(deck.slides.map((s) => s.id)).toEqual([
      'm1-cover', 'm1-vibe-cliff', 'm1-attention-economy', 'm2-hero-trap', 'm2-supply-chain', 'm2-three-roles', 'm2-governance-matrix',
      'm3-productivity-paradox', 'm3-metric-evolution', 'm3-gate-matrix', 'm4-process-economics', 'm4-executive-roi', 'm4-honest-tco',
      'm4-cost-spread', 'm4-prompt-debugger', 'm5-time-shift', 'm5-whack-a-mole', 'm5-junior-senior-shift', 'm6-security-gap',
      'm6-two-computers', 'm7-anti-patterns', 'm7-roadmap', 'm7-maturity-dimensions', 'm7-quiz', 'm7-open-floor',
    ]);
    expect(new Set(deck.slides.map((s) => s.layout)).size).toBe(25);
    for (let i = 1; i < deck.slides.length; i++) expect((deck.slides[i] as Slide).layout).not.toBe((deck.slides[i - 1] as Slide).layout);
    // a single presenter: every slide is presented by `John`, who the deck defines (name and organization)
    expect(deck.slides.every((s) => s.presenter === 'John')).toBe(true);
    expect(Object.keys(deck.meta.presenters)).toEqual(['John']);
    expect(deck.meta.presenters.John.org).toBe('Microsoft');
    expect(presenterLabel('John')).toBe(deck.meta.presenters.John.name);
    expect(deck.meta).not.toHaveProperty('customer');
  });

  it('wires every widget kind: one scorecard, five staged steppers, one gate tree, one simulator, one quiz', () => {
    const kinds = deck.slides.flatMap((s) => (s.widget ? [s.widget.kind] : []));
    expect(new Set(kinds)).toEqual(new Set(['staged', 'decision-tree', 'prompt-debugger', 'quiz']));
    const staged = deck.slides.filter((s) => s.widget?.kind === 'staged');
    const modeOf = (s: Slide) => (s.widget as { mode: string }).mode;
    expect(staged.filter((s) => modeOf(s) === 'place').map((s) => s.id)).toEqual(['m2-governance-matrix']);
    expect(staged.filter((s) => modeOf(s) === 'steps').map((s) => s.id)).toEqual([
      'm1-attention-economy', 'm2-hero-trap', 'm2-three-roles', 'm3-metric-evolution', 'm5-whack-a-mole',
    ]);
    for (const kind of ['decision-tree', 'prompt-debugger', 'quiz']) expect(kinds.filter((k) => k === kind), kind).toHaveLength(1);
  });

  it('has a unique, well-formed glossary', () => {
    const ids = deck.glossary.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(deck.glossary.length).toBeGreaterThan(40);
    for (const g of deck.glossary) {
      expect(g.id, g.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(g.definition.length, g.id).toBeGreaterThan(20);
      for (const sid of g.slides ?? []) expect(deck.slides.some((s) => s.id === sid), `${g.id} -> ${sid}`).toBe(true);
    }
    for (const term of ['PROSE', 'Progressive Disclosure', 'Reduced Scope', 'Orchestrated Composition', 'Safety Boundaries', 'Explicit Hierarchy']) {
      expect(deck.glossary.some((g) => g.term.startsWith(term)), term).toBe(true);
    }
    for (const term of ['SPACE framework', 'Six dimensions of maturity', 'Executive ROI balanced scorecard']) {
      expect(deck.glossary.some((g) => g.term.startsWith(term)), term).toBe(true);
    }
  });

  it('includes executive ROI scorecard (m4-executive-roi) and six dimensions of maturity (m7-maturity-dimensions)', () => {
    const roi = deck.slides.find((s) => s.id === 'm4-executive-roi');
    const mat = deck.slides.find((s) => s.id === 'm7-maturity-dimensions');
    expect(roi?.layout).toBe('roi-scorecard');
    expect(roi?.diagram?.id).toBe('roi-trace');
    expect(roi?.sources.map((s) => s.url)).toEqual(
      expect.arrayContaining([
        'https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-measure-impact',
        'https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/',
        'https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report',
      ]),
    );
    expect(mat?.layout).toBe('maturity-dimensions');
    expect(mat?.diagram?.id).toBe('maturity-radar');
    expect(mat?.note).toBe('Illustrative enterprise profile');
    expect(mat?.sources.map((s) => s.url)).toContain(
      'https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-how-to-use',
    );
    const matHtml = renderSlideSection(mat!, 23);
    expect(matHtml).toContain('Delivery practices');
    expect(matHtml).toContain('Agent-ready codebase');
    expect(matHtml).toContain('Agent utilization');
    expect(matHtml).toContain('Operations');
    expect(matHtml).toContain('Team autonomy &amp; enablement');
    expect(matHtml).toContain('Responsible AI');
  });
});

describe('slide renderer: static twin', () => {
  deck.slides.forEach((slide, i) => {
    it(`slide ${i + 1} (${slide.id}) renders exactly the words, anchors and containers the model declares`, () => {
      const html = renderSlideSection(slide, i + 1);
      const a = analyzeSectionHtml(html);
      expect(a.id).toBe(`s${i + 1}`);
      expect(a.words).toBe(visibleWordCount(slide) - svgLabelWordCount(slide));
      expect(a.anchors).toBe(anchorCount(slide));
      expect([...a.tokens].sort()).toEqual([...screenTokens(withoutSvgLabels(slide))].sort());
      expect(a.containers).toHaveLength(slide.blocks.filter((b) => ['card', 'step', 'panel', 'box', 'tile', 'band'].includes(b.kind)).length);
      expect(a.hollow, 'no hollow containers at the real tool\u2019s threshold').toBe(0);
    });
  });

  it('is a <section class="slide" id="sN" data-id> with the layout, module and an accessible name', () => {
    const html = renderSlideSection(deck.slides[3] as Slide, 4);
    expect(html).toMatch(/^<section class="slide" id="s4" data-id="m2-hero-trap" data-n="4" data-module="M2" data-layout="stage-ladder"/);
    expect(html).toContain('aria-label="Slide 4: From hero builders to an enabling CoE"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(' inert');
    expect(renderSlideSection(deck.slides[0] as Slide, 1)).toMatch(/^<section class="slide active"/);
  });

  it('never lets brand chrome into a slide, and uses container class tokens only for real containers', () => {
    const stage = renderStage(deck);
    for (const chrome of ['Agentic SDLC Advisory', 'Skip to slides', 'Read-Along', 'data-nav']) expect(stage).not.toContain(chrome);
    const classes = [...stage.matchAll(/class="([^"]*)"/g)].map((m) => (m[1] as string).split(/\s+/));
    const containerTokens = new Set(['card', 'step', 'band', 'nopub', 'tile', 'panel', 'box']);
    const html = stage;
    for (const m of html.matchAll(/<(\w+)[^>]*class="([^"]*)"[^>]*>/g)) {
      const tokens = (m[2] as string).split(/\s+/);
      if (tokens.some((t) => containerTokens.has(t))) expect(m[1], `<${m[1]} class="${m[2]}">`).toBe('div');
    }
    expect(classes.length).toBeGreaterThan(100);
  });

  it('escapes every piece of text: no markup or attribute injection from content', () => {
    const evil: Slide = {
      id: 'evil', moduleCode: 'M1', presenter: 'John', layout: 'cover-hero-grid', purpose: 'x',
      title: '<img src=x onerror=alert(1)> & "quotes"', kicker: '</h1><script>alert(1)</script>',
      blocks: [{ kind: 'card', head: 'x" onclick="boom', body: "a & b < c > d 'e'", key: 'k" onfocus="x' }, { kind: 'chip', text: '<b>chip</b>' }],
      script: [], sources: [],
    };
    const html = renderSlideSection(evil, 1);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<script>alert/);
    // attribute NAMES, parsed the way a browser tokenizes a start tag (quoted values are opaque)
    const attrNames = [...html.matchAll(/<\w+((?:"[^"]*"|'[^']*'|[^'">])*)>/g)].flatMap((tag) =>
      [...(tag[1] as string).matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)].map((m) => m[1] as string),
    );
    expect(attrNames.length).toBeGreaterThan(10);
    expect(attrNames.filter((n) => /^on/i.test(n))).toEqual([]);
    const a = analyzeSectionHtml(html);
    expect(a.tokens, 'the hostile text is shown as text').toEqual(expect.arrayContaining(['onclick', 'boom', 'onerror']));
    expect(a.words).toBeGreaterThan(5);
  });

  it('renders container art after the body and icon-only links with accessible names, all word-free', () => {
    const s: Slide = {
      id: 'art-links', moduleCode: 'M1', presenter: 'John', layout: 'discussion-rail', purpose: 'x', title: 'Art and links',
      blocks: [
        { kind: 'card', head: 'Head', body: 'Seven body words sit under this heading here.', art: { viewBox: '0 0 10 10', svg: '<circle cx="5" cy="5" r="4"/>' } },
        {
          kind: 'band', head: 'Read', body: 'Seven body words sit under this heading here.',
          links: [{ icon: 'book', href: 'https://example.com/a?x=1&y="2"', label: 'The "book" & more' }],
        },
      ],
      script: [], sources: [],
    };
    const html = renderSlideSection(s, 1);
    expect(html).toMatch(/<p>Seven body words sit under this heading here\.<\/p><svg class="art" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><circle/);
    expect(html).toContain('class="card has-art"');
    expect(html).toContain('class="band has-links"');
    expect(html).toContain('<div class="links" role="group" aria-label="Further reading">');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('aria-label="The &quot;book&quot; &amp; more"');
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=&quot;2&quot;"');
    // art and links add no visible words: only the title and the two containers count
    expect(analyzeSectionHtml(html).words).toBe(visibleWordCount(s));
  });
});

describe('document template', () => {
  const css = '.x{color:red}';
  const js = 'var a = "</script><!-- x"; document.title = a;';
  const html = renderDocument({ deck, css, js, buildId: 'abc123' });

  it('is one self-contained file: pre-rendered #stage, chrome outside every slide, nav buttons present', () => {
    expect(html).toMatch(/<main id="deck"[\s\S]*<div id="stage-area">[\s\S]*<div id="stage">/);
    expect(html).toContain('data-nav="prev"');
    expect(html).toContain('data-nav="next"');
    expect(html).toContain('<meta name="generator" content="ai-sdlc-immersion-deck abc123">');
    const slides = analyzeDeckHtml(html);
    expect(slides).toHaveLength(25);
    for (const s of slides) {
      for (const brand of ['microsoft', 'skip', 'glossary', 'counter']) {
        if (s.id === 's1' && brand === 'microsoft') continue; // the cover kicker says "Microsoft" on purpose
        expect(s.tokens, `${s.id} has chrome word ${brand}`).not.toContain(brand);
      }
    }
  });

  it('the analyzer reads the full document (200 KB of inline script) exactly as it reads the sections', () => {
    const doc = analyzeDeckHtml(html);
    deck.slides.forEach((slide, i) => {
      const alone = analyzeSectionHtml(renderSlideSection(slide, i + 1, { active: i === 0 }));
      expect(doc[i]?.words, slide.id).toBe(alone.words);
      expect(doc[i]?.anchors, slide.id).toBe(alone.anchors);
    });
  });

  it('cannot be broken out of by script or style text', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain('<\\/script>');
    expect(html).not.toContain('"</script><!--');
    expect(renderDocument({ deck, css: 'a{}</style><p>', js: '' }).match(/<\/style>/g)).toHaveLength(1);
  });

  it('starts light, restores a saved dark theme before first paint', () => {
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toMatch(/localStorage\.getItem\('ai-sdlc-immersion:theme'\)==='dark'/);
  });
});

describe('presenter script (markdown twin)', () => {
  const md = renderPresenterScript(deck);

  it('has one "### [SLIDE N] \u00b7 <id> \u00b7 <Title>" heading per slide, in order, grouped by module', () => {
    const headings = md.match(/^### \[SLIDE \d+\] \u00b7 .+$/gm) ?? [];
    expect(headings).toHaveLength(25);
    deck.slides.forEach((s, i) => expect(headings[i]).toBe(`### [SLIDE ${i + 1}] \u00b7 ${s.id} \u00b7 ${s.title}`));
    expect(md.match(/^## Module M\d: /gm)).toHaveLength(7);
  });

  it('what the real parser keeps is exactly the spoken beats: the round trip is lossless', () => {
    const parsed = parseScriptMarkdown(md);
    deck.slides.forEach((s, i) => {
      const expected = spokenText(s).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
      expect(parsed.get(i + 1), s.id).toBe(expected);
    });
  });

  it('keeps every cue, badge, summary and source in a blockquote so none of it is measured as speech', () => {
    const slide15 = md.slice(md.indexOf('### [SLIDE 15]'), md.indexOf('### [SLIDE 16]'));
    expect(slide15).toContain('> **[CUE]** ASK: Which toggle would save you the most today?');
    expect(slide15).toContain('> **[IF NEEDED]** Assumptions behind the model');
    expect(slide15).toContain('> **[CUE]** NEXT: ');
    expect(slide15).toContain(`> **Presenter:** ${presenterLabel('John')}`);
    expect(slide15).toContain('> **The room sees:**');
    expect(slide15).toContain('> **Sources:** [Handbook Ch 7');
    // a code payload stays inside the quote: every line from the CUE to the closing fence starts with ">"
    const lines = slide15.split('\n');
    const start = lines.findIndex((l) => l.startsWith('> **[CUE]** NOTE:'));
    const end = lines.indexOf('> ```', start + 4);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const l of lines.slice(start, end + 1)) expect(l.startsWith('>'), l).toBe(true);
  });

  it('has a single presenter, so a slide carries no speaker tags and the header names the one presenter', () => {
    expect(md).not.toMatch(/^\[[^\]\n]+\]\s*$/m);
    const { name, org } = deck.meta.presenters.John;
    expect(md).toContain(`> Presenter: ${name} (${org})`);
    expect(md).not.toMatch(/How to read this script[\s\S]*square brackets/);
  });

  it('is deterministic and carries no clock, duration or pacing language', () => {
    expect(renderPresenterScript(deck)).toBe(md);
    expect(md).not.toMatch(/\b(wpm|words per minute|countdown|minutes? left|behind schedule|\d+\s?min(ute)?s?\b)/i);
    expect(md).toMatch(/Pacing is yours/);
  });

  it('the rendered deck and the markdown agree: zero artifact findings', () => {
    const html = renderDocument({ deck, css: '', js: '' });
    expect(checkArtifacts(deck, html, md)).toEqual([]);
  });

  it('is the committed file: docs/SPEAKER-SCRIPT.md is fresh (run `npm run build` if this fails)', () => {
    expect(readFileSync(new URL('../docs/SPEAKER-SCRIPT.md', import.meta.url), 'utf8')).toBe(md);
  });
});

describe('beat grouping and markdown details', () => {
  const slide = (script: Slide['script']): Slide => ({
    id: 'x', moduleCode: 'M1', presenter: 'John', layout: 'cover-hero-grid', purpose: 'p', title: 'T', blocks: [], script, sources: [],
  });

  it('merges consecutive optional beats of one group into a single drawer, and splits on a new group or a normal beat', () => {
    const groups = groupBeats([
      { t: 'say', text: 'a' },
      { t: 'say', text: 'b', optional: true, group: 'G1' },
      { t: 'cue', kind: 'note', text: 'c', optional: true, group: 'G1' },
      { t: 'say', text: 'd', optional: true, group: 'G2' },
      { t: 'say', text: 'e' },
      { t: 'say', text: 'f', optional: true },
    ]);
    expect(groups.map((g) => (g.kind === 'drawer' ? `drawer:${g.title}:${g.items.length}` : 'beat'))).toEqual(['beat', 'drawer:G1:2', 'drawer:G2:1', 'beat', 'drawer:Deeper answer:1']);
  });

  it('prints say beats as plain paragraphs and cues as blockquotes, with no speaker tags', () => {
    const lines = renderBeatsMarkdown(
      slide([
        { t: 'say', text: 'one' },
        { t: 'say', text: 'two' },
        { t: 'cue', kind: 'point', text: 'look' },
        { t: 'say', text: 'three' },
      ]),
    ).filter(Boolean);
    expect(lines).toEqual(['one', 'two', '> **[CUE]** POINT: look', 'three']);
  });

  it('words() in the round trip counts the same as the tool for tagged lines (tags never leak into speech)', () => {
    const md = `### [SLIDE 1] \u00b7 x \u00b7 T\n\n[Speaker]\nHello there.\n`;
    expect(words(parseScriptMarkdown(md).get(1) ?? '')).toEqual(['Hello', 'there.']);
    expect(lower(words('Hello there.'))).toEqual(['hello', 'there.']);
  });
});
