import {
  MAX_FRAME_DELTA,
  SIM_DT,
  SIM_HZ,
  snapshotBytes,
  type MainToWorker,
  type SessionConfig,
  type WorkerToMain,
} from '../shared/protocol';
import { FixedStepClock } from './clock';
import { World } from './world';

/**
 * Simulation worker. The main thread drives it with one `tick` per display frame; the worker
 * runs as many fixed 2.5 ms steps as needed and answers with a snapshot of the last two states.
 */

interface WorkerScope {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
const pool: ArrayBuffer[] = [];
let world: World | null = null;
let session: SessionConfig | null = null;
let bufferBytes = 0;
let paused = false;

// Step cost, averaged over about a second.
let costTime = 0;
let costSteps = 0;
let costWindowStart = 0;
let stepCostUs = 0;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function tick(time: number): void {
  if (!world) return;
  let steps = 0;
  if (!paused) {
    steps = clock.advance(time);
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      if (i === steps - 1) world.storePrevious();
      world.step(SIM_DT);
    }
    if (steps > 0) {
      costTime += performance.now() - start;
      costSteps += steps;
    }
    if (time - costWindowStart >= 1) {
      stepCostUs = costSteps > 0 ? (costTime / costSteps) * 1000 : 0;
      costTime = 0;
      costSteps = 0;
      costWindowStart = time;
    }
  }
  while (world.warnings.length > 0) post({ type: 'warning', message: world.warnings.shift()! });

  const buffer = pool.pop() ?? new ArrayBuffer(bufferBytes);
  world.writeSnapshot(new Float32Array(buffer));
  post(
    {
      type: 'snapshot',
      simTime: clock.simTime,
      totalSteps: clock.totalSteps,
      steps,
      alpha: clock.alpha,
      stepCostUs,
      carCount: world.cars.length,
      buffer,
      race: world.director?.status ?? null,
    },
    [buffer],
  );
}

scope.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
      case 'session':
        session = msg.session;
        world = World.forSession(msg.session);
        bufferBytes = snapshotBytes(world.cars.length);
        pool.length = 0;
        clock.resetBaseline();
        post({ type: 'ready', carCount: world.cars.length });
        break;
      case 'tick':
        for (const buffer of msg.buffers) {
          if (buffer.byteLength === bufferBytes && pool.length < 4) pool.push(buffer);
        }
        world?.setInputs(msg.inputs);
        tick(msg.time);
        break;
      case 'pause':
        paused = true;
        clock.resetBaseline();
        break;
      case 'resume':
        paused = false;
        clock.resetBaseline();
        break;
      case 'command': {
        const command = msg.command;
        if (!world) break;
        if (command.kind === 'resetCar') world.resetCar(command.car);
        else if (command.kind === 'restart') world.restartSession(session?.gridSlot ?? 0);
        else if (command.kind === 'teleport') world.teleport(command.car, command.to);
        else if (command.kind === 'setAids') world.setAids(command.car, command.aids);
        break;
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    post({ type: 'error', message: err.message, stack: err.stack });
  }
};
