import { createWorkspaceApp } from 'terlio.js';
import { createInitialState } from './app/state.js';
import { ZipflowController } from './app/controller.js';
import { renderZipflow } from './ui/render.js';
import { advanceUiAnimation } from './app/ui-animation.js';

export async function startZipflow({ input = process.stdin, output = process.stdout } = {}) {
  const state = createInitialState();
  const controller = new ZipflowController(state);
  const app = createWorkspaceApp({
    title: 'Zipflow',
    state,
    input,
    output,
    pointer: 'auto',
    tickMs: 120,
    tick: ({ state: current, overlays }) => {
      const toastChanged = overlays?.tick?.(0.12) ?? false;
      let helpChanged = false;
      if (current.helpToast?.expiresAt && Date.now() >= current.helpToast.expiresAt) {
        current.helpToast = null;
        helpChanged = true;
      }
      const animationChanged = advanceUiAnimation(current);
      return toastChanged || helpChanged || animationChanged;
    },
    render: ({ state: current, width, height }) => renderZipflow({ state: current, width, height }),
    onKey: ({ key }) => { void controller.handleKey(key).catch((error) => controller.handleUnexpected(error)); },
    onExit: (code) => {
      void controller.cleanup().finally(() => {
        process.exitCode = code;
        setImmediate(() => process.exit(code));
      });
    },
  });
  controller.attachRuntime(app);
  app.start();
  await controller.boot();
  return app;
}

export { discoverProject } from './project/detect.js';
export { buildUpdatePlan } from './plan/build.js';
export { extractArchive } from './archive/extract.js';
export { createRecommendedWorkflow } from './workflow/defaults.js';
