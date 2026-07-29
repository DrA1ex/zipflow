import { appendMessage, setScreen } from '../app/state.js';

export async function showWorkflowResource(controller) {
  const resource = await controller.client.getWorkflow(controller.project.projectId);
  controller.workflowResource = resource;
  const workflow = resource.workflow ?? resource.suggestedWorkflow;
  controller.state.workflow = workflow;
  const configured = Boolean(resource.workflow);
  setScreen(controller.state, 'setup-review', {
    status: configured ? `Workflow revision ${resource.revision}` : 'Workflow draft',
    intro: [
      configured ? 'Shared workflow configuration' : 'Recommended workflow configuration',
      workflow
        ? `${workflow.checks?.filter(({ selected }) => selected).length ?? 0} selected checks · ${workflow.archive?.mode ?? 'overlay'} mode`
        : 'No server-provided workflow draft is available.',
    ],
    items: [
      ...(workflow ? [{
        id: 'server:save-workflow',
        label: configured ? 'Save current workflow' : 'Use recommended workflow',
        description: 'Persist the complete workflow through the server revision boundary.',
        serverLocal: true,
        activate: 'save-workflow',
      }] : []),
      { id: 'server:home', label: 'Back to project', serverLocal: true },
    ],
  });
  controller.invalidate();
}

export async function saveWorkflowResource(controller) {
  const resource = controller.workflowResource;
  const workflow = resource?.workflow ?? resource?.suggestedWorkflow;
  if (!workflow) throw Object.assign(new Error('No workflow draft is available.'), {
    code: 'ACTION_NOT_AVAILABLE',
  });
  await controller.client.putWorkflow(controller.project.projectId, workflow, {
    ifMatch: resource.revision,
    idempotencyKey: `zipflow:tui:workflow:${controller.project.projectId}:${resource.revision}`,
  });
  await controller.showProject();
}

export async function showHistoryResource(controller) {
  const history = await controller.client.getHistory(controller.project.projectId, { limit: 100 });
  const items = history.items ?? history.runs ?? [];
  appendMessage(controller.state, 'Run history', items.map((run) => (
    `${run.runId ?? run.id}: ${run.status}`
  )), 'summary');
  setScreen(controller.state, 'run-history', {
    status: 'History',
    intro: ['Durable workflow history'],
    items: [
      ...items.map((run) => ({
        id: `server:history-run:${run.runId ?? run.id}`,
        label: `${run.status} · ${run.runId ?? run.id}`,
        description: run.summary ?? '',
        serverLocal: true,
        runId: run.runId ?? run.id,
      })),
      { id: 'server:home', label: 'Back to project', serverLocal: true },
    ],
  });
  controller.invalidate();
}

export async function showPlanResource(controller) {
  const plan = await controller.client.getPlan(controller.runId, { limit: 100 });
  const items = plan.items ?? plan.files ?? [];
  appendMessage(controller.state, 'Plan files', items.map((item) => (
    `${item.change ?? item.kind}: ${item.path}`
  )), 'summary');
  setScreen(controller.state, 'plan-files', {
    status: 'Plan files',
    intro: [
      `${items.length} changed files`,
      plan.nextCursor ? 'Additional files are available through the server cursor.' : 'Complete page',
    ],
    items: [
      ...items.map((item) => ({
        id: `server:diff:${item.path}`,
        label: `${item.change ?? item.kind} · ${item.path}`,
        description: 'Open the server-projected semantic diff.',
        serverLocal: true,
        diffPath: item.path,
      })),
      { id: 'server:home', label: 'Back to project', serverLocal: true },
    ],
  });
  controller.invalidate();
}

export async function showDiffResource(controller, diffPath, mode = 'unified') {
  const resource = await controller.client.getDiff(controller.runId, { path: diffPath, mode });
  controller.state.diffView = {
    diff: legacyDiff(resource),
    mode,
    path: resource.path,
    files: [resource.path],
    fileIndex: 0,
    hunkIndex: 0,
    scroll: 0,
  };
  setScreen(controller.state, 'diff-view', { status: 'Diff' });
  controller.invalidate();
}

export async function showReportResource(controller) {
  const report = await controller.client.getReport(controller.runId);
  appendMessage(controller.state, 'Run report', report.lines ?? [JSON.stringify(report)], 'summary');
  controller.invalidate();
}

function legacyDiff(resource) {
  if (resource.binary) {
    return {
      binary: true,
      message: resource.message || 'Binary or large file.',
      rows: [],
    };
  }
  return {
    binary: false,
    rows: (resource.hunks ?? []).flatMap(({ lines = [] }) => lines.map((line) => ({
      type: line.type === 'context' ? 'same' : line.type,
      oldNo: line.oldLine,
      newNo: line.newLine,
      oldText: line.oldText ?? line.text ?? '',
      newText: line.newText ?? line.text ?? '',
    }))),
  };
}
