import path from 'node:path';
import { LLM_LANGUAGES, THEME_NAMES } from '../settings/store.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';
import { modelConfigSummary } from './settings-model.js';
import { modelTestDescription, modelTestValue } from './settings-model-check.js';
import { translateForState as t } from '../i18n/index.js';
import { hasLlmPatchDeliveryTasks, llmTasks } from '../llm/tasks.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { BINARY_TOOL_IDS, binaryDefinition, configuredBinaryPath } from '../security/binaries.js';
import { environmentPolicyLabel } from '../security/environment.js';

export function settingsDefinitions(state) {
  const definitions = [
    { id: 'language', label: 'Language', description: 'Choose the language used by Zipflow itself. Custom JSON language packs are loaded from ~/.zipflow/languages.', directParameterId: 'interfaceLanguage' },
    { id: 'theme', label: 'Theme', description: '', directParameterId: 'theme' },
    { id: 'updates', label: 'Updates', description: 'Control background update checks and query the latest published npm version.' },
    { id: 'checkOutput', label: 'Running checks', description: '', directParameterId: 'checkOutput' },
    { id: 'binaries', label: 'Binaries', description: 'Validated absolute executables used by trusted Zipflow operations.' },
    { id: 'commandEnvironment', label: 'Project command environment', description: 'Choose environment inheritance separately for checks and deployments.' },
    { id: 'localLlm', label: 'Local LLM', description: 'Provider, model, languages, review behavior, and authentication.' },
    { id: 'sourceArchive', label: 'Source archives', description: 'Retention and storage for completed source ZIPs.' },
    { id: 'backups', label: 'Backups', description: 'Retention and storage for rollback backups.' },
  ];
  if (state.project) definitions.push({
    id: 'managedHistory',
    label: 'Managed-file history',
    description: 'Control whether successful updates record managed paths and inspect the current project history.',
  });
  return definitions;
}

export function settingsParameters(state, definition) {
  if (definition.id === 'language') return [choiceParameter('interfaceLanguage', 'Interface language', interfaceLanguageLabel(state), 'Choose the language used by Zipflow itself. Custom JSON language packs are loaded from ~/.zipflow/languages.')];
  if (definition.id === 'theme') return [choiceParameter('theme', 'Theme', titleCase(state.settings.theme), '')];
  if (definition.id === 'updates') return updateParameters(state);
  if (definition.id === 'checkOutput') return [choiceParameter(
    'checkOutput', 'Output while running', outputLabel(state.settings.checkOutput),
    'Compact shows status only; last-line also shows the latest command output line.',
  )];
  if (definition.id === 'binaries') return binaryParameters(state);
  if (definition.id === 'commandEnvironment') return [
    choiceParameter(
      'checkCommandEnvironment', 'Checks', environmentPolicyLabel(state.settings.checkCommandEnvironment),
      'Sanitized is the safe default for tests and validation. Full inheritance remains available for projects that require additional variables.',
    ),
    choiceParameter(
      'deployCommandEnvironment', 'Deployments', environmentPolicyLabel(state.settings.deployCommandEnvironment),
      'Full inheritance is the practical default for deployment credentials and agent sockets. Sanitized remains available when deployment does not need them.',
    ),
  ];
  if (definition.id === 'localLlm') {
    if (state.settingsPanel?.subpage === 'llmTasks') return llmTaskParameters(state);
    if (state.settingsPanel?.subpage === 'llmLanguages') return llmLanguageParameters(state);
    if (state.settingsPanel?.subpage === 'llmModelTests') return llmModelTestParameters(state);
    if (state.settingsPanel?.subpage === 'llmModelReplay') return llmModelReplayParameters(state);
    if (state.settingsPanel?.subpage === 'llmAutopilotReplay') return llmAutopilotReplayParameters(state);
    return localLlmParameters(state);
  }
  if (definition.id === 'sourceArchive') return sourceArchiveParameters(state);
  if (definition.id === 'backups') return backupParameters(state);
  if (definition.id === 'managedHistory') return managedHistoryParameters(state);
  return [];
}


function binaryParameters(state) {
  const loading = Boolean(state.settingsPanel?.loadingBinaries);
  const parameters = BINARY_TOOL_IDS.map((binaryId) => {
    const definition = binaryDefinition(binaryId);
    const status = state.settingsPanel?.binaries?.[binaryId];
    const mode = status?.mode === 'manual' ? 'Manual' : 'Automatic';
    const marker = loading && !status ? '…' : status?.valid ? '✓' : '✗';
    const value = `${mode} · ${marker}`;
    const excludedCount = status?.excludedPaths?.length ?? 0;
    const exclusions = excludedCount === 1
      ? '1 project-local PATH entry was excluded from automatic detection.'
      : excludedCount > 1 ? `${excludedCount} project-local PATH entries were excluded from automatic detection.` : '';
    const description = status?.valid
      ? [status.resolvedPath, status.version, status.warning, exclusions].filter(Boolean).join(' · ')
      : [status?.error || 'Open to detect, choose, or reset the executable.', exclusions].filter(Boolean).join(' · ');
    return { id: `binary:${binaryId}`, type: 'choice', binaryId, label: definition.label, value, description };
  });
  parameters.push(actionRow(
    'binary-check-all', loading ? 'Checking all executables…' : 'Check all', '',
    'Validate every configured executable and refresh all status indicators.',
    { action: 'binary-check-all', disabled: loading, loading },
  ));
  return parameters;
}

function binaryChoices(state, parameter) {
  const status = state.settingsPanel?.binaries?.[parameter.binaryId];
  const detected = state.settingsPanel?.detectedBinaries?.[parameter.binaryId];
  const manual = Boolean(configuredBinaryPath(state.settings, parameter.binaryId));
  return [
    {
      id: `binary-use-detected:${parameter.binaryId}`, action: 'binary-use-detected', binaryId: parameter.binaryId,
      label: 'Use detected executable',
      description: detected?.valid ? detected.resolvedPath : detected?.error || 'No validated system executable was detected.',
      disabled: !detected?.valid,
    },
    {
      id: `binary-choose:${parameter.binaryId}`, action: 'binary-choose-path', binaryId: parameter.binaryId,
      label: 'Choose path', description: 'Select and validate any absolute executable path. Manual overrides may deliberately use paths excluded from automatic detection.',
    },
    {
      id: `binary-reset:${parameter.binaryId}`, action: 'binary-reset-auto', binaryId: parameter.binaryId,
      label: 'Reset to automatic detection', description: detected?.resolvedPath || 'Remove the manual override and search PATH while excluding executables inside the current project.',
      disabled: !manual,
    },
  ];
}

function updateParameters(state) {
  const checking = Boolean(state.settingsPanel?.updateChecking);
  return [
    toggleParameter('checkForUpdatesOnStartup', 'Check automatically', state.settings.checkForUpdatesOnStartup,
      'Check the official npm registry in the background when Zipflow starts.'),
    actionRow('checkUpdatesNow', checking ? 'Checking for updates…' : 'Check now', updateCheckValue(state),
      'Query the official npm registry and show the latest published Zipflow version.', {
        action: 'update-check-now', disabled: checking, loading: checking,
      }),
  ];
}

function updateCheckValue(state) {
  const result = state.updateCheck;
  if (result?.status === 'available') return t(state, '{version} available', { version: result.latestVersion });
  if (result?.status === 'current') return t(state, 'Latest {version}', { version: result.latestVersion });
  if (result?.status === 'unavailable') return t(state, 'Last check failed');
  return t(state, 'Not checked');
}

export function settingsChoices(state, parameter) {
  if (parameter.settingId === 'interfaceLanguage') {
    const languages = state.i18n?.available ?? [];
    return [
      option(parameter, 'system', 'System language', 'Use the operating-system language when a matching pack is installed; otherwise use English.'),
      ...languages.map((language) => option(parameter, language.id, language.nativeName, `${language.name} · ${language.locale}${language.builtin ? '' : ' · custom'}`)),
      {
        id: 'refresh-languages', action: 'refresh-languages', label: 'Refresh languages',
        description: `Reload custom JSON language packs from ${state.i18n?.directory ?? '~/.zipflow/languages'}.`,
      },
    ];
  }
  if (parameter.settingId === 'theme') return THEME_NAMES.map((value) => option(parameter, value, titleCase(value)));
  if (parameter.settingId === 'checkOutput') return [
    option(parameter, 'compact', 'Compact', 'Show check state and duration only.'),
    option(parameter, 'last-line', 'Last output line', 'Also show the latest non-empty output line.'),
  ];
  if (['checkCommandEnvironment', 'deployCommandEnvironment'].includes(parameter.settingId)) return [
    option(parameter, 'sanitized', 'Sanitized environment', 'Pass normal paths, locale, terminal, home, and platform variables while removing secret-like variables and agent sockets.'),
    option(parameter, 'inherit', 'Full inherited environment', 'Pass every environment variable inherited by Zipflow. Use only for project commands that explicitly require it.'),
  ];
  if (parameter.binaryId) return binaryChoices(state, parameter);
  if (parameter.settingId === 'llmProvider') return [
    option(parameter, 'disabled', 'Disabled', 'Do not contact a local LLM server.'),
    option(parameter, 'ollama', 'Ollama', 'Local server at 127.0.0.1:11434.'),
    option(parameter, 'lmstudio', 'LM Studio', 'Native API at 127.0.0.1:1234/api/v1.'),
  ];
  if (parameter.settingId === 'llmModel') return modelChoices(state, parameter);
  if (['llmPromptLanguage', 'llmSummaryLanguage', 'llmCommitLanguage'].includes(parameter.settingId)) {
    return LLM_LANGUAGES.map((value) => option(parameter, value, value));
  }
  if (parameter.settingId === 'llmArchiveReview') return [
    option(parameter, 'structure', 'Structure guard', 'Compare the project and archive trees before other requested LLM outputs.'),
    option(parameter, 'sample', 'Sample guard', 'Check project/archive structure and representative patch excerpts from up to five priority files.'),
    option(parameter, 'patch', 'Deep patch review', 'Assess archive suitability from the delivered change representation.'),
  ];
  if (parameter.settingId === 'llmChangeDelivery') return [
    option(parameter, 'adaptive', 'Adaptive', 'Use a full patch when it fits, a representative sample for medium changes, and capped batches for large changes.'),
    option(parameter, 'patch', 'Full patch', 'Send one context-budgeted changes.patch request.'),
    option(parameter, 'representative', 'Representative sample', 'Send the full changed-path manifest and representative patches from up to eight priority files.'),
    option(parameter, 'capped', 'Capped batches', 'Analyze at most three priority batches and twelve files, then synthesize one result.'),
    option(parameter, 'change-list', 'Changed paths only', 'Send created, updated, and deleted file paths without file contents.'),
    option(parameter, 'chunked', 'File-by-file chunks', 'Analyze small groups of file patches, then synthesize one final answer.'),
  ];
  if (parameter.settingId === 'llmFailureAnalysis') return [
    option(parameter, 'same-context', 'Continue change context', 'Explain the failure using the previous change analysis as context when one exists.'),
    option(parameter, 'new-context', 'New context', 'Explain only the failed command and its output in a fresh request.'),
  ];
  if (parameter.settingId === 'llmVerboseOutput') return [
    option(parameter, false, 'Hide raw responses', 'Show streamed model output only while generation is active, then keep only Zipflow’s parsed result.'),
    option(parameter, true, 'Keep raw responses', 'Keep each completed raw model response as a collapsed Activity block before the parsed result.'),
  ];
  if (parameter.settingId === 'backupRetentionPolicy') return [
    option(parameter, 'all', 'Keep all backups', 'Never remove backups automatically. Manual Clear now remains available.'),
    option(parameter, 'limits', 'Keep backups within limits', 'Remove oldest backups after successful runs when age or total-size limits are exceeded.'),
  ];
  if (parameter.settingId === 'managedHistoryPolicy') return [
    option(parameter, 'record', 'Keep recording managed files', 'Successful archive updates add created and updated paths to managed-file history.'),
    {
      ...option(parameter, 'disabled', 'Do not record managed files', 'Keep existing history but stop updating it after future runs.'),
      disabled: state.workflow?.deletion?.scope === 'managed-history',
      disabledReason: 'The active workflow uses managed-file history for snapshot deletion. Change that workflow policy first.',
    },
  ];
  if (parameter.settingId === 'archivePolicy') return [
    option(parameter, 'keep', 'Do nothing', 'Leave the ZIP in its original location.'),
    option(parameter, 'move', 'Move to archive storage', 'Move the ZIP and enforce retention and size limits.'),
    option(parameter, 'delete', 'Delete source ZIP', 'Delete the uploaded ZIP after the update is completed.'),
  ];
  if (parameter.id === 'archiveStorageClear') return clearChoices('archive-storage',
    `Delete ${state.settingsPanel?.storageStats?.archives?.count ?? 0} Zipflow-managed source archives.`);
  if (parameter.id === 'backupStorageClear') return clearChoices('backup-storage',
    `Delete ${state.settingsPanel?.storageStats?.backups?.count ?? 0} backups. Rollback will become unavailable for affected runs.`);
  if (parameter.id === 'managedHistoryClear') return clearChoices('managed-history',
    `Forget ${state.settingsPanel?.managedHistory?.paths?.length ?? 0} recorded paths for this project.`);
  return [];
}

export function settingsPageTitle(state, definition) {
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmTasks') return 'LLM tasks';
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmLanguages') return 'LLM languages';
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmModelTests') return 'Model tests';
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmModelReplay') {
    return state.settingsPanel?.modelTestWorkspace ? 'Model tests' : 'Historical model replay';
  }
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmAutopilotReplay') {
    return state.settingsPanel?.modelTestWorkspace ? 'Model tests' : 'Historical autopilot simulation';
  }
  return definition.label;
}

export function settingsFieldDefinition(fieldId) {
  if (fieldId.startsWith('binaryPath:')) {
    const binaryId = fieldId.slice('binaryPath:'.length);
    const definition = binaryDefinition(binaryId);
    return {
      id: fieldId, binaryId, label: `${definition.label} path`,
      description: `Absolute executable path used for ${definition.label}.`,
      placeholder: '/absolute/path/to/executable',
      instructions: ['Tab completes files and directories. Shift+Tab moves to the parent directory.', 'The selected real path must be a regular executable file and pass its validation probe.'],
      path: true, directoriesOnly: false,
    };
  }
  return FIELD_DEFINITIONS[fieldId] ?? null;
}

export function settingsEditorValue(state, fieldId) {
  if (fieldId.startsWith('binaryPath:')) return configuredBinaryPath(state.settings, fieldId.slice('binaryPath:'.length));
  if (fieldId === 'llmApiToken') return '';
  if (['archiveMaxBytes', 'backupMaxBytes'].includes(fieldId)) return formatByteSize(state.settings[fieldId]).replace(/\s+/g, '');
  return String(state.settings[fieldId] ?? '');
}

function localLlmParameters(state) {
  const disabled = state.settings.llmProvider === 'disabled';
  const models = state.settingsPanel?.models ?? [];
  const selected = models.find((item) => item.id === state.settings.llmModel || item.key === state.settings.llmModel);
  const tasks = llmTasks(state.settings);
  const changeTasksDisabled = !hasLlmPatchDeliveryTasks(state.settings);
  return [
    choiceParameter('llmProvider', 'Provider', providerLabel(state.settings.llmProvider), 'Choose the local server Zipflow should contact.'),
    {
      ...choiceParameter('llmModel', 'Model', selected ? modelDisplayLabel(selected) : (state.settings.llmModel || 'Not selected'), ''),
      disabled,
      disabledReason: 'Enable Ollama or LM Studio first.',
    },
    {
      id: 'llmTasks', type: 'subpage', label: 'LLM tasks',
      value: llmTasksSummary(state.settings),
      description: 'Choose which results Zipflow should request from the local model.',
      disabled, disabledReason: 'Enable a local LLM provider first.',
    },
    {
      id: 'llmLanguages', type: 'subpage', label: 'Languages',
      value: languageSummary(state.settings),
      description: 'Configure the language of model instructions, summaries, and generated commit messages independently.',
      disabled, disabledReason: 'Enable a local LLM provider first.',
    },
    {
      ...choiceParameter('llmArchiveReview', 'Archive review method', archiveReviewLabel(state.settings.llmArchiveReview), 'Choose how archive suitability is assessed when that LLM task is enabled.'),
      disabled: disabled || !tasks.archiveReview,
      disabledReason: disabled ? 'Enable a local LLM provider first.' : 'Enable Archive suitability review in LLM tasks first.',
    },
    {
      ...choiceParameter('llmChangeDelivery', 'Change delivery', changeDeliveryLabel(state.settings.llmChangeDelivery), 'Choose how source changes are represented and budgeted for archive review, summaries, and commit messages.'),
      disabled: disabled || changeTasksDisabled,
      disabledReason: disabled ? 'Enable a local LLM provider first.' : 'Enable at least one change-analysis task first.',
    },
    {
      ...choiceParameter('llmFailureAnalysis', 'Failed-check context', failureAnalysisLabel(state.settings.llmFailureAnalysis), 'Choose whether failed checks reuse previous change context or start a fresh request.'),
      disabled: disabled || !tasks.failedChecks,
      disabledReason: disabled ? 'Enable a local LLM provider first.' : 'Enable Failed-check explanations in LLM tasks first.',
    },
    {
      ...choiceParameter('llmVerboseOutput', 'Raw model responses', verboseOutputLabel(state.settings.llmVerboseOutput), 'Control whether completed raw model output remains in Activity after Zipflow parses it.'),
      disabled,
      disabledReason: 'Enable a local LLM provider first.',
    },
    {
      id: 'llmApiToken', type: 'input', fieldId: 'llmApiToken', label: 'Authentication',
      value: state.settings.llmApiToken ? 'Bearer token configured' : 'Not configured',
      description: 'Optional API token for model discovery and generation.',
    },
    {
      id: 'llmModelTests', type: 'subpage', label: 'Test selected model',
      value: modelTestValue(state.settingsPanel),
      description: modelTestDescription(state.settingsPanel),
      disabled: disabled || !state.settings.llmModel,
      blocked: Boolean(state.settingsPanel?.modelTest?.running),
      loading: Boolean(state.settingsPanel?.modelTest?.running),
      disabledReason: disabled
        ? 'Enable a local LLM provider first.'
        : !state.settings.llmModel ? 'Choose a model first.' : 'The selected model test is already running.',
    },
  ];
}

function llmTaskParameters(state) {
  const tasks = llmTasks(state.settings);
  return [
    toggleParameter('llmUseArchiveReview', 'Archive suitability review', tasks.archiveReview,
      'Ask the model whether the archive changes plausibly belong to this workspace. Deterministic Zipflow checks remain authoritative.'),
    toggleParameter('llmUseSummary', 'Change summary', tasks.summary,
      'Generate a concise human-readable summary of the applied source changes.'),
    toggleParameter('llmUseFailedChecks', 'Failed-check explanations', tasks.failedChecks,
      'Offer a model explanation when a configured check fails.'),
    toggleParameter('llmUseCommitMessage', 'Update commit message', tasks.commitMessage,
      'Generate a Git commit-message candidate for the archive update without requiring any other LLM output.'),
    toggleParameter('llmUseDirtyTreeCommitMessage', 'Dirty-tree checkpoint message', tasks.dirtyTreeCommitMessage,
      'Generate the Git checkpoint message from the current uncommitted tracked changes before Zipflow applies an archive.'),
    { id: 'llmTasksBack', type: 'action', action: 'subpage-back', label: 'Back to Local LLM', value: '',
      description: 'Return to the Local LLM settings page.' },
  ];
}

function llmTasksSummary(settings) {
  const tasks = llmTasks(settings);
  const labels = [
    tasks.archiveReview ? 'Archive review' : null,
    tasks.summary ? 'Summary' : null,
    tasks.failedChecks ? 'Failed checks' : null,
    tasks.commitMessage ? 'Update commit' : null,
    tasks.dirtyTreeCommitMessage ? 'Dirty-tree commit' : null,
  ].filter(Boolean);
  return labels.length ? labels.join(' · ') : 'None selected';
}

function llmLanguageParameters(state) {
  return [
    choiceParameter('llmPromptLanguage', 'Prompt language', state.settings.llmPromptLanguage,
      'Language used for model-facing instructions. Structured protocol names remain stable.'),
    choiceParameter('llmSummaryLanguage', 'Summary language', state.settings.llmSummaryLanguage,
      'Language used for change summaries, suitability reasons, and failed-check explanations.'),
    choiceParameter('llmCommitLanguage', 'Commit message language', state.settings.llmCommitLanguage,
      'Language used only for the generated Git commit message.'),
    { id: 'llmLanguagesBack', type: 'action', action: 'subpage-back', label: 'Back to Local LLM', value: '',
      description: 'Return to the Local LLM settings page.' },
  ];
}

function languageSummary(settings) {
  return `Prompt ${settings.llmPromptLanguage} · Summary ${settings.llmSummaryLanguage} · Commit ${settings.llmCommitLanguage}`;
}

function llmModelTestParameters(state) {
  const running = Boolean(state.settingsPanel?.modelTest?.running || state.settingsPanel?.modelTestWorkspace?.running);
  return [
    { id: 'modelTestConnection', type: 'action', action: 'model-test-connection',
      label: running && state.settingsPanel?.modelTest?.running ? 'Testing connection…' : 'Connection and compatibility test',
      value: modelTestValue(state.settingsPanel),
      description: modelTestDescription(state.settingsPanel), blocked: running, loading: running && Boolean(state.settingsPanel?.modelTest?.running) },
    { id: 'modelTestReplay', type: 'action', action: 'model-test-replay',
      label: 'Replay a historical update', value: '',
      description: 'Run the current LLM rules against a stored historical patch without changing project files.', blocked: running },
    { id: 'modelTestAutopilot', type: 'action', action: 'model-test-autopilot',
      label: 'Simulate autopilot from history', value: '',
      description: 'Compare Guarded and Full autopilot decisions on a stored run without changing the project.', blocked: running },
    { id: 'llmModelTestsBack', type: 'action', action: 'subpage-back', label: 'Back to Local LLM', value: '',
      description: 'Return to the Local LLM settings page.', blocked: running },
  ];
}

function llmModelReplayParameters(state) {
  const runs = state.settingsPanel?.replayRuns ?? [];
  const items = runs.map((run) => ({
    id: `modelReplay:${run.id}`, type: 'action', action: 'model-replay-run', runId: run.id,
    label: `${archiveName(run.archivePath)} · ${shortDate(run.createdAt)}`,
    value: run.plan?.counts ? `${run.plan.counts.created} added · ${run.plan.counts.updated} changed · ${run.plan.counts.deleted} removed` : '',
    description: run.replayAvailable
      ? `Replay stored changes.patch from run ${run.id}. Project files remain untouched.`
      : 'The stored patch is unavailable, so this run cannot be replayed.',
    disabled: !run.replayAvailable,
  }));
  if (!items.length) items.push({
    id: 'modelReplayEmpty', type: 'action', label: 'No replayable archive updates', value: '',
    description: 'Complete an archive update with a stored patch before using historical replay.', disabled: true,
  });
  items.push({ id: 'modelReplayBack', type: 'action', action: 'model-replay-back', label: 'Back to model tests', value: '',
    description: 'Return to test options.' });
  return items;
}


function llmAutopilotReplayParameters(state) {
  const runs = state.settingsPanel?.autopilotReplayRuns ?? [];
  const items = runs.map((run) => ({
    id: `autopilotReplay:${run.id}`, type: 'action', action: 'autopilot-replay-run', runId: run.id,
    label: `${archiveName(run.archivePath)} · ${shortDate(run.createdAt)}`,
    value: run.plan?.counts ? `${run.plan.counts.created} added · ${run.plan.counts.updated} changed · ${run.plan.counts.deleted} removed` : '',
    description: run.autopilotReplayAvailable
      ? `Compare Guarded and Full autopilot on decision points reconstructed from run ${run.id}.`
      : 'This run does not contain enough workflow state to reconstruct an autopilot decision.',
    disabled: !run.autopilotReplayAvailable,
  }));
  if (!items.length) items.push({
    id: 'autopilotReplayEmpty', type: 'action', label: 'No historical updates can be simulated', value: '',
    description: 'Complete an archive update before using historical autopilot simulation.', disabled: true,
  });
  items.push({ id: 'autopilotReplayBack', type: 'action', action: 'autopilot-replay-back', label: 'Back to model tests', value: '',
    description: 'Return to test options.' });
  return items;
}

function archiveName(value) {
  return path.basename(String(value || 'archive update'));
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function sourceArchiveParameters(state) {
  const archives = state.settingsPanel?.storageStats?.archives ?? {};
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  const parameters = [
    choiceParameter('archivePolicy', 'Policy', archivePolicyLabel(state.settings.archivePolicy),
      'Choose what Zipflow does with the source ZIP after a completed update.'),
  ];
  if (state.settings.archivePolicy === 'move') parameters.push(
    inputParameter('archiveDirectory', 'Archive directory', displayArchiveDirectory(state.settings.archiveDirectory),
      'Directory where completed source ZIPs are moved.'),
    inputParameter('archiveRetentionDays', 'Retention', `${state.settings.archiveRetentionDays} days`,
      'Maximum archive age; 0 disables age cleanup.'),
    inputParameter('archiveMaxBytes', 'Maximum size', formatByteSize(state.settings.archiveMaxBytes),
      'Combined managed archive size limit; 0 disables size cleanup.'),
  );
  parameters.push(
    actionRow('archiveStorageRefresh', 'Refresh statistics', loading ? 'Scanning…' : '',
      'Re-scan Zipflow-managed source archives.', { action: 'storage-refresh', disabled: loading, loading }),
    { ...choiceParameter('archiveStorageClear', 'Clear now', archives.count ? `${archives.count} files` : 'Empty',
      'Delete only source archives registered in Zipflow’s archive index.'), disabled: loading || !archives.count },
  );
  return parameters;
}

function backupParameters(state) {
  const backups = state.settingsPanel?.storageStats?.backups ?? {};
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  const parameters = [
    choiceParameter('backupRetentionPolicy', 'Retention policy', backupPolicyLabel(state.settings.backupRetentionPolicy),
      'Keep every backup or automatically remove the oldest backups within configured limits.'),
  ];
  if (state.settings.backupRetentionPolicy === 'limits') parameters.push(
    inputParameter('backupRetentionDays', 'Retention', `${state.settings.backupRetentionDays} days`,
      'Maximum backup age; 0 disables age cleanup.'),
    inputParameter('backupMaxBytes', 'Maximum size', formatByteSize(state.settings.backupMaxBytes),
      'Maximum combined backup size; 0 disables size cleanup.'),
  );
  parameters.push(
    actionRow('backupStorageRefresh', 'Refresh statistics', loading ? 'Scanning…' : '',
      'Re-scan rollback backup storage.', { action: 'storage-refresh', disabled: loading, loading }),
    { ...choiceParameter('backupStorageClear', 'Clear now', backups.count ? `${backups.count} backups` : 'Empty',
      'Delete stored rollback backups except the backup belonging to an active run.'), disabled: loading || !backups.count },
  );
  return parameters;
}

function managedHistoryParameters(state) {
  const history = state.settingsPanel?.managedHistory ?? { paths: [], updatedAt: null };
  return [
    choiceParameter('managedHistoryPolicy', 'Recording', managedHistoryPolicyLabel(state.settings.managedHistoryPolicy),
      'Choose whether future successful archive updates update managed-file history.'),
    { ...choiceParameter('managedHistoryClear', 'Clear now', history.paths?.length ? `${history.paths.length} paths` : 'Empty',
      'Forget recorded paths without changing whether future runs are recorded.'),
      disabled: !history.paths?.length,
      disabledReason: '' },
  ];
}


export function settingsPageHelp(state, definition) {
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  if (definition.id === 'updates') {
    const result = state.updateCheck;
    return [
      t(state, 'Update status'),
      t(state, 'Installed version: {version}', { version: result?.currentVersion ?? ZIPFLOW_VERSION }),
      t(state, 'Latest version: {version}', { version: result?.latestVersion ?? 'Not checked' }),
    ];
  }
  if (definition.id === 'binaries') return [
    'Internal calls use resolved absolute paths. Automatic detection excludes paths inside the current project; a manual override can deliberately select one and is shown with a warning.',
  ];
  if (definition.id === 'commandEnvironment') return [
    `Checks: ${environmentPolicyLabel(state.settings.checkCommandEnvironment)}`,
    `Deployments: ${environmentPolicyLabel(state.settings.deployCommandEnvironment)}`,
  ];
  if (definition.id === 'sourceArchive') {
    const archives = state.settingsPanel?.storageStats?.archives ?? {};
    if (loading) return [t(state, 'Storage statistics'), t(state, 'Scanning source archive storage…')];
    return [
      t(state, 'Storage statistics'),
      t(state, 'Archives: {count}', { count: archives.count ?? 0 }),
      t(state, 'Total size: {size}', { size: formatByteSize(archives.totalBytes ?? 0) }),
      t(state, 'Oldest archive: {oldest}', { oldest: dateLabel(state, archives.oldestAt) }),
    ];
  }
  if (definition.id === 'backups') {
    const backups = state.settingsPanel?.storageStats?.backups ?? {};
    if (loading) return [t(state, 'Storage statistics'), t(state, 'Scanning backup storage…')];
    return [
      t(state, 'Storage statistics'),
      t(state, 'Backups: {count}', { count: backups.count ?? 0 }),
      t(state, 'Stored files: {count}', { count: backups.fileCount ?? 0 }),
      t(state, 'Total size: {size}', { size: formatByteSize(backups.totalBytes ?? 0) }),
      t(state, 'Oldest backup: {oldest}', { oldest: dateLabel(state, backups.oldestAt) }),
    ];
  }
  if (definition.id === 'managedHistory') {
    const history = state.settingsPanel?.managedHistory ?? { paths: [], updatedAt: null };
    return [
      t(state, 'Managed-file statistics'),
      t(state, 'Recorded paths: {count}', { count: history.paths?.length ?? 0 }),
      t(state, 'Last updated: {updated}', { updated: dateLabel(state, history.updatedAt) }),
    ];
  }
  return [];
}

export function settingsPageSummary(state, definition) {
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  if (definition.id === 'updates') return [updateCheckValue(state)];
  if (definition.id === 'binaries') return [];
  if (definition.id === 'commandEnvironment') return [
    `Checks: ${environmentPolicyLabel(state.settings.checkCommandEnvironment)}`,
    `Deployments: ${environmentPolicyLabel(state.settings.deployCommandEnvironment)}`,
  ];
  if (definition.id === 'sourceArchive') {
    const archives = state.settingsPanel?.storageStats?.archives ?? {};
    if (loading) return [t(state, 'Scanning source archive storage…')];
    return [t(state, '{count} archives · {size} · oldest {oldest}', {
      count: archives.count ?? 0,
      size: formatByteSize(archives.totalBytes ?? 0),
      oldest: dateLabel(state, archives.oldestAt),
    })];
  }
  if (definition.id === 'backups') {
    const backups = state.settingsPanel?.storageStats?.backups ?? {};
    if (loading) return [t(state, 'Scanning backup storage…')];
    return [t(state, '{count} backups · {files} files · {size} · oldest {oldest}', {
      count: backups.count ?? 0,
      files: backups.fileCount ?? 0,
      size: formatByteSize(backups.totalBytes ?? 0),
      oldest: dateLabel(state, backups.oldestAt),
    })];
  }
  if (definition.id === 'managedHistory') {
    const history = state.settingsPanel?.managedHistory ?? { paths: [], updatedAt: null };
    return [t(state, '{count} recorded paths · last updated {updated}', {
      count: history.paths?.length ?? 0,
      updated: dateLabel(state, history.updatedAt),
    })];
  }
  return [];
}

function toggleParameter(settingId, label, selected, description) {
  return { id: settingId, type: 'toggle', action: 'toggle-setting', settingId, selected, label, value: '', description };
}

function actionRow(id, label, value, description, extra = {}) {
  return { id, type: 'action', label, value, description, ...extra };
}

function clearChoices(kind, description) {
  return [
    { id: `${kind}-clear-cancel`, action: 'clear-cancel', label: 'Back', description: 'Return without deleting anything.' },
    { id: `${kind}-clear-confirm`, action: `${kind}-clear-confirm`, label: 'Clear now', description },
  ];
}

function backupPolicyLabel(value) {
  return value === 'all' ? 'Keep all backups' : 'Keep backups within limits';
}

function managedHistoryPolicyLabel(value) {
  return value === 'disabled' ? 'Do not record managed files' : 'Keep recording managed files';
}

function dateLabel(state, value) {
  if (!value) return t(state, 'None');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t(state, 'Unknown');
  const language = state?.i18n?.available?.find((item) => item.id === state?.i18n?.languageId);
  return date.toLocaleString(language?.locale ?? 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function modelChoices(state, parameter) {
  const panel = state.settingsPanel;
  const result = [{
    id: 'refresh-models', action: 'refresh-models', label: 'Refresh available models',
    description: panel?.modelError ?? '',
    loading: Boolean(panel?.loadingModels),
    disabled: false,
  }];
  if (panel?.models?.length) {
    result.push(...panel.models.map((model) => ({
      id: `${parameter.settingId}:${model.id}`,
      action: state.settings.llmProvider === 'lmstudio' ? 'configure-model' : null,
      model,
      settingId: state.settings.llmProvider === 'lmstudio' ? null : parameter.settingId,
      value: model.id,
      label: modelChoiceLabel(model),
      description: modelChoiceDescription(state, model),
      selected: configuredModelMatches(state.settings.llmModel, model),
    })));
  } else result.push({
    id: 'no-models', label: panel?.modelError ? 'Models unavailable' : 'No models returned',
    description: panel?.modelError ?? 'Refresh after starting the local LLM server.', disabled: true,
  });
  return result;
}



function configuredModelMatches(configuredModel, model) {
  if (configuredModel === model.id || configuredModel === model.key) return true;
  if (model.loadedInstanceIds?.includes(configuredModel)) return true;
  return Boolean(model.key) && String(configuredModel ?? '').startsWith(`${model.key}:`);
}

function modelChoiceLabel(model) {
  return [model.label, model.paramsString, model.quantization].filter(Boolean).join(' · ');
}

function modelChoiceDescription(state, model) {
  const config = formatLoadedModelConfig(modelConfigSummary(state, model));
  if (model.loaded) return config ? `Loaded configuration: ${config}` : 'This model currently has a loaded LM Studio instance.';
  return config ? `Saved configuration: ${config}` : 'Open to configure and select this model.';
}

function formatLoadedModelConfig(value) {
  return String(value ?? '')
    .replace(/^context /i, 'Context ')
    .replace(/ · batch /i, ' · batch ')
    .replace(/ · flash /i, ' · flash ')
    .replace(/ · KV /i, ' · KV ');
}

function modelDisplayLabel(model) {
  const details = [model.paramsString, model.quantization].filter(Boolean);
  return details.length ? `${model.label} · ${details.join(' · ')}` : model.label;
}

function choiceParameter(settingId, label, value, description) {
  return { id: settingId, type: 'choice', settingId, label, value, description };
}

function inputParameter(fieldId, label, value, description) {
  return { id: fieldId, type: 'input', fieldId, label, value, description };
}

function option(parameter, value, label, description = '') {
  return { id: `${parameter.settingId}:${value}`, settingId: parameter.settingId, value, label, description };
}


function interfaceLanguageLabel(state) {
  const configured = state.settings.interfaceLanguage ?? 'en';
  if (configured === 'system') {
    const active = state.i18n?.available?.find((item) => item.id === state.i18n?.languageId);
    return active ? `System · ${active.nativeName}` : 'System language';
  }
  return state.i18n?.available?.find((item) => item.id === configured)?.nativeName ?? configured;
}

function providerLabel(value) {
  return value === 'ollama' ? 'Ollama' : value === 'lmstudio' ? 'LM Studio' : 'Disabled';
}

function outputLabel(value) {
  return value === 'compact' ? 'Compact' : 'Last output line';
}

function archiveReviewLabel(value) {
  if (value === 'structure') return 'Structure guard';
  if (value === 'sample') return 'Sample guard';
  if (value === 'patch') return 'Deep patch review';
  return 'Structure guard';
}


function changeDeliveryLabel(value) {
  if (value === 'patch') return 'Full patch';
  if (value === 'representative') return 'Representative sample';
  if (value === 'capped') return 'Capped batches';
  if (value === 'change-list') return 'Changed paths only';
  if (value === 'chunked') return 'File-by-file chunks';
  return 'Adaptive';
}

function failureAnalysisLabel(value) {
  if (value === 'same-context') return 'Continue change context';
  return 'New context';
}

function verboseOutputLabel(value) {
  return value ? 'Keep raw responses' : 'Hide raw responses';
}

function archivePolicyLabel(value) {
  return value === 'move' ? 'Move to archive storage' : value === 'delete' ? 'Delete source ZIP' : 'Do nothing';
}

function displayArchiveDirectory(value) {
  return displayPath(path.resolve(expandHome(value)));
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const FIELD_DEFINITIONS = Object.freeze({
  llmApiToken: {
    id: 'llmApiToken',
    label: 'LLM API token',
    description: 'Optional bearer token used for model discovery and generation.',
    placeholder: 'Paste token or leave empty to clear',
    instructions: ['The token is stored in macOS Keychain or the Linux system keyring, never in Zipflow JSON files.', 'On Linux, persistent storage requires secret-tool and an active Secret Service provider.'],
    secret: true,
  },
  backupRetentionDays: {
    id: 'backupRetentionDays', label: 'Backup retention',
    description: 'How long Zipflow backups may remain available for rollback.', placeholder: '30',
    unitHint: 'Unit: whole days. Enter 0 to disable age-based cleanup.',
  },
  backupMaxBytes: {
    id: 'backupMaxBytes', label: 'Backup maximum size',
    description: 'Maximum combined size of Zipflow rollback backups.', placeholder: '2GB',
    unitHint: 'Units: B, KB, MB, GB, KiB, MiB, GiB. Enter 0 for no size limit.',
  },
  archiveDirectory: {
    id: 'archiveDirectory',
    label: 'Archive directory',
    description: 'Directory where completed source ZIPs are moved.',
    placeholder: '~/zipflow-archive',
    instructions: ['The directory is created after validation if it does not exist.', 'Tab completes directory names.'],
    path: true,
  },
  archiveRetentionDays: {
    id: 'archiveRetentionDays',
    label: 'Archive retention',
    description: 'How long Zipflow-managed archives may remain in storage.',
    placeholder: '30',
    unitHint: 'Unit: whole days. Enter 0 to disable age-based cleanup.',
  },
  archiveMaxBytes: {
    id: 'archiveMaxBytes',
    label: 'Archive maximum size',
    description: 'Maximum combined size of archives managed by Zipflow.',
    placeholder: '1GB',
    unitHint: 'Units: B, KB, MB, GB, KiB, MiB, GiB. Enter 0 for no size limit.',
  },
});
