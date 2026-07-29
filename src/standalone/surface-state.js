import { appendMessage, setScreen, upsertMessage } from '../app/state.js';

const SCREEN_BY_SURFACE = Object.freeze({
  project_home: 'home',
  workflow_setup: 'setup-review',
  archive_inspecting: 'applying',
  archive_root_choice: 'archive-root-choice',
  archive_safety: 'archive-safety',
  plan_review: 'plan-review',
  plan_files: 'plan-files',
  conflict_summary: 'conflict-summary',
  conflict_file: 'conflict-file',
  operation_progress: 'applying',
  checks_failed: 'check-failed',
  commit_choice: 'commit',
  commit_message: 'commit-message',
  deploy_choice: 'deploy-prompt',
  completed: 'completed',
  history: 'run-history',
  run_details: 'run-details',
  rollback_confirm: 'rollback-confirm',
  error: 'error',
});

export function projectHomeItems({ workflowConfigured, activeRunId } = {}) {
  return [
    ...(activeRunId ? [{
      id: 'server:resume-run',
      label: 'Open active run',
      description: 'Resume the current server-owned workflow run.',
      serverLocal: true,
    }] : []),
    {
      id: 'server:archive',
      label: 'Apply update from ZIP',
      description: 'Upload an archive and review its semantic plan.',
      serverLocal: true,
      disabled: !workflowConfigured,
      disabledReason: workflowConfigured ? null : 'Configure the workflow first.',
    },
    {
      id: 'server:checks',
      label: 'Run project checks',
      description: 'Run only checks selected in the shared workflow.',
      serverLocal: true,
      disabled: !workflowConfigured,
      disabledReason: workflowConfigured ? null : 'Configure the workflow first.',
    },
    {
      id: 'server:workflow',
      label: workflowConfigured ? 'Review workflow settings' : 'Configure workflow',
      description: 'Read and save the shared project workflow through the local server.',
      serverLocal: true,
    },
    {
      id: 'server:history',
      label: 'Run history',
      description: 'Review durable server-owned workflow history.',
      serverLocal: true,
    },
    { id: 'server:exit', label: 'Exit', serverLocal: true },
  ];
}

export function applyProjectHome(state, project) {
  state.serverProject = structuredClone(project);
  state.project = {
    root: project.canonicalPath,
    name: project.project?.name ?? 'Project',
  };
  setScreen(state, 'home', {
    items: projectHomeItems(project),
    status: 'Ready',
    intro: [
      project.project?.name ?? 'Project',
      project.workflowConfigured
        ? 'Workflow configuration is owned by the local service.'
        : 'Configure a workflow before starting project operations.',
    ],
  });
  upsertMessage(state, 'server-project', 'Project detected', [
    `Path: ${project.canonicalPath}`,
    `Workflow: ${project.workflowConfigured ? `revision ${project.workflowRevision}` : 'not configured'}`,
    project.activeRunId ? `Active run: ${project.activeRunId}` : 'Active run: none',
  ], 'project', { collapsible: false });
}

export function applySemanticSurface(state, surface) {
  state.serverSurface = structuredClone(surface);
  state.serverRunId = runIdFromSurface(surface) || state.serverRunId || '';
  const items = [
    ...surfaceNavigationItems(surface),
    ...(surface.actions ?? []).map(actionMenuItem),
    { id: 'server:home', label: 'Back to project', serverLocal: true },
  ];
  setScreen(state, SCREEN_BY_SURFACE[surface.kind] ?? 'home', {
    items,
    status: surface.stage?.id ? `Stage ${surface.stage.index}/${surface.stage.count}` : 'Workflow',
    intro: [surface.title, surface.summary].filter(Boolean),
  });
  upsertMessage(state, `server-surface:${surface.id}`, surface.title, [
    surface.summary,
    ...surface.sections.flatMap(sectionLines),
  ].filter(Boolean), surface.kind === 'error' ? 'error' : 'summary', {
    collapsible: false,
  });
}

export function appendServerEvent(state, event) {
  const detail = event.data?.message
    ?? event.data?.phase
    ?? event.data?.change
    ?? '';
  appendMessage(state, eventLabel(event.type), [
    detail,
    event.runId ? `Run: ${event.runId}` : '',
    event.operationId ? `Operation: ${event.operationId}` : '',
  ].filter(Boolean), event.type === 'run.failed' ? 'error' : 'info', {
    collapsed: true,
  });
}

export function actionInputDescriptor(surface, action) {
  const schema = action?.inputSchema;
  if (!schema) return { kind: 'none', input: {} };
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length !== 1) return { kind: 'json', schema };
  const name = required[0];
  const property = schema.properties?.[name] ?? {};
  if (Array.isArray(property.enum)) {
    return { kind: 'choice', name, choices: property.enum.map((value) => ({ id: value, label: value })) };
  }
  if (name === 'rootId') {
    const choices = surface.sections
      .filter(({ kind }) => kind === 'choice_list')
      .flatMap(({ choices: values = [] }) => values)
      .map(({ id, label, description }) => ({ id, label, description }));
    return { kind: 'choice', name, choices };
  }
  if (name === 'path') {
    const paths = surface.sections.flatMap((section) => (
      section.kind === 'conflict'
        ? (section.conflicts ?? []).filter(({ decision }) => !decision).map(({ path }) => path)
        : section.kind === 'file_details'
          ? (section.files ?? []).map(({ path }) => path)
          : []
    ));
    return { kind: 'choice', name, choices: [...new Set(paths)].map((value) => ({ id: value, label: value })) };
  }
  if (name === 'message') return { kind: 'text', name, multiline: true };
  return { kind: 'json', schema };
}

function actionMenuItem(action) {
  return {
    id: `server:action:${action.id}`,
    label: action.label,
    description: action.description,
    disabled: action.enabled === false,
    disabledReason: action.disabledReason,
    serverAction: structuredClone(action),
  };
}

function surfaceNavigationItems(surface) {
  const links = surface.links ?? {};
  return [
    ...(links.plan ? [{
      id: 'server:view-plan',
      label: 'Review plan files',
      description: 'Load the paginated semantic plan.',
      serverLocal: true,
    }] : []),
    ...(links.history ? [{
      id: 'server:view-history',
      label: 'Run history',
      description: 'Load durable project run history.',
      serverLocal: true,
    }] : []),
    ...(links.report ? [{
      id: 'server:view-report',
      label: 'Run report',
      description: 'Load the sanitized run report.',
      serverLocal: true,
    }] : []),
  ];
}

function sectionLines(section) {
  switch (section.kind) {
    case 'text': return [section.text];
    case 'summary_fields': return (section.fields ?? []).map(({ label, value }) => `${label}: ${value}`);
    case 'progress': return [`${section.phase}: ${section.completed}/${section.total}`, section.message];
    case 'choice_list': return (section.choices ?? []).map(({ label, description }) => `${label}${description ? ` — ${description}` : ''}`);
    case 'plan_summary': return [`Files: ${section.files} · groups: ${section.groups} · unresolved: ${section.unresolvedConflicts}`];
    case 'file_groups': return (section.groups ?? []).map(({ label, count }) => `${label}: ${count}`);
    case 'file_details': return (section.files ?? []).slice(0, 40).map(({ path, change, decision }) => `${change}: ${path}${decision ? ` (${decision})` : ''}`);
    case 'conflict': return (section.conflicts ?? []).map(({ path, reason, decision }) => `${path}: ${decision || reason}`);
    case 'check_results': return (section.results ?? []).map(({ name, status, summary }) => `${status}: ${name}${summary ? ` — ${summary}` : ''}`);
    case 'commit': return section.suggestedMessage ? [`Suggested commit: ${section.suggestedMessage}`] : [];
    case 'deployment': return [`Deployment: ${section.configured ? section.label : 'not configured'}`];
    case 'history_rows': return (section.rows ?? []).map(({ id, status, summary }) => `${id}: ${status}${summary ? ` — ${summary}` : ''}`);
    case 'warning_list': return (section.warnings ?? []).map(({ message, path }) => `${path ? `${path}: ` : ''}${message}`);
    case 'error': return [`${section.code}: ${section.message}`];
    default: return [];
  }
}

function runIdFromSurface(surface) {
  const link = String(surface.links?.run ?? '');
  const match = /^\/v1\/runs\/([^/?#]+)$/.exec(link);
  return match ? decodeURIComponent(match[1]) : '';
}

function eventLabel(type) {
  return String(type || 'workflow.event')
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
