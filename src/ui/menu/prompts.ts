/**
 * Button prompts: the labels shown for each menu action, matching the device the player used
 * last (or the one picked in the settings).
 */

export type PromptFamily = 'playstation' | 'xbox' | 'generic' | 'keyboard' | 'touch';
export type PromptSetting = 'auto' | PromptFamily;

export type PromptAction = 'confirm' | 'back' | 'tabs' | 'adjust' | 'fast' | 'pause';

export interface Glyph {
  text: string;
  /** Extra CSS class for colour (PlayStation face buttons). */
  className?: string;
}

const PS: Record<PromptAction, Glyph[]> = {
  confirm: [{ text: '✕', className: 'ps-cross' }],
  back: [{ text: '○', className: 'ps-circle' }],
  tabs: [{ text: 'L1' }, { text: 'R1' }],
  adjust: [{ text: '◀ ▶' }],
  fast: [{ text: 'L2' }, { text: 'R2' }],
  pause: [{ text: 'OPTIONS' }],
};

const XBOX: Record<PromptAction, Glyph[]> = {
  confirm: [{ text: 'A', className: 'xb-a' }],
  back: [{ text: 'B', className: 'xb-b' }],
  tabs: [{ text: 'LB' }, { text: 'RB' }],
  adjust: [{ text: '◀ ▶' }],
  fast: [{ text: 'LT' }, { text: 'RT' }],
  pause: [{ text: 'MENU' }],
};

const KEYS: Record<PromptAction, Glyph[]> = {
  confirm: [{ text: 'Enter' }],
  back: [{ text: 'Esc' }],
  tabs: [{ text: 'Q' }, { text: 'E' }],
  adjust: [{ text: '← →' }],
  fast: [{ text: 'PgDn' }, { text: 'PgUp' }],
  pause: [{ text: 'Esc' }],
};

const TOUCH: Record<PromptAction, Glyph[]> = {
  confirm: [{ text: 'Tap' }],
  back: [{ text: 'Back' }],
  tabs: [{ text: 'Tabs' }],
  adjust: [{ text: 'Drag' }],
  fast: [],
  pause: [{ text: 'Pause' }],
};

export const PROMPT_SETS: Record<PromptFamily, Record<PromptAction, Glyph[]>> = {
  playstation: PS,
  xbox: XBOX,
  generic: XBOX,
  keyboard: KEYS,
  touch: TOUCH,
};

export const PROMPT_LABELS: Record<PromptSetting, string> = {
  auto: 'Automatic',
  playstation: 'PlayStation',
  xbox: 'Xbox',
  generic: 'Generic controller',
  keyboard: 'Keyboard',
  touch: 'Touch',
};

/** Which prompts to show: the manual choice, or the family of the device used last. */
export function promptFamily(
  setting: PromptSetting,
  lastDevice: 'keyboard' | 'gamepad' | 'wheel' | 'touch' | 'none',
  padFamily: 'playstation' | 'xbox' | 'generic',
): PromptFamily {
  if (setting !== 'auto') return setting;
  switch (lastDevice) {
    case 'gamepad':
      return padFamily;
    case 'touch':
      return 'touch';
    case 'wheel':
    case 'keyboard':
    case 'none':
      return 'keyboard';
  }
}
