import { el } from './dom';

export interface ToastOptions {
  /** Seconds before it disappears; 0 = stays until dismissed or its action is used. */
  timeout?: number;
  action?: { label: string; run: () => void };
}

/** Small notices stacked in the bottom-left corner (controller connected, update ready, …). */
export class Toasts {
  readonly root = el('div', 'toasts');

  constructor(parent: HTMLElement) {
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  show(message: string, options: ToastOptions = {}): void {
    const toast = el('div', 'toast');
    toast.appendChild(el('span', 'toast-text', message));
    const close = () => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 300);
    };
    if (options.action) {
      const { label, run } = options.action;
      const button = el('button', 'toast-button', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        run();
        close();
      });
      toast.appendChild(button);
    }
    this.root.appendChild(toast);
    const timeout = options.timeout ?? 4;
    if (timeout > 0) setTimeout(close, timeout * 1000);
  }
}
