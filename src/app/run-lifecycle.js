import path from 'node:path';
import { removeIfExists } from '../utils/fs.js';
import { displayPath } from '../utils/paths.js';
import { getZipflowHome } from '../workflow/store.js';
import { runReportPath, saveRunRecord } from '../runs/store.js';

export async function cancelRun(controller) {
  if (controller.state.run && !controller.state.run.applied) {
    controller.state.run.status = 'cancelled';
    controller.state.run = await saveRunRecord(controller.state.run);
  }
  await releaseRunResources(controller);
  controller.message('Update cancelled', ['The project was not changed.']);
  controller.showHome();
}

export async function failRun(controller, error) {
  const { state } = controller;
  state.busy = false;
  if (state.run) {
    state.run.status = 'failed';
    state.run.error = { message: error.message, stack: error.stack };
    state.run = await saveRunRecord(state.run);
  }
  await releaseRunResources(controller);
  controller.message('Run failed', [
    error.message,
    state.run ? `Report: ${displayPath(runReportPath(state.run.id))}` : '',
  ].filter(Boolean), 'error');
  controller.showMenu('error', [
    { id: 'back-home', label: 'Return to project' },
    { id: 'exit', label: 'Exit' },
  ], 'Run failed');
}

export async function releaseRunResources(controller) {
  await controller.activeLock?.release?.();
  controller.activeLock = null;
  if (controller.state.run?.id) await removeIfExists(path.join(getZipflowHome(), 'tmp', controller.state.run.id));
}
