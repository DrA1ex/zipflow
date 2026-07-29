export const HELLO = Object.freeze({
  apiVersion: '1.0',
  schemaRevision: 1,
  serverEpoch: 'epoch-1',
  capabilities: [],
});

export function fixturePaths(kind, socketPath) {
  return {
    endpoint: { kind, socketPath },
    tokenPath: kind === 'named-pipe'
      ? 'C:\\runtime\\server-v1.token'
      : '/tmp/runtime/server-v1.token',
  };
}

export function projectResource({ workflowConfigured }) {
  return {
    projectId: 'project-1',
    canonicalPath: '/project',
    project: { name: 'Fixture', technologies: [], labels: [] },
    workflowConfigured,
    workflowRevision: workflowConfigured ? 3 : 0,
    activeRunId: null,
    activeOperations: [],
    surface: {},
  };
}

export function semanticSurface() {
  return {
    id: 'plan-review:run-1',
    kind: 'plan_review',
    revision: 7,
    title: 'Review plan',
    summary: 'One file changes',
    stage: { id: 'plan', index: 2, count: 5 },
    sections: [{ id: 'summary', kind: 'plan_summary', files: 1, groups: 1, unresolvedConflicts: 0 }],
    actions: [
      {
        id: 'use-archive',
        kind: 'use_archive',
        label: 'Use archive version',
        description: 'Choose the archive version for a file.',
        enabled: true,
        disabledReason: null,
        risk: 'project_write',
        confirmation: 'explicit',
        inputSchema: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: { path: { type: 'string' } },
        },
        presentation: { role: 'secondary' },
      },
      {
        id: 'keep-local',
        kind: 'keep_local',
        label: 'Keep local version',
        description: 'Preserve the current local version of a file.',
        enabled: true,
        disabledReason: null,
        risk: 'project_write',
        confirmation: 'explicit',
        inputSchema: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: { path: { type: 'string' } },
        },
        presentation: { role: 'secondary' },
      },
      {
        id: 'approve-plan',
        kind: 'approve_plan',
        label: 'Apply plan',
        description: 'Apply the reviewed plan.',
        enabled: true,
        disabledReason: null,
        risk: 'project_write',
        confirmation: 'explicit',
        inputSchema: null,
        presentation: { role: 'primary' },
      },
    ],
    links: {
      run: '/v1/runs/run-1',
      plan: '/v1/runs/run-1/plan',
      self: '/v1/runs/run-1/surface',
    },
  };
}

export function fakeClient({
  calls,
  project,
  workflow,
  surface = semanticSurface(),
  historyItems = [{ runId: 'run-history-1', status: 'completed', summary: 'Fixture run' }],
  setupAction = async () => ({ ok: true }),
  openProjectHandler = null,
  runResource = null,
  reportHandler = null,
  planHandler = null,
  diffHandler = null,
  actionHandler = null,
}) {
  let openCount = 0;
  return {
    async openProject(request) {
      calls.push({ method: 'openProject', request });
      openCount += 1;
      return structuredClone(openProjectHandler
        ? await openProjectHandler(request, openCount)
        : project);
    },
    async getProject() {
      calls.push({ method: 'getProject' });
      return { ...structuredClone(project), workflowConfigured: true, workflowRevision: 1 };
    },
    async getWorkflow() {
      calls.push({ method: 'getWorkflow' });
      return structuredClone(workflow);
    },
    async getHistory() {
      calls.push({ method: 'getHistory' });
      return {
        items: structuredClone(historyItems),
        nextCursor: null,
      };
    },
    async putWorkflow(projectId, draft, options) {
      calls.push({ method: 'putWorkflow', projectId, draft, options });
      return { projectId, revision: options.ifMatch + 1, workflow: structuredClone(draft) };
    },
    async performProjectSetupAction(projectId, actionId, input, options) {
      calls.push({
        method: 'performProjectSetupAction',
        projectId,
        actionId,
        input,
        options,
      });
      return setupAction(actionId, input);
    },
    async uploadZip(source, options) {
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      calls.push({ method: 'uploadZip', options, bytes: Buffer.concat(chunks) });
      return { blobId: 'sha256:fixture', sha256: 'fixture', size: 6, filename: 'result.zip' };
    },
    async startArchiveRun(projectId, draft, options) {
      calls.push({ method: 'startArchiveRun', projectId, draft, options });
      return { runId: 'run-1', operationId: 'operation-1', status: 'running' };
    },
    async startDeployRun(projectId, draft, options) {
      calls.push({ method: 'startDeployRun', projectId, draft, options });
      return { runId: 'run-1', operationId: 'operation-1', status: 'running' };
    },
    async getRun(runId = 'run-1') {
      calls.push({ method: 'getRun' });
      return structuredClone(runResource
        ? { ...runResource, runId }
        : { runId, status: 'waiting_action', revision: 7, operationId: null });
    },
    async getReport(runId) {
      calls.push({ method: 'getReport', runId });
      if (reportHandler) return structuredClone(await reportHandler(runId));
      return {
        runId,
        kind: 'archive',
        status: 'completed',
        project: { projectId: 'project-1', name: 'Fixture' },
        workflow: { revision: 3, name: 'Fixture workflow' },
        archive: { filename: 'result.zip', size: 6, fileCount: 1 },
        plan: { counts: { created: 1, updated: 0, deleted: 0 } },
        checks: { passed: 1, failed: 0, ok: true },
        commit: null,
        deploy: null,
        rollback: null,
        decisions: [],
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:01.000Z',
        completedAt: '2026-07-29T00:00:01.000Z',
      };
    },
    async getOutput(runId, query) {
      calls.push({ method: 'getOutput', runId, query });
      return {
        runId,
        source: query.source,
        items: [{ sequence: 1, source: query.source, text: 'lint failed\n' }],
        nextCursor: null,
      };
    },
    async getSurface() {
      calls.push({ method: 'getSurface' });
      return structuredClone(surface);
    },
    async performAction(runId, actionId, input, options) {
      calls.push({ method: 'performAction', runId, actionId, input, options });
      if (actionHandler) {
        return structuredClone(await actionHandler(runId, actionId, input, options));
      }
      return { revision: 8 };
    },
    async getPlan(runId, query = {}) {
      calls.push({ method: 'getPlan', runId, query });
      if (planHandler) return structuredClone(await planHandler(runId, query));
      return {
        items: query.group === 'updated' || !query.group
          ? [{ path: 'src/index.js', kind: 'updated', decision: 'archive' }]
          : [],
        counts: {
          created: 0,
          updated: 1,
          deleted: 0,
          preserved: 0,
          unchanged: 0,
          skipped: 0,
          conflicts: 0,
        },
        nextCursor: null,
      };
    },
    async getDiff(runId, query = {}) {
      calls.push({ method: 'getDiff', runId, query });
      if (diffHandler) return structuredClone(await diffHandler(runId, query));
      return {
        path: 'src/index.js',
        binary: false,
        hunks: [{
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: 'remove', oldLine: 1, newLine: null, oldText: 'old', newText: '' },
            { type: 'add', oldLine: null, newLine: 1, oldText: '', newText: 'new' },
          ],
        }],
      };
    },
    events() {
      return (async function* empty() {})();
    },
    async close() {
      calls.push({ method: 'close' });
    },
  };
}

export function sequenceIds(...ids) {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}
