/**
 * Responsive 16:9 stage fitting.
 *
 * Slides are authored on a fixed 1920x1080 stage. `fitStage` scales that stage into whatever box
 * contains it (1920x1080, 1536x864, 1366x768, any window, a speaker-view thumbnail) and centres
 * it with absolute positioning + translate(-50%, -50%), never as a shrinkable flex item: a
 * flex-centred 1920px canvas squeezes on a narrower window and clips silently. The scale is
 * letterboxed (uniform), so nothing ever clips and the aspect ratio never changes.
 */

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/** Uniform scale that fits a design size inside a box. Never zero, never NaN. */
export function computeScale(boxWidth: number, boxHeight: number, designWidth = STAGE_WIDTH, designHeight = STAGE_HEIGHT): number {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return 0.01;
  return Math.max(0.01, Math.min(boxWidth / designWidth, boxHeight / designHeight));
}

/**
 * Keep `--scale` on `target` equal to the scale that fits the design stage into `container`.
 * Re-fits on container resize, window resize, orientation change and fullscreen change.
 * Returns a disposer.
 */
export function fitStage(container: HTMLElement, target: HTMLElement, designWidth = STAGE_WIDTH, designHeight = STAGE_HEIGHT): () => void {
  const apply = () => {
    const r = container.getBoundingClientRect();
    target.style.setProperty('--scale', computeScale(r.width, r.height, designWidth, designHeight).toFixed(5));
  };
  apply();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
  ro?.observe(container);
  window.addEventListener('resize', apply);
  document.addEventListener('fullscreenchange', apply);
  return () => {
    ro?.disconnect();
    window.removeEventListener('resize', apply);
    document.removeEventListener('fullscreenchange', apply);
  };
}
