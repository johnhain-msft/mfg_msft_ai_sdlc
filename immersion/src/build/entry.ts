/**
 * Node-side entry bundled by `scripts/build.mjs`. Exposes everything the build needs from the
 * TypeScript sources: the deck, the validators, the renderers. No DOM.
 */

export { deck } from '../content';
export { checkArtifacts, checkDeck, formatFinding, summarize } from '../content/rules';
export type { Finding, Report } from '../content/rules';
export { renderDocument } from '../shell/page';
export { renderPresenterScript } from './markdown';
