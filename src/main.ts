import './style.css';
import { Game } from './app/Game';
import { chooseRenderer, rememberFallback } from './app/rendererChoice';
import { registerServiceWorker } from './pwa/register';
import { RendererHost } from './render/RendererHost';
import { Toasts } from './ui/Toasts';

/** Brings the loading screen back with an error message and a reload button. */
function showFatal(title: string, detail: string): void {
  const text = document.getElementById('loading-text');
  document.body.classList.remove('running');
  document.body.classList.add('fatal');
  if (text) text.textContent = `${title} ${detail}`;
  const card = document.querySelector('.loading-card');
  if (card && !card.querySelector('button')) {
    const button = document.createElement('button');
    button.className = 'fatal-button';
    button.type = 'button';
    button.textContent = 'Reload';
    button.addEventListener('click', () => window.location.reload());
    card.appendChild(button);
  }
}

/** Seconds after start-up during which a lost WebGPU device means "use WebGL2 next time". */
const EARLY_LOSS_WINDOW = 15;

async function boot(): Promise<void> {
  const container = document.getElementById('app');
  const ui = document.getElementById('ui');
  if (!container || !ui) throw new Error('Page markup is missing #app or #ui');

  const toasts = new Toasts(ui);
  registerServiceWorker((apply) =>
    toasts.show('A new version is ready.', { timeout: 0, action: { label: 'Reload', run: apply } }),
  );

  // Stop iPad Safari from pinch-zooming the game.
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  const choice = chooseRenderer(new URLSearchParams(window.location.search));
  const host = new RendererHost(container, choice.forceWebGL);
  try {
    await host.init();
  } catch (error) {
    console.error(error);
    showFatal(
      'Your browser could not start the 3D renderer.',
      'Please use a recent Chrome, Edge or Safari with hardware acceleration enabled.',
    );
    return;
  }

  const startedAt = performance.now();
  host.onDeviceLost(() => {
    const early = (performance.now() - startedAt) / 1000 < EARLY_LOSS_WINDOW;
    if (host.backend === 'WebGPU' && early && choice.reason === null && rememberFallback()) {
      window.location.reload();
      return;
    }
    showFatal('The graphics device stopped responding.', 'Reload to continue.');
  });
  if (choice.reason === 'fallback') {
    toasts.show(
      'WebGPU failed on this device before, so the game is using WebGL2. Open the game with ?renderer=webgpu to try WebGPU again.',
      { timeout: 10 },
    );
  }

  const game = new Game(host, ui, toasts);
  await game.start();
}

boot().catch((error: unknown) => {
  console.error(error);
  showFatal('Something went wrong while loading.', error instanceof Error ? error.message : '');
});
