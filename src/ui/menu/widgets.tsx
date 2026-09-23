import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { NAV_ADJUST } from './focus';

/**
 * Menu building blocks. Every control carries `data-nav` so the focus engine can reach it with
 * a controller, and works with mouse, touch and keyboard as ordinary HTML.
 */

export function Button(props: {
  label: string;
  onPress: () => void;
  hint?: string;
  autofocus?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      class={props.primary ? 'mn-button primary' : 'mn-button'}
      data-nav="button"
      data-autofocus={props.autofocus ? '' : undefined}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      <span class="mn-label">{props.label}</span>
      {props.hint && <span class="mn-hint">{props.hint}</span>}
    </button>
  );
}

/** A setting with a fixed list of values: left/right (or clicking the arrows) steps through. */
export function Choice<T>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; text: string }>;
  onChange: (value: T) => void;
  wrap?: boolean;
  autofocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    props.options.findIndex((o) => o.value === props.value),
    0,
  );
  const step = (delta: number) => {
    const n = props.options.length;
    let i = index + delta;
    i = props.wrap ? (i + n) % n : Math.min(Math.max(i, 0), n - 1);
    const next = props.options[i];
    if (next && i !== index) props.onChange(next.value);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onAdjust = (e: Event) => step((e as CustomEvent<number>).detail);
    el.addEventListener(NAV_ADJUST, onAdjust);
    return () => el.removeEventListener(NAV_ADJUST, onAdjust);
  });
  return (
    <div
      ref={ref}
      class="mn-row mn-choice"
      data-nav="choice"
      data-autofocus={props.autofocus ? '' : undefined}
      tabIndex={0}
      onClick={() => step(1)}
    >
      <span class="mn-label">{props.label}</span>
      <span class="mn-value">
        <span
          class="mn-arrow"
          onClick={(e) => {
            e.stopPropagation();
            step(-1);
          }}
        >
          ◀
        </span>
        <span class="mn-value-text">{props.options[index]?.text ?? ''}</span>
        <span
          class="mn-arrow"
          onClick={(e) => {
            e.stopPropagation();
            step(1);
          }}
        >
          ▶
        </span>
      </span>
    </div>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Choice
      label={props.label}
      value={props.value}
      options={[
        { value: false, text: 'Off' },
        { value: true, text: 'On' },
      ]}
      onChange={props.onChange}
      wrap
    />
  );
}

/** A number setting shown as a slider; left/right step it, the triggers move it fast. */
export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label class="mn-row mn-slider">
      <span class="mn-label">{props.label}</span>
      <input
        type="range"
        data-nav="slider"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
      />
      <span class="mn-value-text">{props.format(props.value)}</span>
    </label>
  );
}

export function Tabs<T extends string>(props: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div class="mn-tabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          type="button"
          role="tab"
          class={t.id === props.active ? 'mn-tab active' : 'mn-tab'}
          aria-selected={t.id === props.active ? 'true' : 'false'}
          data-nav="tab"
          onClick={() => props.onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Section(props: { title?: string; children: ComponentChildren }) {
  return (
    <section class="mn-section">
      {props.title && <h3 class="mn-section-title">{props.title}</h3>}
      {props.children}
    </section>
  );
}

export function Note(props: { children: ComponentChildren }) {
  return <p class="mn-note">{props.children}</p>;
}

export const percent = (v: number): string => `${Math.round(v * 100)}%`;
