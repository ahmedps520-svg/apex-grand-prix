import type { FunctionComponent } from 'preact';
import './menu.css';
import { PROMPT_SETS, type PromptAction } from './prompts';
import {
  AboutScreen,
  BindKeysScreen,
  BindPadScreen,
  CarSelectScreen,
  ChampionshipScreen,
  ControlsScreen,
  FreeSetupScreen,
  MainScreen,
  PauseScreen,
  RaceSetupScreen,
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
}

const SCREENS: Record<ScreenId, FunctionComponent<Props>> = {
  title: TitleScreen,
  main: MainScreen,
  trackSelect: TrackSelectScreen,
  carSelect: CarSelectScreen,
  championship: ChampionshipScreen,
  standings: StandingsScreen,
  raceSetup: RaceSetupScreen,
  freeSetup: FreeSetupScreen,
  pause: PauseScreen,
  results: ResultsScreen,
  settings: SettingsScreen,
  bindPad: BindPadScreen,
  bindKeys: BindKeysScreen,
  tester: TesterScreen,
  controls: ControlsScreen,
  about: AboutScreen,
};

/** Which prompts each screen shows in its footer. */
const FOOTER: Record<ScreenId, PromptAction[]> = {
  title: ['confirm'],
  main: ['confirm'],
  trackSelect: ['confirm', 'back'],
  carSelect: ['confirm', 'adjust', 'tabs', 'back'],
  championship: ['confirm', 'adjust', 'back'],
  standings: ['confirm'],
  raceSetup: ['confirm', 'adjust', 'back'],
  freeSetup: ['confirm', 'adjust', 'back'],
  pause: ['confirm', 'back'],
  results: ['confirm'],
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
  // Reading the revision re-renders the menus when a setting changes.
  void store.revision.value;
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
        <Screen store={store} />
      </div>
      <div class="menu-prompts">
        {FOOTER[top].map((action) => {
          const set = glyphs[action];
          if (set.length === 0) return null;
          return (
            <span class="menu-prompt">
              {set.map((g) => (
                <kbd class={g.className ? `glyph ${g.className}` : 'glyph'}>{g.text}</kbd>
              ))}
              <span>{PROMPT_TEXT[action]}</span>
            </span>
          );
        })}
        {store.message.value && <span class="menu-message">{store.message.value}</span>}
      </div>
    </div>
  );
}
