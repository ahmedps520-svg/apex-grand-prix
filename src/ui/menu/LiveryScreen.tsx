import { useState } from 'preact/hooks';
import type { Settings } from '../../app/settings';
import {
  LIVERY_COLOURS,
  LIVERY_FINISHES,
  LIVERY_PATTERNS,
  LIVERY_PRESETS,
  randomLivery,
  sameDesign,
  sanitizeLivery,
  type Livery,
} from '../../content/livery';
import type { MenuStore } from './store';
import { Button, Choice } from './widgets';

/** Settings with the player's livery (compiles whether or not Settings declares it yet). */
type LiverySettings = Settings & { livery: Livery };

/** Preset choice value for the player's own design. */
const CUSTOM = '';

const COLOUR_OPTIONS = LIVERY_COLOURS.map((c) => ({ value: c.hex, text: c.name }));
const NUMBER_OPTIONS = Array.from({ length: 99 }, (_, i) => ({
  value: i + 1,
  text: String(i + 1),
}));

const cssColour = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

const isPreset = (livery: Livery): boolean =>
  LIVERY_PRESETS.some((p) => sameDesign(p.livery, livery));

/**
 * The livery editor: a preset or the player's own pattern, colours, race number and finish.
 * Every change is saved at once, so the car behind the menu shows it straight away.
 */
export function LiveryScreen({ store }: { store: MenuStore }) {
  // Reading the revision re-renders the screen after each change: @preact/signals would
  // otherwise skip it, as its props never change and it uses hook state.
  void store.revision.value;
  const settings = store.settings as LiverySettings;
  const livery = sanitizeLivery(settings.livery);
  const preset = LIVERY_PRESETS.find((p) => sameDesign(p.livery, livery));
  // The player's own design stays one step away while they browse the presets.
  const [custom, setCustom] = useState<Livery | null>(preset ? null : livery);
  const own = preset ? custom : livery;

  const apply = (next: Livery) => {
    settings.livery = next;
    if (!isPreset(next)) setCustom(next);
    store.changed();
  };
  const edit = (patch: Partial<Livery>) => apply({ ...livery, ...patch });

  const designs = [
    ...(own ? [{ value: CUSTOM, text: 'Custom' }] : []),
    ...LIVERY_PRESETS.map((p) => ({ value: p.name, text: p.name })),
  ];
  return (
    <div class="mn-panel mn-livery">
      <header class="mn-header">
        <h1 class="mn-title">Livery</h1>
        <p class="mn-subtitle">Colours, pattern and race number for your car</p>
      </header>
      <div class="mn-list">
        <Choice
          label="Design"
          value={preset?.name ?? CUSTOM}
          options={designs}
          onChange={(name) => {
            // Presets keep the player's race number.
            const design = LIVERY_PRESETS.find((p) => p.name === name)?.livery ?? own;
            if (design) apply({ ...design, number: livery.number });
          }}
          wrap
          autofocus
        />
        <Choice
          label="Pattern"
          value={livery.pattern}
          options={LIVERY_PATTERNS}
          onChange={(pattern) => edit({ pattern })}
          wrap
        />
        <ColourChoice
          label="Primary"
          value={livery.primary}
          onChange={(primary) => edit({ primary })}
        />
        <ColourChoice
          label="Secondary"
          value={livery.secondary}
          onChange={(secondary) => edit({ secondary })}
        />
        <ColourChoice
          label="Accent"
          value={livery.accent}
          onChange={(accent) => edit({ accent })}
        />
        <Choice
          label="Number"
          value={livery.number}
          options={NUMBER_OPTIONS}
          onChange={(number) => edit({ number })}
          wrap
        />
        <Choice
          label="Finish"
          value={livery.finish}
          options={LIVERY_FINISHES}
          onChange={(finish) => edit({ finish })}
          wrap
        />
        <Button
          label="Random"
          hint="A new colour scheme"
          onPress={() => apply({ ...randomLivery(Math.random), number: livery.number })}
        />
        <Button label="Done" onPress={() => store.pop()} primary />
      </div>
    </div>
  );
}

/** A palette colour with a swatch; a colour from outside the palette shows as "Custom". */
function ColourChoice(props: { label: string; value: number; onChange: (hex: number) => void }) {
  const known = LIVERY_COLOURS.some((c) => c.hex === props.value);
  const options = known
    ? COLOUR_OPTIONS
    : [{ value: props.value, text: 'Custom' }, ...COLOUR_OPTIONS];
  return (
    <div class="mn-paint">
      <span class="mn-swatch" style={{ background: cssColour(props.value) }} />
      <Choice
        label={props.label}
        value={props.value}
        options={options}
        onChange={props.onChange}
        wrap
      />
    </div>
  );
}
