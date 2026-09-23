import type {
  DriverInput,
  MainToWorker,
  SimCommand,
  SnapshotMessage,
  WorkerToMain,
} from '../shared/protocol';

/**
 * Main-thread side of the simulation worker. Sends one `tick` per display frame and keeps the
 * newest snapshot. Snapshot buffers go back to the worker with the next tick, so the same few
 * buffers are reused instead of allocating new ones every frame.
 */
export class SimClient {
  latest: SnapshotMessage | null = null;
  /** Float view of `latest.buffer`. */
  latestView: Float32Array | null = null;
  snapshotsReceived = 0;
  onWarning: (message: string) => void = (m) => console.warn(m);
  onError: (message: string) => void = (m) => console.error(m);

  private readonly worker: Worker;
  private returned: ArrayBuffer[] = [];
  private readyResolve: (() => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.onMessage(event.data);
    this.worker.onerror = (event) => this.onError(`Simulation worker failed: ${event.message}`);
  }

  init(playerCount: number): Promise<void> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      this.post({ type: 'init', playerCount });
    });
  }

  tick(timeSeconds: number, inputs: DriverInput[]): void {
    const buffers = this.returned;
    this.returned = [];
    this.post({ type: 'tick', time: timeSeconds, inputs, buffers }, buffers);
  }

  pause(): void {
    this.post({ type: 'pause' });
  }

  resume(): void {
    this.post({ type: 'resume' });
  }

  command(command: SimCommand): void {
    this.post({ type: 'command', command });
  }

  dispose(): void {
    this.worker.terminate();
  }

  private post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private onMessage(message: WorkerToMain): void {
    switch (message.type) {
      case 'ready':
        this.readyResolve?.();
        this.readyResolve = null;
        break;
      case 'snapshot':
        // The previous snapshot has been used for rendering by now: give its buffer back.
        if (this.latest) this.returned.push(this.latest.buffer);
        this.latest = message;
        this.latestView = new Float32Array(message.buffer);
        this.snapshotsReceived++;
        break;
      case 'warning':
        this.onWarning(message.message);
        break;
      case 'error':
        this.onError(message.message);
        break;
    }
  }
}
