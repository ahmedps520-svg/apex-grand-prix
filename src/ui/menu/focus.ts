import { nextInDirection, type Direction, type Rect } from './spatial';

/**
 * Menu events, whatever device they came from: D-pad / stick / arrow keys move, ✕ / A / Enter
 * confirm, ○ / B / Esc go back, L1 / R1 / Q / E switch tabs, and the triggers change sliders in
 * big steps.
 */
export type UiEvent =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'back'
  | 'tabPrev'
  | 'tabNext'
  | 'fastUp'
  | 'fastDown'
  | 'pause';

/** Custom event a "choice" control receives for left/right: `detail` is +1 or -1. */
export const NAV_ADJUST = 'nav-adjust';
/** Custom event dispatched on the screen for L1/R1: `detail` is +1 or -1. */
export const NAV_TAB = 'nav-tab';

const FOCUSED = 'nav-focus';
const SLIDER_FAST_STEPS = 10;

/**
 * Moves a highlight between the focusable items (`[data-nav]`) of the active screen with the
 * D-pad, stick or keys, and lets the mouse and touch use the same items. Only the scope's items
 * are candidates, so pop-ups keep the focus inside.
 *
 * `data-nav` values: `button` (confirm clicks it), `slider` (an `<input type="range">`: left and
 * right change it), `choice` (left and right send NAV_ADJUST), `tab` (a tab button; the selected
 * one has `aria-selected="true"` and is preferred when moving into the tab row).
 */
export class FocusManager {
  private current: HTMLElement | null = null;

  constructor(private readonly scope: () => HTMLElement | null) {
    document.addEventListener('pointermove', (e) => {
      const target = (e.target as HTMLElement | null)?.closest?.('[data-nav]');
      if (target instanceof HTMLElement && this.inScope(target)) this.focus(target, false);
    });
  }

  get focused(): HTMLElement | null {
    return this.current;
  }

  /** Makes sure something in the active screen is focused (call after the screen changed). */
  sync(): void {
    const root = this.scope();
    if (!root) {
      this.current = null;
      return;
    }
    if (this.current && this.inScope(this.current) && this.current.isConnected) return;
    const items = this.items(root);
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? items[0] ?? null;
    if (first) this.focus(first, true);
  }

  /** Handles a menu event; returns false if it wasn't for the focused item (e.g. back). */
  handle(event: UiEvent): boolean {
    this.sync();
    const root = this.scope();
    if (!root) return false;
    const el = this.current;
    const kind = el?.dataset.nav ?? 'button';
    switch (event) {
      case 'confirm':
        if (!el || kind === 'slider') return false;
        el.click();
        return true;
      case 'left':
      case 'right': {
        const delta = event === 'right' ? 1 : -1;
        if (el && kind === 'slider') return stepSlider(el as HTMLInputElement, delta);
        if (el && kind === 'choice') {
          el.dispatchEvent(new CustomEvent(NAV_ADJUST, { detail: delta, bubbles: true }));
          return true;
        }
        return this.move(root, event);
      }
      case 'up':
      case 'down':
        return this.move(root, event);
      case 'fastUp':
      case 'fastDown': {
        const delta = event === 'fastUp' ? SLIDER_FAST_STEPS : -SLIDER_FAST_STEPS;
        if (el && kind === 'slider') return stepSlider(el as HTMLInputElement, delta);
        if (el && kind === 'choice') {
          el.dispatchEvent(
            new CustomEvent(NAV_ADJUST, { detail: Math.sign(delta), bubbles: true }),
          );
          return true;
        }
        return false;
      }
      case 'tabPrev':
      case 'tabNext':
        root.dispatchEvent(
          new CustomEvent(NAV_TAB, { detail: event === 'tabNext' ? 1 : -1, bubbles: true }),
        );
        return true;
      default:
        return false;
    }
  }

  /** Focuses a specific element (e.g. after a tab switch). */
  focus(el: HTMLElement, scroll = true): void {
    if (this.current === el) return;
    this.current?.classList.remove(FOCUSED);
    this.current = el;
    el.classList.add(FOCUSED);
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private move(root: HTMLElement, direction: Direction): boolean {
    const items = this.items(root);
    if (items.length === 0) return false;
    const from = this.current && items.includes(this.current) ? this.current : null;
    if (!from) {
      this.focus(items[0]!);
      return true;
    }
    const rects: Rect[] = items.map((item) => toRect(item.getBoundingClientRect()));
    const fromRect = rects[items.indexOf(from)]!;
    const preferred = new Set<number>();
    items.forEach((item, i) => {
      if (item.getAttribute('aria-selected') === 'true') preferred.add(i);
    });
    const wrap = root.dataset.navWrap === 'true';
    const next = nextInDirection(fromRect, rects, direction, wrap, preferred);
    if (next < 0) return false;
    this.focus(items[next]!);
    return true;
  }

  private items(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-nav]')).filter(
      (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
    );
  }

  private inScope(el: HTMLElement): boolean {
    const root = this.scope();
    return root !== null && root.contains(el);
  }
}

function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Moves a range input by `steps` of its step size and tells listeners (as a user would). */
function stepSlider(input: HTMLInputElement, steps: number): boolean {
  const step = Number(input.step) || 1;
  const min = Number(input.min);
  const max = Number(input.max);
  const next = Math.min(Math.max(Number(input.value) + steps * step, min), max);
  if (next === Number(input.value)) return true;
  input.value = String(next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
