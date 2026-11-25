/**
 * Widget registry: render hooks (build time and runtime) and mounts (runtime only).
 *
 * A slide's widget kind selects one module. `mountSlide` also lights diagram `data-hl` groups,
 * which work on any slide. Importing this module is safe in Node: nothing touches the DOM at
 * import time.
 */

import type { Slide } from '../content/types';
import { decisionTreeHooks, mountDecisionTree } from './decisionTree';
import { quizHooks, mountQuiz } from './quiz';
import { mountHighlights, mountStaged, stagedHooks } from './staged';
import { mountTokenModel, tokenModelHooks } from './tokenModel';
import { type MountContext, type WidgetHandle, type WidgetRenderHooks, noopHandle } from './types';

export type { BlockDecor, MountContext, WidgetHandle, WidgetRenderHooks } from './types';

export function hooksFor(slide: Slide): WidgetRenderHooks | undefined {
  switch (slide.widget?.kind) {
    case 'token-model':
    case 'prompt-debugger':
      return tokenModelHooks;
    case 'decision-tree':
      return decisionTreeHooks;
    case 'staged':
      return stagedHooks;
    case 'quiz':
      return quizHooks;
    default:
      return undefined;
  }
}

export interface SlideInteractions extends WidgetHandle {
  /** The slide has a widget (the handle is real, not a no-op). */
  readonly hasWidget: boolean;
}

/**
 * Attach behaviour to one pre-rendered `<section class="slide">`.
 * With `interactive: false` (speaker-view previews) state is shown but nothing is bound.
 */
export function mountSlide(section: HTMLElement, slide: Slide, ctx: MountContext): SlideInteractions {
  let handle: WidgetHandle | undefined;
  switch (slide.widget?.kind) {
    case 'token-model':
    case 'prompt-debugger':
      handle = mountTokenModel(section, slide, ctx);
      break;
    case 'decision-tree':
      handle = mountDecisionTree(section, slide, ctx);
      break;
    case 'staged':
      handle = mountStaged(section, slide, ctx);
      break;
    case 'quiz':
      handle = mountQuiz(section, slide, ctx);
      break;
    default:
      handle = undefined;
  }
  const stopHighlights = mountHighlights(section, ctx.interactive);
  const base = handle ?? noopHandle('none');
  return {
    ...base,
    hasWidget: Boolean(handle),
    dispose() {
      stopHighlights();
      base.dispose();
    },
  };
}
