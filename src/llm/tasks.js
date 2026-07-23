export const LLM_TASK_SETTING_IDS = Object.freeze([
  'llmUseArchiveReview',
  'llmUseSummary',
  'llmUseFailedChecks',
  'llmUseCommitMessage',
]);

export function llmTasks(settings = {}) {
  return {
    archiveReview: settings.llmUseArchiveReview === undefined
      ? Boolean(settings.llmArchiveReview && settings.llmArchiveReview !== 'disabled')
      : settings.llmUseArchiveReview === true,
    summary: settings.llmUseSummary !== false,
    failedChecks: settings.llmUseFailedChecks === undefined
      ? Boolean(settings.llmFailureAnalysis && settings.llmFailureAnalysis !== 'disabled')
      : settings.llmUseFailedChecks === true,
    commitMessage: settings.llmUseCommitMessage !== false,
  };
}

export function hasLlmChangeTasks(settings) {
  const tasks = llmTasks(settings);
  return tasks.archiveReview || tasks.summary || tasks.commitMessage;
}

export function isLlmArchiveReviewEnabled(settings) {
  return llmTasks(settings).archiveReview;
}

export function isLlmFailureAnalysisEnabled(settings) {
  return llmTasks(settings).failedChecks;
}
