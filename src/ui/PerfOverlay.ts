import { el, setText } from './dom';

export interface PerfStats {
  version: string;
  backend: string;
  fps: number;
  frameMs: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  width: number;
  height: number;
  scale: number;
  devicePixelRatio: number;
  simHz: number;
  stepsPerFrame: number;
  stepCostUs: number;
  device: string;
}

/** Top-left performance readout. Updated a few times a second, not every frame. */
export class PerfOverlay {
  readonly root = el('div', 'perf');
  private readonly text = el('pre', 'perf-text');
  private visible = true;

  constructor(
    parent: HTMLElement,
    onScale: (delta: number) => void,
    onCamera: () => void,
    onReset: () => void,
  ) {
    const buttons = el('div', 'perf-buttons');
    const button = (label: string, title: string, fn: () => void) => {
      const b = el('button', 'perf-button', label);
      b.title = title;
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
        b.blur();
      });
      buttons.appendChild(b);
    };
    button('Res −', 'Lower resolution scale ( [ )', () => onScale(-0.1));
    button('Res +', 'Raise resolution scale ( ] )', () => onScale(0.1));
    button('Camera', 'Change camera (C)', onCamera);
    button('Reset', 'Reset car (R)', onReset);
    this.root.append(this.text, buttons);
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(s: PerfStats): void {
    if (!this.visible) return;
    const lines = [
      `APEX GP ${s.version} · ${s.backend}`,
      `FPS ${s.fps.toFixed(1)} · ${s.frameMs.toFixed(1)} ms (worst ${s.worstMs.toFixed(1)})`,
      `Draw calls ${s.drawCalls} · ${formatCount(s.triangles)} tris`,
      `Render ${s.width}×${s.height} · scale ${Math.round(s.scale * 100)}% · DPR ${s.devicePixelRatio.toFixed(2)}`,
      `Physics ${s.simHz.toFixed(0)} Hz · ${s.stepsPerFrame.toFixed(1)} steps/frame · ${s.stepCostUs.toFixed(1)} µs/step`,
      `Input: ${s.device}`,
    ];
    setText(this.text, lines.join('\n'));
  }
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
