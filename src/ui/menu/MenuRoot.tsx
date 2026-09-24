import type { FunctionComponent } from 'preact';
import { hasTouch } from '../../input/TouchControls';
import './menu.css';
import { LiveryScreen } from './LiveryScreen';
import { PROMPT_SETS, type PromptAction } from './prompts';
import {
  AboutScreen,
  BindKeysScreen,
  BindPadScreen,
  BoardScreen,
  CareerScreen,
  CarSelectScreen,
  ChampionshipScreen,
  ControlsScreen,
  FreeSetupScreen,
  MainScreen,
  MapScreen,
  PauseScreen,
  RaceSetupScreen,
  ReplayScreen,
  ResultsScreen,
  RoamSetupScreen,
  SchoolOfferScreen,
  SettingsScreen,
  StandingsScreen,
  TesterScreen,
  TitleScreen,
  TrackSelectScreen,
} from './screens';
import type { MenuStore, ScreenId } from './store';

interface Props {
  store: MenuStore;
  /** Settings revision: a new value re-renders the screen after a setting changed. */
  revision?: number;
}

const SCREENS: Record<ScreenId, FunctionComponent<Props>> = {
  title: TitleScreen,
  main: MainScreen,
  trackSelect: TrackSelectScreen,
  carSelect: CarSelectScreen,
  livery: LiveryScreen,
  schoolOffer: SchoolOfferScreen,
  championship: ChampionshipScreen,
  standings: StandingsScreen,
  raceSetup: RaceSetupScreen,
  freeSetup: FreeSetupScreen,
  roamSetup: RoamSetupScreen,
  map: MapScreen,
  board: BoardScreen,
  career: CareerScreen,
  pause: PauseScreen,
  results: ResultsScreen,
  replay: ReplayScreen,
  settings: SettingsScreen,
  bindPad: BindPadScreen,
  bindKeys: BindKeysScreen,
  tester: TesterScreen,
  controls: ControlsScreen,
  about: AboutScreen,
};

/** Which prompts each screen shows in its footer, with the text when it isn't the usual one. */
const FOOTER: Record<ScreenId, Array<PromptAction | [PromptAction, string]>> = {
  title: ['confirm'],
  main: ['confirm'],
  trackSelect: ['confirm', 'back'],
  carSelect: ['confirm', 'tabs', 'back'],
  livery: ['confirm', 'adjust', 'back'],
  schoolOffer: ['confirm'],
  championship: ['confirm', 'adjust', 'back'],
  standings: ['confirm'],
  raceSetup: ['confirm', 'adjust', 'back'],
  freeSetup: ['confirm', 'adjust', 'back'],
  roamSetup: ['confirm', 'adjust', 'back'],
  map: ['confirm', 'back'],
  board: ['confirm', 'back'],
  career: ['confirm', 'back'],
  pause: ['confirm', 'back'],
  results: ['confirm'],
  replay: [
    ['confirm', 'Play / pause'],
    ['adjust', 'Rewind / forward'],
    ['tabs', 'Car'],
    ['fast', 'Camera'],
    ['back', 'Exit'],
  ],
  settings: ['confirm', 'adjust', 'fast', 'tabs', 'back'],
  bindPad: ['confirm', 'back'],
  bindKeys: ['confirm', 'back'],
  tester: [],
  controls: ['back'],
  about: ['back'],
};

const PROMPT_TEXT: Record<PromptAction, string> = {
  confirm: 'Select',
  back: 'Back',
  tabs: 'Tabs',
  adjust: 'Change',
  fast: 'Faster',
  pause: 'Pause',
};

/** Prompts that work as a tap (touch, or a click): what each sends. */
const TAPS: Partial<Record<PromptAction, 'back' | 'pause' | 'confirm' | 'tabNext'>> = {
  back: 'back',
  pause: 'pause',
  tabs: 'tabNext',
};

/** The menu layer: the screen on top of the stack plus the button prompts for it. */
export function MenuRoot({ store }: Props) {
  const stack = store.stack.value;
  const top = stack[stack.length - 1];
  // Reading the revision re-renders the menus when a setting changes; passing it on makes the
  // screen re-render too (signals skip components whose props didn't change).
  const revision = store.revision.value;
  if (!top) return null;
  const Screen = SCREENS[top];
  const glyphs = PROMPT_SETS[store.prompts.value];
  const overGame = store.inSession.value;
  // The screen's way back (Back, Exit, …), for the touch button in the corner.
  const backEntry = FOOTER[top].find((e) => (typeof e === 'string' ? e : e[0]) === 'back');
  const backText = backEntry
    ? typeof backEntry === 'string'
      ? PROMPT_TEXT.back
      : backEntry[1]
    : null;
  return (
    <div class={overGame ? 'menu over-game' : 'menu'} data-top={top}>
      <div
        class="menu-screen"
        key={top}
        data-screen={top}
        data-nav-wrap={
          top === 'settings' || top === 'trackSelect' || top === 'carSelect' ? undefined : 'true'
        }
      >
        <Screen store={store} revision={revision} />
      </div>
      {backText !== null && hasTouch() && (
        <button
          type="button"
          class="menu-back"
          data-touch-back
          onClick={() => store.actions.tap('back')}
        >
          ‹ {backText}
        </button>
      )}
      <div class="menu-prompts">
        {FOOTER[top].map((entry) => {
          const [action, text] = typeof entry === 'string' ? [entry, PROMPT_TEXT[entry]] : entry;
          const set = glyphs[action];
          if (set.length === 0) return null;
          const inner = (
            <>
              {set.map((g) => (
                <kbd class={g.className ? `glyph ${g.className}` : 'glyph'}>{g.text}</kbd>
              ))}
              <span>{text}</span>
            </>
          );
          const tap = TAPS[action];
          if (!tap) return <span class="menu-prompt">{inner}</span>;
          return (
            <button
              type="button"
              class="menu-prompt tappable"
              onClick={() => store.actions.tap(tap)}
            >
              {inner}
            </button>
          );
        })}
        {store.message.value && <span class="menu-message">{store.message.value}</span>}
      </div>
    </div>
  );
}
