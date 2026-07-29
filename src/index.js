import { createWorkspaceApp } from 'terlio.js';
import { createInitialState } from './app/state.js';
import { ZipflowController } from './app/controller.js';
import { ClientBackedZipflowController } from './standalone/client-controller.js';
import { renderZipflow } from './ui/render.js';
import { createInterruptAwareInput } from './ui/interrupt-input.js';
import { installWorkspaceInterruptHandler } from './ui/workspace-interrupt.js';
import { spawn } from 'node:child_process';

export async function startZipflow({
  input = process.stdin,
  output = process.stdout,
  controllerFactory = null,
  directMode = process.env.ZIPFLOW_DIRECT_MODE === '1',
} = {}) {
  const state = createInitialState();
  const controller = controllerFactory
    ? await controllerFactory(state)
    : createStandaloneController(state, { directMode });
  const interrupt = () => { void controller.handleInterrupt().catch((error) => controller.handleUnexpected(error)); };
  const workspaceInput = createInterruptAwareInput(input, { onInterrupt: interrupt });
  const detachSigint = input === process.stdin ? registerSigintHandler(controller) : () => {};
  let detachWorkspaceInterrupt = () => {};
  const app = createWorkspaceApp({
    title: 'Zipflow',
    state,
    input: workspaceInput,
    output,
    pointer: 'auto',
    processHandlers: 'none',
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
        if (controller.restartRequested) relaunchZipflow();
        process.exitCode = code;
        setImmediate(() => process.exit(code));
      });
    },
  });
  controller.attachRuntime(app);
  detachWorkspaceInterrupt = installWorkspaceInterruptHandler(app, controller);
  await controller.boot();
  app.start();
  void controller.startStartupUpdateCheck().catch(() => {});
  return app;
}

export function createStandaloneController(state, {
  directMode = false,
  clientOptions = {},
  directOptions = {},
} = {}) {
  return directMode
    ? new ZipflowController(state, directOptions)
    : new ClientBackedZipflowController(state, clientOptions);
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

export function relaunchZipflow({ spawnImpl = spawn, execPath = process.execPath, argv = process.argv, cwd = process.cwd(), env = process.env } = {}) {
  const script = argv[1];
  if (!script) return null;
  const child = spawnImpl(execPath, [script, ...argv.slice(2)], { cwd, env, stdio: 'inherit' });
  child.unref?.();
  return child;
}
