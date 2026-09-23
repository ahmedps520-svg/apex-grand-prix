import { useState } from 'preact/hooks';
import {
  PHOTO_APERTURES,
  PHOTO_FILTERS,
  PHOTO_FOCUS_MAX,
  PHOTO_FOCUS_MIN,
  PHOTO_FOV_MAX,
  PHOTO_FOV_MIN,
  PHOTO_ROLL_MAX,
  type PhotoSettings,
} from '../../render/PhotoMode';
import { PROMPT_SETS, type Glyph, type PromptFamily } from './prompts';
import type { MenuStore } from './store';
import { Choice, Note, Section, Slider, Toggle, percent } from './widgets';

export interface PhotoScreenProps {
  store: MenuStore;
  /** Changed in place by the panel; `onChange` follows every change. */
  settings: PhotoSettings;
  onChange(): void;
  onCapture(): void;
  onExit(): void;
  /** Set when depth of field can't run here: the lens settings give way to this note. */
  dofUnavailable?: string;
  /** A line under the buttons, e.g. "Saved apex-grand-prix-….png". */
  status?: string;
}

/** Controller and key glyphs for photo mode's own buttons. */
interface PhotoGlyphs {
  capture: Glyph[];
  hide: Glyph[];
  /** How to move the camera: glyphs and what they do. */
  help: Array<[string, string]>;
}

const PS: PhotoGlyphs = {
  capture: [{ text: '□', className: 'ps-square' }],
  hide: [{ text: '△', className: 'ps-triangle' }],
  help: [
    ['R', 'Orbit'],
    ['L', 'Move'],
    ['L2 R2', 'Zoom'],
    ['L1 R1', 'Roll'],
  ],
};

const XBOX: PhotoGlyphs = {
  capture: [{ text: 'X', className: 'xb-x' }],
  hide: [{ text: 'Y', className: 'xb-y' }],
  help: [
    ['RS', 'Orbit'],
    ['LS', 'Move'],
    ['LT RT', 'Zoom'],
    ['LB RB', 'Roll'],
  ],
};

const KEYS: PhotoGlyphs = {
  capture: [{ text: 'C' }],
  hide: [{ text: 'H' }],
  help: [
    ['Drag', 'Orbit'],
    ['Right-drag', 'Move'],
    ['Wheel', 'Zoom'],
    ['J L I K', 'Orbit'],
    ['A D R F', 'Move'],
    ['W S', 'Zoom'],
    ['Q E', 'Roll'],
  ],
};

const TOUCH: PhotoGlyphs = {
  capture: [],
  hide: [],
  help: [
    ['Drag', 'Orbit'],
    ['Two fingers', 'Move'],
    ['Pinch', 'Zoom'],
  ],
};

const GLYPHS: Record<PromptFamily, PhotoGlyphs> = {
  playstation: PS,
  xbox: XBOX,
  generic: XBOX,
  keyboard: KEYS,
  touch: TOUCH,
};

const FOCUS_CHOICES = [
  { value: true, text: 'On the car' },
  { value: false, text: 'Manual' },
] as const;

/** Focus distance slider: 0 … 100 on a log scale from 0.5 m to 300 m. */
const FOCUS_STEPS = 100;
const focusToStep = (metres: number): number =>
  Math.round(
    (Math.log(Math.min(Math.max(metres, PHOTO_FOCUS_MIN), PHOTO_FOCUS_MAX) / PHOTO_FOCUS_MIN) /
      Math.log(PHOTO_FOCUS_MAX / PHOTO_FOCUS_MIN)) *
      FOCUS_STEPS,
  );
const stepToFocus = (step: number): number =>
  PHOTO_FOCUS_MIN * (PHOTO_FOCUS_MAX / PHOTO_FOCUS_MIN) ** (step / FOCUS_STEPS);
const metres = (m: number): string => (m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);

const apertureIndex = (f: number): number => {
  let best = 0;
  PHOTO_APERTURES.forEach((stop, i) => {
    if (Math.abs(stop - f) < Math.abs(PHOTO_APERTURES[best]! - f)) best = i;
  });
  return best;
};

const signed = (v: number, digits = 0): string => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

function Glyphs(props: { glyphs: Glyph[] }) {
  return (
    <>
      {props.glyphs.map((g) => (
        <kbd class={g.className ? `glyph ${g.className}` : 'glyph'}>{g.text}</kbd>
      ))}
    </>
  );
}

/**
 * Photo mode's panel: a compact column at the right edge of the view (no dimming) with the
 * camera, lens and look settings, and Capture, Hide panel and Exit. Everything is a `data-nav`
 * item, so the menu focus engine drives it with a controller or the keys (scope it to
 * `.photo-panel`), and mouse and touch work on it directly. With `settings.showPanel` off only
 * a small "show panel" button remains, and it fades out so the picture is unobstructed.
 */
export function PhotoScreen(props: PhotoScreenProps) {
  const s = props.settings;
  const [, redraw] = useState(0);
  const family = props.store.prompts.value;
  const glyphs = GLYPHS[family];
  const back = PROMPT_SETS[family].back;
  const set = <K extends keyof PhotoSettings>(key: K, value: PhotoSettings[K]) => {
    s[key] = value;
    redraw((n) => n + 1);
    props.onChange();
  };

  if (!s.showPanel) {
    return (
      <div class="photo-host-inner">
        <button type="button" class="photo-reveal" onClick={() => set('showPanel', true)}>
          <span>Show panel</span>
          <Glyphs glyphs={glyphs.hide} />
        </button>
      </div>
    );
  }

  return (
    <aside
      class="photo-panel"
      data-nav-wrap="true"
      aria-label="Photo mode"
      // The focus engine drives sliders itself; a focused range input would take the arrow keys.
      onFocusIn={(e) => {
        const target = e.target as HTMLElement | null;
        if (target instanceof HTMLInputElement && target.type === 'range') target.blur();
      }}
    >
      <header class="photo-head">
        <span class="photo-badge">PHOTO</span>
        <span class="photo-title">Photo mode</span>
      </header>
      <div class="photo-actions">
        <Action label="Capture" glyphs={glyphs.capture} onPress={props.onCapture} primary />
        <Action label="Hide" glyphs={glyphs.hide} onPress={() => set('showPanel', false)} />
        <Action label="Exit" glyphs={back} onPress={props.onExit} />
      </div>
      {props.status && <p class="photo-status">{props.status}</p>}
      <div class="photo-body">
        <Section title="Camera">
          <Slider
            label="Field of view"
            value={Math.round(s.fov)}
            min={PHOTO_FOV_MIN}
            max={PHOTO_FOV_MAX}
            step={1}
            format={(v) => `${v}°`}
            onChange={(v) => set('fov', v)}
          />
          <Slider
            label="Roll"
            value={Math.round(s.roll)}
            min={-PHOTO_ROLL_MAX}
            max={PHOTO_ROLL_MAX}
            step={1}
            format={(v) => `${signed(v)}°`}
            onChange={(v) => set('roll', v)}
          />
        </Section>
        <Section title="Lens">
          {props.dofUnavailable ? (
            <Note>{props.dofUnavailable}</Note>
          ) : (
            <>
              <Toggle label="Depth of field" value={s.dof} onChange={(v) => set('dof', v)} />
              {s.dof && (
                <>
                  <Choice
                    label="Focus"
                    value={s.autofocus}
                    options={FOCUS_CHOICES}
                    onChange={(v) => set('autofocus', v)}
                    wrap
                  />
                  {!s.autofocus && (
                    <Slider
                      label="Distance"
                      value={focusToStep(s.focusDistance)}
                      min={0}
                      max={FOCUS_STEPS}
                      step={1}
                      format={(v) => metres(stepToFocus(v))}
                      onChange={(v) => set('focusDistance', Math.round(stepToFocus(v) * 10) / 10)}
                    />
                  )}
                  <Slider
                    label="Aperture"
                    value={apertureIndex(s.aperture)}
                    min={0}
                    max={PHOTO_APERTURES.length - 1}
                    step={1}
                    format={(i) => `f/${PHOTO_APERTURES[i] ?? ''}`}
                    onChange={(i) => set('aperture', PHOTO_APERTURES[i] ?? s.aperture)}
                  />
                </>
              )}
            </>
          )}
        </Section>
        <Section title="Look">
          <Slider
            label="Exposure"
            value={s.exposure}
            min={-3}
            max={3}
            step={0.1}
            format={(v) => `${signed(v, 1)} EV`}
            onChange={(v) => set('exposure', Math.round(v * 10) / 10)}
          />
          <Slider
            label="Contrast"
            value={s.contrast}
            min={0.5}
            max={1.5}
            step={0.05}
            format={percent}
            onChange={(v) => set('contrast', v)}
          />
          <Slider
            label="Saturation"
            value={s.saturation}
            min={0}
            max={2}
            step={0.05}
            format={percent}
            onChange={(v) => set('saturation', v)}
          />
          <Choice
            label="Filter"
            value={s.filter}
            options={PHOTO_FILTERS}
            onChange={(v) => set('filter', v)}
            wrap
          />
          <Slider
            label="Vignette"
            value={s.vignette}
            min={0}
            max={1}
            step={0.05}
            format={percent}
            onChange={(v) => set('vignette', v)}
          />
          <Slider
            label="Film grain"
            value={s.grain}
            min={0}
            max={1}
            step={0.05}
            format={percent}
            onChange={(v) => set('grain', v)}
          />
        </Section>
        <Section title="Save">
          <Toggle label="Watermark" value={s.watermark} onChange={(v) => set('watermark', v)} />
        </Section>
        <dl class="photo-help">
          {glyphs.help.map(([keys, action]) => (
            <div>
              <dt>
                {keys.split(' ').map((k) => (
                  <kbd class="glyph">{k}</kbd>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
        {family !== 'keyboard' && family !== 'touch' && (
          <Note>Hide the panel to move, zoom and roll with the controller.</Note>
        )}
      </div>
    </aside>
  );
}

/** A menu button (the focus engine's `button`) showing its controller or key glyph. */
function Action(props: { label: string; glyphs: Glyph[]; onPress: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      class={props.primary ? 'mn-button primary photo-action' : 'mn-button photo-action'}
      data-nav="button"
      data-autofocus={props.primary ? '' : undefined}
      onClick={props.onPress}
    >
      <span class="mn-label">{props.label}</span>
      <Glyphs glyphs={props.glyphs} />
    </button>
  );
}
