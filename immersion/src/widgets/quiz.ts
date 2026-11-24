/**
 * Slide 22 widget: the three-question Room Check (`m7-quiz`).
 *
 * Each question card carries 2-4 option chips. The letters (A, B, C) are CSS-generated from
 * `data-key`, never DOM text, so the slide's word budget is unchanged in every state.
 *
 *   1-4        pick that option for the active question (the room's answer)
 *   Enter      reveal the active question: rings the correct option, dims the rest
 *   0          clear the active question's pick (before it is revealed)
 *   click      option chip = pick; eye glyph = reveal; the dot strip under an option tallies a
 *              raised hand (Shift-click removes one); clicking a card makes it the active question
 *
 * Reveal uses glyphs only (check / cross via CSS). No explanation text is ever shown on screen;
 * the explanation is the presenter's, in the script.
 */

import { blockKey, type Container, type QuizSpec, type Slide } from '../content/types';
import { type BlockDecor, type MountContext, type WidgetHandle, type WidgetRenderHooks, digitOf } from './types';

const specOf = (slide: Slide): QuizSpec | undefined => (slide.widget?.kind === 'quiz' ? slide.widget : undefined);

const LETTERS = 'ABCD';
export const MAX_TALLY = 12;

function optionsHtml(options: number): string {
  let out = `<div class="opts" role="radiogroup" aria-label="Answer options">`;
  for (let i = 0; i < options; i++) {
    const letter = LETTERS[i] as string;
    out +=
      `<div class="opt" data-opt="${i}">` +
      `<button type="button" class="pick" role="radio" aria-checked="false" data-key="${letter}" aria-label="Option ${letter}"></button>` +
      `<button type="button" class="tally" data-tally="${i}" aria-label="Count a raised hand for option ${letter}"></button>` +
      `</div>`;
  }
  out += `<button type="button" class="reveal" data-reveal aria-label="Reveal the answer"></button></div>`;
  return out;
}

export const quizHooks: WidgetRenderHooks = {
  block(slide, block: Container): BlockDecor | undefined {
    const spec = specOf(slide);
    if (!spec) return undefined;
    const idx = spec.questions.findIndex((q) => q.key === blockKey(block));
    if (idx < 0) return undefined;
    const q = spec.questions[idx];
    if (!q) return undefined;
    return {
      classes: ['q'],
      attrs: { 'data-q': q.key, 'data-index': idx },
      inner: optionsHtml(q.options),
    };
  },
  root(slide) {
    return specOf(slide) ? { 'data-widget': 'quiz', 'data-active': '0' } : undefined;
  },
};

interface QState {
  picked: number | null;
  revealed: boolean;
  tally: number[];
}

export function mountQuiz(root: HTMLElement, slide: Slide, ctx: MountContext): WidgetHandle {
  const spec = specOf(slide);
  if (!spec) throw new Error('mountQuiz: slide has no quiz widget');
  const cards = spec.questions.map((q) => root.querySelector<HTMLElement>(`[data-q="${q.key}"]`));
  let state: QState[] = spec.questions.map((q) => ({ picked: null, revealed: false, tally: new Array<number>(q.options).fill(0) }));
  let active = 0;

  const apply = () => {
    root.dataset.active = String(active);
    spec.questions.forEach((q, i) => {
      const card = cards[i];
      const st = state[i] as QState;
      if (!card) return;
      card.classList.toggle('is-active', i === active);
      card.classList.toggle('is-revealed', st.revealed);
      card.dataset.state = st.revealed ? 'revealed' : st.picked !== null ? 'picked' : 'open';
      card.querySelectorAll<HTMLElement>('.opt').forEach((opt, o) => {
        const pick = opt.querySelector<HTMLElement>('.pick');
        const isPicked = st.picked === o;
        const isAnswer = q.answer === o;
        pick?.setAttribute('aria-checked', String(isPicked));
        opt.classList.toggle('is-picked', isPicked);
        opt.classList.toggle('is-correct', st.revealed && isAnswer);
        opt.classList.toggle('is-wrong', st.revealed && isPicked && !isAnswer);
        opt.classList.toggle('is-dim', st.revealed && !isAnswer && !(isPicked && !isAnswer));
        const strip = opt.querySelector<HTMLElement>('.tally');
        if (strip) {
          const n = st.tally[o] ?? 0;
          if (strip.childElementCount !== n) {
            strip.replaceChildren(...Array.from({ length: n }, () => document.createElement('i')));
          }
          strip.dataset.count = String(n);
        }
      });
    });
  };

  const nextOpen = (from: number): number => {
    for (let k = 1; k <= state.length; k++) {
      const i = (from + k) % state.length;
      if (!(state[i] as QState).revealed) return i;
    }
    return from;
  };

  const pick = (qi: number, o: number) => {
    const st = state[qi] as QState;
    const q = spec.questions[qi];
    if (!q || st.revealed || o < 0 || o >= q.options) return;
    active = qi;
    st.picked = st.picked === o ? null : o;
    apply();
    ctx.announce(st.picked === null ? `Question ${qi + 1}: pick cleared.` : `Question ${qi + 1}: option ${LETTERS[o]} picked.`);
    ctx.changed();
  };

  const reveal = (qi: number) => {
    const st = state[qi] as QState;
    const q = spec.questions[qi];
    if (!q || st.revealed) return;
    st.revealed = true;
    active = nextOpen(qi);
    apply();
    ctx.announce(`Question ${qi + 1}: the answer is option ${LETTERS[q.answer]}.`);
    ctx.changed();
  };

  const tally = (qi: number, o: number, delta: 1 | -1) => {
    const st = state[qi] as QState;
    st.tally[o] = Math.max(0, Math.min(MAX_TALLY, (st.tally[o] ?? 0) + delta));
    apply();
    ctx.changed();
  };

  const off: Array<() => void> = [];
  if (ctx.interactive) {
    cards.forEach((card, qi) => {
      if (!card) return;
      const click = (e: Event) => {
        const t = e.target as HTMLElement;
        const me = e as MouseEvent;
        const pickBtn = t.closest<HTMLElement>('.pick');
        const tallyBtn = t.closest<HTMLElement>('.tally');
        const revealBtn = t.closest<HTMLElement>('[data-reveal]');
        if (pickBtn) pick(qi, Number(pickBtn.closest<HTMLElement>('.opt')?.dataset.opt));
        else if (tallyBtn) tally(qi, Number(tallyBtn.dataset.tally), me.shiftKey ? -1 : 1);
        else if (revealBtn) reveal(qi);
        else {
          active = qi;
          apply();
          ctx.changed();
        }
      };
      card.addEventListener('click', click);
      off.push(() => card.removeEventListener('click', click));
    });
  } else {
    root.querySelectorAll<HTMLElement>('.q button').forEach((b) => b.setAttribute('tabindex', '-1'));
  }
  apply();

  return {
    kind: 'quiz',
    steps: 0,
    claimsDigits: true,
    getStep: () => 0,
    setStep: () => undefined,
    handleKey(e) {
      if (!ctx.interactive) return false;
      const d = digitOf(e);
      const q = spec.questions[active];
      if (d >= 1 && q && d <= q.options) {
        pick(active, d - 1);
        return true;
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!(state[active] as QState).revealed) {
          reveal(active);
          return true;
        }
        return false;
      }
      if (e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const st = state[active] as QState;
        if (!st.revealed && st.picked !== null) {
          st.picked = null;
          apply();
          ctx.changed();
        }
        return true;
      }
      return false;
    },
    getState: () => ({ active, state: state.map((s) => ({ ...s, tally: [...s.tally] })) }),
    setState(s) {
      const incoming = s as { active?: number; state?: QState[] } | null;
      if (incoming?.state && incoming.state.length === state.length) {
        state = incoming.state.map((x) => ({ picked: x.picked, revealed: x.revealed, tally: [...x.tally] }));
      }
      active = typeof incoming?.active === 'number' ? Math.max(0, Math.min(state.length - 1, incoming.active)) : 0;
      apply();
    },
    dispose() {
      for (const f of off) f();
    },
  };
}
