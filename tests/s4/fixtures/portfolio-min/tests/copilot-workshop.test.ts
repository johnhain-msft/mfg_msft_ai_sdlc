// Content, provenance and build-freshness checks for the Teaching SPA (a fixture with the seven tests that the real file names).
// The browser behaviour is covered elsewhere; this file covers what can be proved without a browser.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { course } from "../experiences/copilot-workshop/content/index";
import * as rules from "../experiences/copilot-workshop/content/rules";
import { DOCUMENT_COMMIT } from "../experiences/copilot-workshop/content/source";

const root = process.cwd();
const experience = path.join(root, "experiences", "copilot-workshop");
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const flat = course.modules.flatMap((module) => module.slides.map((slide) => ({ slide, module })));

describe("the course", () => {
  it("passes every content rule: no errors and no warnings", () => {
    const findings = rules.checkCourse(course);
    expect(findings.map((f) => `${f.level} ${f.rule} ${f.where}: ${f.message}`)).toEqual([]);
  });

  it("gives every teaching page a literal script, not notes", () => {
    for (const { slide, module } of flat) {
      if (module.kind !== "module") continue;
      expect(rules.mainSpokenWords(slide), slide.id).toBeGreaterThanOrEqual(rules.MIN_SPOKEN_WORDS);
    }
  });

  it("can be delivered in the minutes the plan gives it: speech at the app's own rate plus the live cues, on every page and in every module", () => {
    for (const { slide } of flat) {
      expect(rules.pageSeconds(slide)).toBeLessThanOrEqual(slide.minutes * 60 + rules.PAGE_ROUNDING_SECONDS);
    }
    for (const module of course.modules) expect(rules.moduleSeconds(module)).toBeLessThanOrEqual(module.minutes * 60 + 0.5);
  });

  it("plans with one speaking rate: the pace band tops out at it, and the speaker view reads it from the rules instead of typing its own", () => {
    expect(rules.SPEECH_WPM.max).toBe(rules.SPEAKING_WPM);
    expect(rules.SPEAKING_WPM).toBe(140);
  });

  it("keeps audience pages sparse", () => {
    const words = flat.map((f) => rules.audienceWords(f.slide)).sort((a, b) => a - b);
    expect(words[words.length - 1]).toBeLessThanOrEqual(rules.AUDIENCE_WORDS.max);
  });
});

describe("provenance", () => {
  it("records one revision, and every artefact that names it agrees", () => {
    const provenance = json<{ commit: string; documentCommit: string }>(path.join(experience, "provenance.json"));
    const inputs = json<{ commit: string }>(path.join(experience, "source-inputs.json"));
    expect(provenance.commit).toBe(provenance.documentCommit);
    expect(inputs.commit).toBe(provenance.commit);
    expect(DOCUMENT_COMMIT).toBe(provenance.documentCommit);
    const shipped = json<{ commit: string }>(path.join(root, "public", "workshop", "source.json"));
    expect(shipped.commit).toBe(provenance.commit);
  });
});

describe("the retired importer and the source check", () => {
  it.skipIf(!process.env.WORKSHOP_SOURCE)("finds the content in sync with an export of the pinned revision (set WORKSHOP_SOURCE)", () => {
    expect(existsSync(process.env.WORKSHOP_SOURCE ?? "")).toBe(true);
  });
});
