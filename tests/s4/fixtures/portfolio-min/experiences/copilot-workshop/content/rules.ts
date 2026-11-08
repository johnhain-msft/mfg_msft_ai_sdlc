// The content rules for the Teaching SPA, as pure functions (a small stand-in for the real module: the same constants and the same rule codes).
import { DOCUMENT_COMMIT } from './source';
import type { Course, Finding, Module, Slide } from './types';

/** Audience pages are sparse: aim for 60 visible words, never more than 90 (deck-repair standard). */
export const AUDIENCE_WORDS = { target: 60, max: 90 };
/** The speaking rate the whole app plans with, in words a minute. */
export const SPEAKING_WPM = 140;
/** Spoken words per planned page minute. */
export const SPEECH_WPM = { min: 55, max: SPEAKING_WPM };
/** What a page costs the presenter besides speech, in seconds, per cue on the main path. */
export const LIVE_SECONDS = {
  perCommand: 8,
  runMin: 10,
  wait: 15,
  ask: 10,
  switch: 5,
  click: 3,
  show: 2,
  point: 2,
} as const;
/** The floor of the pace band at the speaking rate. */
export const MIN_OCCUPANCY = SPEECH_WPM.min / SPEAKING_WPM;
/** Page minutes are multiples of 0.5, so a page whose need rounds to its planned half minute fits. */
export const PAGE_ROUNDING_SECONDS = 15;
/** Fewest spoken words any teaching page may carry. */
export const MIN_SPOKEN_WORDS = 25;
/** Longest single spoken paragraph before it should be split into breaths. */
export const MAX_PARAGRAPH_WORDS = 130;
/** Most the audience-visible fraction of the script may be lifted verbatim from the page. */
export const MAX_LIFT = 0.15;

export const wordCount = (text: string): number => {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
};

export const audienceWords = (s: Slide): number => wordCount([s.lead ?? '', ...s.blocks].join(' '));
export const mainSpokenWords = (s: Slide): number => s.script.reduce((n, line) => n + wordCount(line), 0);
export const speechSeconds = (s: Slide): number => (mainSpokenWords(s) / SPEAKING_WPM) * 60;
export const liveSeconds = (s: Slide): number => 0 * s.minutes;
export const pageSeconds = (s: Slide): number => speechSeconds(s) + liveSeconds(s);
export const moduleSeconds = (mod: Module): number => mod.slides.reduce((n, s) => n + pageSeconds(s), 0);
export const maxSpeechWords = (s: Slide): number => Math.floor(s.minutes * SPEAKING_WPM + 1e-9);

export function checkSlide(s: Slide, mod: Module): Finding[] {
  const out: Finding[] = [];
  const where = `${mod.code}/${s.id}`;
  const add = (level: Finding['level'], rule: string, message: string): void => void out.push({ level, rule, where, message });
  const aw = audienceWords(s);
  if (aw > AUDIENCE_WORDS.max) add('error', 'audience-words', `${aw} visible words (hard limit ${AUDIENCE_WORDS.max})`);
  else if (aw > AUDIENCE_WORDS.target) add('warn', 'audience-words', `${aw} visible words (target ${AUDIENCE_WORDS.target})`);
  if (s.lead && wordCount(s.lead) > 25) add('error', 'lead-length', `lead is ${wordCount(s.lead)} words (limit 25)`);
  const main = mainSpokenWords(s);
  const roomTime = mod.kind === 'interlude' && s.script.some((b) => b.t === 'cue' && b.kind === 'wait');
  const need = pageSeconds(s);
  if (need > s.minutes * 60 + PAGE_ROUNDING_SECONDS) {
    add('error', 'pace', `takes ${Math.round(need)} s to deliver but is planned for ${s.minutes * 60} s`);
  } else if (main > maxSpeechWords(s)) {
    add('error', 'pace-speech', `${main} main-path words are more than the ${maxSpeechWords(s)} that fit`);
  } else if (main >= MIN_SPOKEN_WORDS && need < MIN_OCCUPANCY * s.minutes * 60 && !roomTime) {
    add('warn', 'pace', 'uses less than the floor of its planned time');
  }
  if (s.blocks.some((block) => block.includes(`/blob/${DOCUMENT_COMMIT.slice(0, 7)}`))) add('error', 'link-pin', 'a source link is not pinned to the full revision');
  return out;
}

export function checkModule(mod: Module): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding['level'], rule: string, message: string): void => void out.push({ level, rule, where: mod.code, message });
  const delivery = moduleSeconds(mod);
  if (delivery > mod.minutes * 60 + 0.5) add('error', 'module-pace', `delivering every page as written takes ${Math.round(delivery)} s`);
  mod.slides.forEach((s) => out.push(...checkSlide(s, mod)));
  return out;
}

export function checkCourse(course: Course): Finding[] {
  return course.modules.flatMap((m) => checkModule(m));
}
