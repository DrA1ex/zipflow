import { createRecommendedWorkflow } from '../workflow/defaults.js';
import {
  applyProjectSelection, configureWorkspaceProjects, discoverProject, discoverProjectEntry, mergeManualProjects,
  normalizeWorkspaceRelative,
} from '../project/detect.js';
import { displayPath } from '../utils/paths.js';

const MANUAL_TYPES = [
  ['node', 'Node.js'],
  ['python', 'Python'],
  ['cmake', 'CMake · C/C++'],
  ['go', 'Go'],
  ['swift', 'Swift'],
  ['custom', 'Ordinary project'],
];

export function handlesProjectSetupScreen(screen) {
  return ['setup-project', 'project-entry-path', 'setup-project-confirm', 'setup-project-type'].includes(screen);
}

export async function hydrateConfiguredProjects(controller) {
  const { state } = controller;
  const configured = state.workflow?.projects ?? [];
  if (!configured.length || !state.project) return;
  state.project = await configureWorkspaceProjects(state.project, configured);
}

export function showProjectStructureStep(controller) {
  const { project } = controller.state;
  ensureProjectEntries(project);
  const entries = project.projects;
  const detectedCount = entries.filter((entry) => entry.detected).length;
  const selectedCount = entries.filter((entry) => entry.selected !== false).length;
  const singleRootProject = entries.length === 1 && entries[0].path === '.';
  const items = singleRootProject
    ? [{
        id: 'project-summary',
        label: projectPathLabel(entries[0].path),
        description: projectEntryDescription(entries[0]),
        disabled: true,
      }]
    : entries.map((entry, index) => ({
        id: `project-toggle:${index}`,
        label: `${entry.selected !== false ? '[x]' : '[ ]'} ${projectPathLabel(entry.path)}`,
        description: projectEntryDescription(entry),
        disabled: entry.missing,
      }));

  if (singleRootProject) {
    items.push({
      id: 'use-project',
      label: entries[0].detected ? 'Use this project' : 'Use as an ordinary workspace',
      description: `${displayPath(project.root)} · ${projectEntryDescription(entries[0])}`,
    });
  } else {
    items.push({
      id: 'use-selected-projects',
      label: 'Use selected projects',
      description: `${selectedCount} project${selectedCount === 1 ? '' : 's'} selected`,
      disabled: selectedCount === 0,
    });
    if (entries.some((entry) => entry.path === '.')) items.push({
      id: 'use-root-only',
      label: 'Use only the workspace root',
      description: 'Ignore detected subprojects when suggesting commands.',
    });
  }
  items.push(
    { id: 'add-project', label: 'Add project manually', description: 'Enter a relative directory with path completion.' },
    { id: 'rescan-projects', label: 'Rescan project structure', description: 'Scan the workspace root and one directory level again.' },
    { id: 'choose-project', label: 'Choose another workspace', description: 'Select a different root directory.' },
  );

  const intro = projectStructureIntro(project, detectedCount);
  controller.showMenu('setup-project', items, 'Project structure', null, intro);
}

export async function activateProjectStructure(controller, itemId, onContinue) {
  const { state } = controller;
  if (itemId.startsWith('project-toggle:')) {
    const index = Number(itemId.slice(15));
    const entry = state.project.projects?.[index];
    if (!entry || entry.missing) return;
    entry.selected = entry.selected === false;
    syncDraftProjects(controller);
    return showProjectStructureStep(controller);
  }
  if (itemId === 'use-root-only') {
    for (const entry of state.project.projects ?? []) entry.selected = entry.path === '.';
    syncDraftProjects(controller);
    return onContinue();
  }
  if (itemId === 'use-project' || itemId === 'use-selected-projects') {
    if (itemId === 'use-project') {
      const rootEntry = state.project.projects?.find((entry) => entry.path === '.');
      if (rootEntry) rootEntry.selected = true;
    }
    syncDraftProjects(controller);
    return onContinue();
  }
  if (itemId === 'add-project') return showProjectPathEditor(controller);
  if (itemId === 'rescan-projects') return rescanProjects(controller);
  return false;
}

export async function submitProjectSetupEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'setup-project-entry-path') return false;
  const raw = String(controller.state.editor.value ?? '').trim();
  if (!raw) {
    controller.setStatus('Enter a project path relative to the workspace root.');
    return true;
  }
  let relative;
  try {
    relative = normalizeWorkspaceRelative(raw);
  } catch (error) {
    controller.message('Invalid project path', [error.message], 'error');
    return true;
  }
  if ((controller.state.project.projects ?? []).some((entry) => entry.path === relative)) {
    controller.setStatus(`${projectPathLabel(relative)} is already in the project list.`);
    return true;
  }
  try {
    controller.state.pendingProjectEntry = await discoverProjectEntry(controller.state.project.root, relative, {
      source: 'manual', includeUnknown: true,
    });
    showProjectConfirm(controller);
  } catch (error) {
    controller.message('Could not add this project', [error.message], 'error');
  }
  return true;
}

export function activateProjectConfirm(controller, itemId) {
  if (itemId === 'project-confirm-add') return addPendingProject(controller);
  if (itemId === 'project-confirm-type') return showProjectTypeMenu(controller);
  if (itemId === 'project-confirm-change') return showProjectPathEditor(controller, controller.state.pendingProjectEntry?.path ?? '');
  if (itemId === 'project-confirm-cancel') {
    controller.state.pendingProjectEntry = null;
    return showProjectStructureStep(controller);
  }
  if (itemId.startsWith('project-type:')) {
    const type = itemId.slice(13);
    return applyManualProjectType(controller, type);
  }
}

export function backProjectSetup(controller) {
  const screen = controller.state.screen;
  if (screen === 'project-entry-path' || screen === 'setup-project-confirm' || screen === 'setup-project-type') {
    controller.state.pendingProjectEntry = null;
    showProjectStructureStep(controller);
    return true;
  }
  return false;
}

export function syncDraftProjects(controller) {
  const { state } = controller;
  ensureProjectEntries(state.project);
  const selectedPaths = state.project.projects.filter((entry) => entry.selected !== false).map((entry) => entry.path);
  state.project = applyProjectSelection(state.project, selectedPaths);
  const recommended = createRecommendedWorkflow(state.project);
  if (!state.draft) {
    state.draft = recommended;
    return;
  }
  const previousChecks = new Map((state.draft.checks ?? []).map((check) => [check.id, check]));
  const customChecks = (state.draft.checks ?? []).filter((check) => check.custom);
  state.draft.projectTypes = recommended.projectTypes;
  state.draft.projectLabels = recommended.projectLabels;
  state.draft.projects = recommended.projects;
  state.draft.checks = [
    ...recommended.checks.map((check) => ({
      ...check,
      selected: previousChecks.has(check.id) ? previousChecks.get(check.id).selected : check.selected,
    })),
    ...customChecks.filter((check) => !recommended.checks.some((candidate) => candidate.id === check.id)),
  ];
}


function ensureProjectEntries(project) {
  if (Array.isArray(project.projects) && project.projects.length) return project.projects;
  const entry = {
    path: '.',
    root: project.root,
    source: 'detected',
    manual: false,
    detected: Boolean(project.technologies?.length),
    technologies: project.technologies ?? [],
    labels: project.labels ?? [],
    checks: project.checks ?? [],
    scripts: project.scripts ?? [],
    deployCandidates: project.deployCandidates ?? [],
    notes: project.notes ?? [],
    name: project.name,
    markerFiles: [],
    selected: true,
  };
  project.rootEntry = entry;
  project.projects = [entry];
  project.activeProjects = [entry];
  project.workspaceTechnologies = project.technologies ?? [];
  project.workspaceLabels = project.labels ?? [];
  return project.projects;
}

function showProjectPathEditor(controller, value = '') {
  controller.showEditor('project-entry-path', {
    label: 'Relative project path',
    placeholder: 'web/ or packages/client/',
    purpose: 'setup-project-entry-path',
    instructions: [
      'Enter a directory relative to the workspace root.',
      'Tab completes directories. Automatic scanning is one level deep, but manual paths may be deeper.',
    ],
  }, value);
}

function showProjectConfirm(controller) {
  const entry = controller.state.pendingProjectEntry;
  const detected = entry?.labels?.length > 0;
  controller.showMenu('setup-project-confirm', [
    {
      id: 'project-confirm-add',
      label: detected ? `Add as ${entry.labels.join(' · ')}` : 'Add as an ordinary project',
      description: markerDescription(entry),
    },
    { id: 'project-confirm-type', label: 'Choose project type manually', description: 'Use a type label even when standard marker files were not found.' },
    { id: 'project-confirm-change', label: 'Change path', description: projectPathLabel(entry.path) },
    { id: 'project-confirm-cancel', label: 'Cancel' },
  ], `Add project: ${projectPathLabel(entry.path)}`, 0, [
    detected ? `Detected: ${entry.labels.join(' · ')}` : 'The project type was not detected automatically.',
  ]);
}

function showProjectTypeMenu(controller) {
  const entry = controller.state.pendingProjectEntry;
  controller.showMenu('setup-project-type', MANUAL_TYPES.map(([id, label]) => ({
    id: `project-type:${id}`,
    label,
    description: id === 'custom' ? 'Keep the directory without technology-specific command suggestions.' : 'Assign this type manually. Marker-based commands are not invented.',
  })), `Project type: ${projectPathLabel(entry?.path ?? '.')}`);
}

async function applyManualProjectType(controller, type) {
  const pending = controller.state.pendingProjectEntry;
  if (!pending) return showProjectStructureStep(controller);
  controller.state.pendingProjectEntry = await discoverProjectEntry(controller.state.project.root, pending.path, {
    source: 'manual', includeUnknown: true, manualType: type,
  });
  return addPendingProject(controller);
}

function addPendingProject(controller) {
  const entry = controller.state.pendingProjectEntry;
  if (!entry) return showProjectStructureStep(controller);
  entry.selected = true;
  controller.state.project = mergeManualProjects(controller.state.project, [entry]);
  controller.state.pendingProjectEntry = null;
  syncDraftProjects(controller);
  controller.message('Project added', [projectPathLabel(entry.path), projectEntryDescription(entry)], 'success');
  showProjectStructureStep(controller);
}

async function rescanProjects(controller) {
  const { state } = controller;
  const previousPaths = new Set((state.project.projects ?? []).map((entry) => entry.path));
  const manual = (state.project.projects ?? []).filter((entry) => entry.source === 'manual');
  const selected = new Set((state.project.projects ?? []).filter((entry) => entry.selected !== false).map((entry) => entry.path));
  try {
    let rescanned = await discoverProject(state.project.root);
    rescanned = mergeManualProjects(rescanned, manual);
    for (const entry of rescanned.projects) {
      entry.selected = selected.has(entry.path) || !previousPaths.has(entry.path) || entry.source === 'manual';
    }
    state.project = rescanned;
    syncDraftProjects(controller);
    controller.message('Project structure rescanned', [projectStructureSummary(state.project)], 'success');
    showProjectStructureStep(controller);
  } catch (error) {
    controller.message('Project scan failed', [error.message], 'error');
  }
}

function projectStructureIntro(project, detectedCount) {
  if (detectedCount > 1) return [
    `Zipflow found ${detectedCount} projects in this workspace.`,
    'Selected projects contribute suggested checks and deployment commands. Git history and archive operations still use one workspace root.',
  ];
  if (detectedCount === 1) return [
    'Zipflow found one project. You can use it directly or add another project directory manually.',
  ];
  return [
    'No known project type was found. Use the workspace as an ordinary directory or add project directories manually.',
  ];
}

function projectEntryDescription(entry) {
  if (entry.missing) return `${entry.labels?.join(' · ') || 'Configured project'} · directory missing`;
  return entry.labels?.join(' · ') || 'Ordinary project';
}

function markerDescription(entry) {
  const markers = entry.markerFiles ?? [];
  return markers.length ? `Detected from ${markers.slice(0, 3).join(', ')}` : 'No standard project markers were found.';
}

function projectPathLabel(relative) {
  return relative === '.' ? 'Workspace root' : `${relative}/`;
}

function projectStructureSummary(project) {
  return (project.projects ?? []).filter((entry) => entry.selected !== false)
    .map((entry) => `${projectPathLabel(entry.path)} · ${projectEntryDescription(entry)}`).join('\n');
}
