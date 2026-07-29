import { appendMessage } from '../app/state.js';
import { copyZipflowText } from '../ui/clipboard.js';

export async function showClientFailedCheckOutput(controller) {
  const output = await controller.client.getOutput(controller.runId, { source: 'checks' });
  const text = (output.items ?? []).map(({ text: value }) => value).join('');
  appendMessage(controller.state, 'Failed check output', [
    ...(text ? text.split(/\r?\n/) : ['No bounded check output was recorded.']),
  ], 'error', { collapsible: false });
  controller.invalidate();
}

export async function copyClientFailedCheckReport(controller) {
  const [report, output] = await Promise.all([
    controller.client.getReport(controller.runId),
    controller.client.getOutput(controller.runId, { source: 'checks' }),
  ]);
  const lines = [
    `Zipflow run: ${report.runId}`,
    `Status: ${report.status}`,
    `Project: ${report.project?.name ?? 'Project'}`,
    `Checks: ${report.checks?.passed ?? 0} passed, ${report.checks?.failed ?? 0} failed`,
    '',
    ...(output.items ?? []).map(({ text: value }) => value),
    ...(report.llmFailure?.text ? ['', 'Local LLM explanation:', report.llmFailure.text] : []),
  ];
  const copied = await copyZipflowText(lines.join('\n'), {
    output: controller.runtime?.output,
  });
  controller.toast(
    copied ? 'Failure report copied' : 'Failure report unavailable',
    copied ? 'success' : 'warning',
  );
}
