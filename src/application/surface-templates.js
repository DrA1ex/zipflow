import { SECTION_KINDS, SURFACE_KINDS } from '../protocol/constants.js';

const STAGE_COUNT = 5;

function template(kind, title, summary, stageId, stageIndex, sections, actions) {
  return Object.freeze({
    kind,
    'title': title,
    summary,
    stage: Object.freeze({ id: stageId, index: stageIndex, count: STAGE_COUNT }),
    sections: Object.freeze(sections),
    actions: Object.freeze(actions),
  });
}

const templates = [
  template('project_home', 'Project', 'Project workflow and recent run status.', 'workflow', 1,
    ['summary_fields'], []),
  template('workflow_setup', 'Workflow setup', 'Configure how Zipflow checks, commits, and deploys changes.', 'workflow', 1,
    ['text', 'choice_list'], ['save-workflow']),
  template('archive_inspecting', 'Inspecting archive', 'Zipflow is validating and inspecting the uploaded archive.', 'archive', 1,
    ['progress'], ['cancel-operation']),
  template('archive_root_choice', 'Choose archive root', 'Select the directory that represents the project root.', 'archive', 1,
    ['choice_list'], ['select-archive-root']),
  template('archive_safety', 'Archive safety review', 'Review archive findings before planning project changes.', 'plan', 2,
    ['warning_list'], ['acknowledge-archive-safety', 'cancel-run']),
  template('plan_review', 'Review plan', 'Review the semantic change plan before applying it.', 'plan', 2,
    ['plan_summary', 'file_details'], ['use-archive', 'keep-local', 'approve-plan']),
  template('plan_files', 'Plan files', 'Review file groups and per-file decisions.', 'plan', 2,
    ['file_groups', 'file_details'], ['use-archive', 'keep-local', 'approve-plan']),
  template('conflict_summary', 'Resolve conflicts', 'Resolve all plan conflicts before applying changes.', 'plan', 2,
    ['conflict'], ['resolve-conflict', 'approve-plan']),
  template('conflict_file', 'File conflict', 'Choose the intended version for the selected conflict.', 'plan', 2,
    ['conflict', 'file_details'], ['resolve-conflict']),
  template('operation_progress', 'Operation in progress', 'Zipflow is executing a project operation.', 'operation', 3,
    ['progress'], ['cancel-operation']),
  template('checks_failed', 'Checks failed', 'One or more configured validation checks failed.', 'checks', 3,
    ['check_results', 'error'], ['retry-checks', 'keep-changes', 'rollback']),
  template('commit_choice', 'Commit changes', 'Choose whether to create a Git commit.', 'commit', 4,
    ['commit'], ['commit', 'prepare-commit', 'continue-without-commit']),
  template('commit_message', 'Commit message', 'Provide the message for the Git commit.', 'commit', 4,
    ['commit'], ['commit']),
  template('deploy_choice', 'Deploy changes', 'Choose whether to run the configured deployment workflow.', 'deploy', 5,
    ['deployment'], ['deploy', 'skip-deploy']),
  template('completed', 'Run completed', 'The Zipflow run completed.', 'complete', 5,
    ['summary_fields'], ['finish', 'rollback']),
  template('history', 'Run history', 'Review previous Zipflow runs for this project.', 'history', 5,
    ['history_rows'], []),
  template('run_details', 'Run details', 'Review the outcome and recorded files for this run.', 'history', 5,
    ['summary_fields', 'file_details'], ['rollback']),
  template('rollback_confirm', 'Confirm rollback', 'Review the restore point before rolling back the project.', 'rollback', 5,
    ['warning_list'], ['rollback', 'finish']),
  template('error', 'Zipflow error', 'Zipflow cannot continue the current step.', 'error', 5,
    ['error'], ['retry-run', 'dismiss-error']),
];

export const SURFACE_TEMPLATES = Object.freeze(Object.fromEntries(
  templates.map((entry) => [entry.kind, entry]),
));

const templateKinds = Object.keys(SURFACE_TEMPLATES);
if (templateKinds.length !== SURFACE_KINDS.length
  || SURFACE_KINDS.some((kind) => !SURFACE_TEMPLATES[kind])) {
  throw new Error('Every protocol surface kind must have an application template.');
}

const representedSectionKinds = new Set(templates.flatMap(({ sections }) => sections));
if (SECTION_KINDS.some((kind) => !representedSectionKinds.has(kind))) {
  throw new Error('Every protocol section kind must be represented by a surface template.');
}
