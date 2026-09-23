import './intro.css';

/** Length of the intro when nothing skips it, seconds. */
const LENGTH = 4.6;

/**
 * The launch intro: the (fictional) studio's mark draws itself, then the game's logo sweeps in.
 * Any key, click, tap or controller button skips it. Resolves when it has finished or been
 * skipped, while the game keeps loading underneath.
 */
export function playIntro(parent: HTMLElement): Promise<void> {
  const root = document.createElement('div');
  root.className = 'intro';
  root.innerHTML = `
    <div class="intro-studio">
      <svg class="intro-mark" viewBox="0 0 120 120" aria-hidden="true">
        <path d="M18 100 L60 18 L102 100" />
        <path d="M38 72 H82" />
        <path d="M60 18 L60 44" />
      </svg>
      <div class="intro-studio-name">KESTRELIGHT</div>
      <div class="intro-studio-sub">GAMES</div>
    </div>
    <div class="intro-game">
      <div class="intro-logo">APEX <span>GRAND PRIX</span></div>
      <div class="intro-stripe"></div>
    </div>
    <div class="intro-skip">Press any button to skip</div>`;
  parent.appendChild(root);

  return new Promise((resolve) => {
    let done = false;
    let frame = 0;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      for (const type of ['keydown', 'pointerdown']) window.removeEventListener(type, finish);
      root.classList.add('intro-out');
      window.setTimeout(() => root.remove(), 450);
      resolve();
    };
    const timer = window.setTimeout(finish, LENGTH * 1000);
    for (const type of ['keydown', 'pointerdown']) window.addEventListener(type, finish);
    // Controllers have no button events: watch for any press.
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (pad?.buttons.some((b) => b.pressed)) {
          finish();
          return;
        }
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
  });
}
