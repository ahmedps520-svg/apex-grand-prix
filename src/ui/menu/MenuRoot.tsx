import type { FunctionComponent } from 'preact';
import './menu.css';
import { LiveryScreen } from './LiveryScreen';
import { PROMPT_SETS, type PromptAction } from './prompts';
import {
  AboutScreen,
  BindKeysScreen,
  BindPadScreen,
  CarSelectScreen,
  ChampionshipScreen,
  ControlsScreen,
  FreeSetupScreen,
  RoamSetupScreen,
  MainScreen,
  PauseScreen,
  RaceSetupScreen,
  ReplayScreen,
  SchoolOfferScreen,
  ResultsScreen,
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
      <div class="menu-prompts">
        {FOOTER[top].map((entry) => {
          const [action, text] = typeof entry === 'string' ? [entry, PROMPT_TEXT[entry]] : entry;
          const set = glyphs[action];
          if (set.length === 0) return null;
          return (
            <span class="menu-prompt">
              {set.map((g) => (
                <kbd class={g.className ? `glyph ${g.className}` : 'glyph'}>{g.text}</kbd>
              ))}
              <span>{text}</span>
            </span>
          );
        })}
        {store.message.value && <span class="menu-message">{store.message.value}</span>}
      </div>
    </div>
  );
}
