/** Shared runtime constants (no imports, importable from anywhere). */

/** Prefix for every localStorage key the deck writes. */
export const STORAGE_PREFIX = 'ai-sdlc-immersion';

export const THEME_KEY = `${STORAGE_PREFIX}:theme`;
export const FONT_KEY = `${STORAGE_PREFIX}:notes-size`;
export const WATCH_KEY = `${STORAGE_PREFIX}:stopwatch`;

/** Window names, so a second press of S or R focuses the existing window instead of opening another. */
export const SPEAKER_WINDOW = 'ai-sdlc-immersion-speaker';
export const DECK_WINDOW = 'ai-sdlc-immersion-main';
export const SCRIPT_WINDOW = 'ai-sdlc-immersion-script-book';
