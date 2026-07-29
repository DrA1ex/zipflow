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

export function projectHomeItems({
  workflowConfigured,
  activeRunId,
  lastArchiveRun = null,
} = {}, workflow = null) {
  const selectedChecks = workflow?.checks?.filter(({ selected }) => selected).length ?? 0;
  const deployConfigured = workflow?.deploy?.policy !== 'disabled'
    && Boolean(workflow?.deploy?.commandText);
  return [
    ...(activeRunId ? [{
      id: 'server:resume-run',
      label: 'Open active run',
      description: 'Resume the current server-owned workflow run.',
      serverLocal: true,
    }] : []),
    {
      id: 'server:archive',
      label: 'Start an update',
      description: 'Choose a ZIP archive and use the saved workflow.',
      serverLocal: true,
      disabled: !workflowConfigured,
      disabledReason: workflowConfigured ? null : 'Configure the workflow first.',
    },
    {
      id: 'server:checks',
      label: 'Run tests',
      description: selectedChecks
        ? `Run ${selectedChecks} configured check${selectedChecks === 1 ? '' : 's'} against the current project.`
        : 'Run checks selected in the shared workflow.',
      serverLocal: true,
      disabled: !workflowConfigured,
      disabledReason: workflowConfigured ? null : 'Configure the workflow first.',
    },
    ...(deployConfigured ? [{
      id: 'server:deploy',
      label: 'Run deployment',
      description: `${workflow.deploy.cwd === '.' ? 'Root' : `${workflow.deploy.cwd}/`} · ${workflow.deploy.commandText}`,
      serverLocal: true,
    }] : []),
    {
      id: 'server:workflow',
      label: workflowConfigured ? 'Change workflow' : 'Set up this project',
      description: workflowConfigured
        ? 'Review and update the workflow; nothing changes until you confirm the final step.'
        : 'Review the detected project and configure the shared workflow.',
      serverLocal: true,
    },
    ...(!workflowConfigured ? [{
      id: 'server:choose-directory',
      label: 'Choose another directory',
      description: 'Tab completes directory names.',
      serverLocal: true,
    }] : []),
    {
      id: 'server:create-zip',
      label: 'Create ZIP',
      description: 'Export tracked, non-ignored, selected, or all project files.',
      serverLocal: true,
    },
    {
      id: 'server:repeat-last',
      label: 'Repeat last archive',
      description: lastArchiveRun
        ? 'Rebuild the previous archive plan against the current project.'
        : 'No previous archive.',
      disabled: !lastArchiveRun,
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
  const discovered = state.project?.root === project.canonicalPath
    ? structuredClone(state.project)
    : {};
  state.project = {
    ...discovered,
    ...structuredClone(project.project ?? {}),
    root: project.canonicalPath,
    name: project.project?.name ?? 'Project',
  };
  setScreen(state, project.workflowConfigured ? 'home' : 'new-project', {
    items: projectHomeItems(project, state.workflow),
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
  let items = [
    ...surfaceNavigationItems(surface),
    ...(surface.actions ?? []).map(actionMenuItem),
    { id: 'server:home', label: 'Back to project', serverLocal: true },
  ];
  if (surface.kind === 'checks_failed') {
    items = [
      { id: 'server:copy-failure', label: 'Copy failure report', description: 'Compact report for ChatGPT', serverLocal: true },
      { id: 'server:view-failure', label: 'View full failed output', serverLocal: true },
      ...items,
    ];
  }
  let screen = SCREEN_BY_SURFACE[surface.kind] ?? 'home';
  if (surface.actions?.some(({ id }) => id === 'create-checkpoint')) {
    screen = 'conflict-checkpoint';
  } else if (surface.actions?.some(({ id }) => id === 'retry-deploy')) {
    screen = 'deploy-failed';
  }
  if (surface.kind === 'completed' && state.run?.kind === 'checks') {
    screen = 'manual-checks-result';
    items = [
      ...surfaceNavigationItems(surface),
      { id: 'server:checks-again', label: 'Run tests again', serverLocal: true },
      { id: 'server:home', label: 'Return to project', serverLocal: true },
    ];
  } else if (surface.kind === 'completed' && state.run?.kind === 'deploy') {
    screen = 'manual-deploy-result';
    items = [
      ...surfaceNavigationItems(surface),
      { id: 'server:deploy-again', label: 'Run deployment again', serverLocal: true },
      { id: 'server:home', label: 'Return to project', serverLocal: true },
    ];
  }
  setScreen(state, screen, {
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

export function applyServerRunAdvisory(state, run, report = null) {
  const running = run?.summary?.llm?.status === 'running';
  if (running) {
    upsertMessage(state, `server-llm:${run.runId}:running`, 'Local LLM analysis starting', [
      'The deterministic update plan is ready.',
      'Zipflow is reviewing the archive with the configured local model. Apply remains unavailable until this operation finishes or is cancelled.',
    ], 'process', {
      collapsible: false,
      collapsedSummary: 'Local LLM · running',
    });
  }
  const llm = report?.llm;
  const runId = report?.runId ?? run?.runId ?? state.run.id;
  applyFailureAnalysis(state, report?.llmFailure, runId);
  applyAutonomyDecision(state, report, runId);
  if (!llm) return;
  state.run.llm = structuredClone(llm);
  if (report.archiveSafety) {
    state.archiveSafety = {
      ...(state.archiveSafety ?? {}),
      ...structuredClone(report.archiveSafety),
    };
  }
  if (llm.assessment) {
    upsertMessage(state, `server-llm:${runId}:assessment`, 'Local LLM archive suitability', [
      `Assessment: ${titleCase(llm.assessment)}`,
      `Confidence: ${titleCase(llm.confidence || 'low')}`,
      ...(report.archiveSafety?.llm?.recommendation
        ? [`Recommended action: ${humanize(report.archiveSafety.llm.recommendation)}`]
        : []),
      ...(llm.reasons?.length ? ['Reasons:', ...llm.reasons.map((reason) => `• ${reason}`)] : []),
    ], llm.assessment === 'suitable' ? 'success' : 'warning', {
      collapsible: false,
      collapsedSummary: `Local LLM · ${llm.assessment} · ${llm.confidence || 'low'} confidence`,
    });
  }
  if (llm.summary?.length) {
    upsertMessage(state, `server-llm:${runId}:summary`, 'Local LLM summary', llm.summary, 'summary', {
      collapsedSummary: `Local LLM · ${llm.summary.length} summary points`,
    });
  }
  if (llm.cancelled) {
    upsertMessage(state, `server-llm:${runId}:cancelled`, 'Local LLM generation cancelled', [
      'The update continues without the cancelled model output.',
    ], 'warning', { collapsedSummary: 'Local LLM · cancelled' });
  } else if (llm.error) {
    upsertMessage(state, `server-llm:${runId}:failed`, 'Requested Local LLM output was not generated', [
      llm.error,
      'The update can continue and project files have not been affected by this error.',
    ], 'warning', { collapsedSummary: 'Local LLM · unavailable' });
  }
}

function applyFailureAnalysis(state, analysis, runId) {
  if (!analysis) return;
  state.run.llmFailure = structuredClone(analysis);
  if (analysis.text) {
    upsertMessage(state, `server-llm-failure:${runId}`, 'Local LLM error explanation',
      analysis.text.split(/\r?\n/), 'warning', {
        collapsible: false,
        collapsedSummary: 'Local LLM · failed-check explanation',
      });
  } else if (analysis.cancelled || analysis.error) {
    upsertMessage(state, `server-llm-failure:${runId}`,
      analysis.cancelled ? 'LLM error explanation cancelled' : 'LLM error explanation unavailable',
      [analysis.cancelled
        ? 'The failed check remains available without an explanation.'
        : analysis.error],
      'warning');
  }
}

function applyAutonomyDecision(state, report, runId) {
  const decision = report?.decisions?.at?.(-1);
  if (decision?.gate && decision?.action) {
    state.run.decisions = structuredClone(report.decisions);
    const confidence = decision.effectiveConfidence ?? decision.confidence;
    upsertMessage(state, `server-autonomy:${runId}:${decision.id ?? report.decisions.length}`, `${
      report.autonomy?.mode === 'full' ? 'Full autopilot' : 'Guarded autopilot'
    } decision`, [
      `Decision: ${humanize(decision.action)}`,
      ...(confidence == null ? [] : [`Confidence: ${confidenceLabel(confidence)}`]),
      ...(decision.summary ? [`Summary: ${decision.summary}`] : []),
      ...(decision.evidence?.length ? ['Evidence:', ...decision.evidence.map((item) => `• ${item}`)] : []),
      ...(decision.risks?.length ? ['Risks:', ...decision.risks.map((item) => `• ${item}`)] : []),
      ...(decision.conditions?.length ? ['Conditions:', ...decision.conditions.map((item) => `• ${item}`)] : []),
    ], ['ask-user', 'abort'].includes(decision.action) ? 'warning' : 'autopilot', {
      collapsible: false,
      collapsedSummary: `Autopilot · ${humanize(decision.action)}`,
    });
  }
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

function titleCase(value) {
  const text = String(value ?? '').trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : 'Unknown';
}

function humanize(value) {
  return titleCase(String(value ?? '').replaceAll('-', ' '));
}

function confidenceLabel(value) {
  const number = Number(value);
  if (number >= 0.8) return 'High';
  if (number >= 0.55) return 'Medium';
  return 'Low';
}
