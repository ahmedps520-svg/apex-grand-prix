import { el, setText } from './dom';
import './radio.css';

/** How long a radio subtitle stays up, seconds. */
const SHOW_TIME = 5;

/** Subtitles for the race engineer's radio calls. */
export class RadioBox {
  readonly root = el('div', 'radio-box');
  enabled = true;
  private readonly text = el('div', 'radio-text');
  private timer = 0;

  constructor(parent: HTMLElement) {
    const label = el('div', 'radio-label', 'RACE ENGINEER');
    this.root.append(label, this.text);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  show(text: string): void {
    if (!this.enabled) return;
    setText(this.text, text);
    this.timer = SHOW_TIME + text.length * 0.03;
    this.root.hidden = false;
    this.root.classList.remove('in');
    // Restart the slide-in animation.
    void this.root.offsetWidth;
    this.root.classList.add('in');
  }

  update(dt: number): void {
    if (this.root.hidden) return;
    this.timer -= dt;
    if (this.timer <= 0) this.hide();
  }

  hide(): void {
    this.root.hidden = true;
    this.timer = 0;
  }
}
