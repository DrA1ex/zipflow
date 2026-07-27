export const LLM_TASK_SETTING_IDS = Object.freeze([
  'llmUseArchiveReview',
  'llmUseDeletionIntentReview',
  'llmUseSummary',
  'llmUseFailedChecks',
  'llmUseCommitMessage',
  'llmUseDirtyTreeCommitMessage',
]);

export function llmTasks(settings = {}) {
  return {
    archiveReview: settings.llmUseArchiveReview === undefined
      ? Boolean(settings.llmArchiveReview && settings.llmArchiveReview !== 'disabled')
      : settings.llmUseArchiveReview === true,
    deletionIntentReview: settings.llmUseDeletionIntentReview === true,
    summary: settings.llmUseSummary !== false,
    failedChecks: settings.llmUseFailedChecks === undefined
      ? Boolean(settings.llmFailureAnalysis && settings.llmFailureAnalysis !== 'disabled')
      : settings.llmUseFailedChecks === true,
    commitMessage: settings.llmUseCommitMessage !== false,
    dirtyTreeCommitMessage: settings.llmUseDirtyTreeCommitMessage === true,
  };
}

export function hasLlmChangeTasks(settings) {
  const tasks = llmTasks(settings);
  return tasks.archiveReview || tasks.deletionIntentReview || tasks.summary || tasks.commitMessage;
}

export function hasLlmPatchDeliveryTasks(settings) {
  const tasks = llmTasks(settings);
  return tasks.archiveReview || tasks.deletionIntentReview || tasks.summary || tasks.commitMessage || tasks.dirtyTreeCommitMessage;
}

export function isLlmDirtyTreeCommitMessageEnabled(settings) {
  return llmTasks(settings).dirtyTreeCommitMessage;
}

export function isLlmArchiveReviewEnabled(settings) {
  return llmTasks(settings).archiveReview;
}

export function isLlmFailureAnalysisEnabled(settings) {
  return llmTasks(settings).failedChecks;
}
