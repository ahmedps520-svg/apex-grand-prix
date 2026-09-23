import { el, setText } from './dom';

/** One adjustable setting in the quick menu. */
export interface MenuItem {
  label: string;
  /** Current value as display text. */
  value(): string;
  /** Steps the value up (+1) or down (-1). */
  change(direction: 1 | -1): void;
}

export type MenuAction = 'menuNext' | 'menuPrev' | 'menuUp' | 'menuDown';

const HIDE_AFTER = 4;

/**
 * In-race quick menu, like a race car's multi-function display: D-pad left/right (or Tab)
 * picks a setting, up/down (or [ ]) changes it. The first press only opens it. Hides itself
 * after a few seconds without input; changes apply immediately.
 */
export class QuickMenu {
  readonly root = el('div', 'mfd');
  private readonly label = el('div', 'mfd-label');
  private readonly value = el('div', 'mfd-value');
  private readonly dots = el('div', 'mfd-dots');
  private index = 0;
  private idle = 0;

  constructor(
    parent: HTMLElement,
    private readonly items: MenuItem[],
  ) {
    const row = el('div', 'mfd-row');
    row.append(el('span', 'mfd-arrow', '◀'), this.value, el('span', 'mfd-arrow', '▶'));
    for (let i = 0; i < items.length; i++) this.dots.appendChild(el('span'));
    this.root.append(this.label, row, this.dots, el('div', 'mfd-hint'));
    this.root.hidden = true;
    parent.appendChild(this.root);
    this.render();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  get selected(): MenuItem {
    return this.items[this.index]!;
  }

  handle(action: MenuAction): void {
    this.idle = 0;
    if (!this.visible) {
      this.root.hidden = false;
      this.render();
      return;
    }
    const n = this.items.length;
    if (action === 'menuNext') this.index = (this.index + 1) % n;
    else if (action === 'menuPrev') this.index = (this.index - 1 + n) % n;
    else this.selected.change(action === 'menuUp' ? 1 : -1);
    this.render();
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.idle += dt;
    if (this.idle > HIDE_AFTER) this.root.hidden = true;
  }

  /** Re-reads the values (after a setting changed elsewhere). */
  refresh(): void {
    if (this.visible) this.render();
  }

  setHint(text: string): void {
    setText(this.root.lastElementChild as HTMLElement, text);
  }

  private render(): void {
    const item = this.selected;
    setText(this.label, item.label);
    setText(this.value, item.value());
    Array.from(this.dots.children).forEach((d, i) => d.classList.toggle('on', i === this.index));
  }
}

/** Cycles through a fixed list of options. */
export function choiceItem<T>(
  label: string,
  options: ReadonlyArray<{ value: T; text: string }>,
  get: () => T,
  set: (value: T) => void,
  wrap = false,
): MenuItem {
  const index = () =>
    Math.max(
      options.findIndex((o) => o.value === get()),
      0,
    );
  return {
    label,
    value: () => options[index()]!.text,
    change: (direction) => {
      let i = index() + direction;
      if (wrap) i = (i + options.length) % options.length;
      else i = Math.min(Math.max(i, 0), options.length - 1);
      set(options[i]!.value);
    },
  };
}

/** A number stepped between limits, shown as a percentage. */
export function percentItem(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (value: number) => void,
): MenuItem {
  return {
    label,
    value: () => `${Math.round(get() * 100)}%`,
    change: (direction) => {
      const next = Math.round((get() + direction * step) / step) * step;
      set(Math.min(Math.max(next, min), max));
    },
  };
}
