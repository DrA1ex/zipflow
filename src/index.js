import { createWorkspaceApp } from 'terlio.js';
import { createInitialState } from './app/state.js';
import { ZipflowController } from './app/controller.js';
import { renderZipflow } from './ui/render.js';
import { createInterruptAwareInput } from './ui/interrupt-input.js';
import { installWorkspaceInterruptHandler } from './ui/workspace-interrupt.js';

export async function startZipflow({ input = process.stdin, output = process.stdout } = {}) {
  const state = createInitialState();
  const workspaceInput = createInterruptAwareInput(input);
  const controller = new ZipflowController(state);
  const detachSigint = input === process.stdin ? registerSigintHandler(controller) : () => {};
  let detachWorkspaceInterrupt = () => {};
  const app = createWorkspaceApp({
    title: 'Zipflow',
    state,
    input: workspaceInput,
    output,
    pointer: 'auto',
    tickMs: 120,
    animationMs: 100,
    tick: ({ overlays }) => overlays?.tick?.(0.12) ?? false,
    render: ({ state: current, width, height, animationFrame }) => renderZipflow({
      state: current, width, height, animationFrame,
    }),
    onKey: ({ key }) => { void controller.handleKey(key).catch((error) => controller.handleUnexpected(error)); },
    onExit: (code) => {
      detachSigint();
      detachWorkspaceInterrupt();
      void controller.cleanup().finally(() => {
        process.exitCode = code;
        setImmediate(() => process.exit(code));
      });
    },
  });
  controller.attachRuntime(app);
  detachWorkspaceInterrupt = installWorkspaceInterruptHandler(app, controller);
  await controller.boot();
  app.start();
  return app;
}


export function registerSigintHandler(controller, processObject = process) {
  const handler = () => { void controller.handleInterrupt().catch((error) => controller.handleUnexpected(error)); };
  processObject.on('SIGINT', handler);
  return () => processObject.off('SIGINT', handler);
}

export { discoverProject } from './project/detect.js';
export { buildUpdatePlan } from './plan/build.js';
export { extractArchive } from './archive/extract.js';
export { createRecommendedWorkflow } from './workflow/defaults.js';
