export function formatRunReport(run) {
  const lines = [
    `ZIPFLOW RUN ${run.id}`,
    '',
    `Project: ${run.projectPath}`,
    ...(run.kind ? [`Action: ${actionLabel(run.kind)}`] : []),
    ...(run.archivePath ? [`Archive: ${run.archivePath}`] : []),
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
  ];
  if (run.archiveMetadata?.source) lines.push(`Commit message source: ${run.archiveMetadata.source}`);
  if (run.archiveDisposition) lines.push(`Source archive: ${formatArchiveDisposition(run.archiveDisposition)}`);
  if (run.archiveInfo) lines.push(`Archive files: ${run.archiveInfo.fileCount ?? 'unknown'} · modified ${run.archiveInfo.modifiedAt ?? 'unknown'}`);
  if (run.patch?.path) lines.push(`Patch: ${run.patch.path}`);
  if (run.archiveSafety?.warnings?.length || run.archiveSafety?.llm) {
    lines.push('', 'Archive safety:');
    for (const warning of run.archiveSafety.warnings ?? []) lines.push(`- ${warning.severity.toUpperCase()} ${warning.title}: ${warning.detail}`);
    if (run.archiveSafety.llm) {
      lines.push(`- LLM ${run.archiveSafety.llm.assessment} (${run.archiveSafety.llm.confidence} confidence, ${run.archiveSafety.llm.mode})`);
      for (const reason of run.archiveSafety.llm.reasons ?? []) lines.push(`  - ${reason}`);
    }
  }
  if (run.llm) {
    lines.push('', `Local LLM: ${run.llm.provider ?? 'unknown'} · ${run.llm.model ?? 'unknown'}${run.llm.durationMs ? ` · ${formatDuration(run.llm.durationMs)}` : ''}`);
    if (run.llm.error) lines.push(`LLM error: ${run.llm.error}`);
    else {
      lines.push('Summary:', ...(run.llm.summary ?? []).map((line) => `- ${line}`));
      if (run.llm.commitMessage) lines.push('', 'Proposed commit message:', run.llm.commitMessage);
      if (run.llm.warning) lines.push('', `LLM warning: ${run.llm.warning}`);
      if (run.llm.assessment) lines.push(`Archive assessment: ${run.llm.assessment} · ${run.llm.confidence ?? 'low'} confidence`);
    }
    if (run.llm.delivery?.resolved) lines.push(`LLM change delivery: ${run.llm.delivery.resolved}${run.llm.delivery.batches ? ` · ${run.llm.delivery.batches} batches` : ''}`);
    if (run.llm.diagnosticsPath) lines.push(`LLM diagnostics: ${run.llm.diagnosticsPath}`);
  }
  if (run.llmFailure) {
    lines.push('', `LLM failure explanation: ${run.llmFailure.mode ?? 'unknown'}${run.llmFailure.durationMs ? ` · ${formatDuration(run.llmFailure.durationMs)}` : ''}`);
    if (run.llmFailure.text) lines.push(run.llmFailure.text);
    if (run.llmFailure.error) lines.push(`LLM failure-analysis error: ${run.llmFailure.error}`);
    if (run.llmFailure.diagnosticsPath) lines.push(`LLM failure diagnostics: ${run.llmFailure.diagnosticsPath}`);
  }
  if (run.plan?.counts) lines.push('', 'Plan:', ...formatCounts(run.plan.counts));
  if (run.applied) {
    lines.push(
      '',
      `Applied files: ${run.applied.paths?.length ?? 0}`,
      `Preserved local files: ${run.applied.preservedPaths?.length ?? 0}`,
      `Backup: ${run.applied.backupPath ?? 'n/a'}`,
    );
  }
  if (run.checkpoint) lines.push('', `Checkpoint: ${run.checkpoint.revision} ${run.checkpoint.message}`);
  if (run.checks) {
    lines.push('', 'Checks:');
    for (const check of run.checks.results ?? []) {
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${formatDuration(check.durationMs)})`);
      if (!check.ok) appendCommandOutput(lines, check);
    }
  }
  if (run.commit) lines.push('', `Commit: ${run.commit.revision} ${run.commit.message}`);
  if (run.deploy) {
    lines.push('', `Deploy: ${run.deploy.skipped ? 'SKIPPED' : run.deploy.ok ? 'PASS' : 'FAIL'}`);
    if (run.deploy.commandText) lines.push(`Command: ${run.deploy.commandText}`);
    if (!run.deploy.ok && !run.deploy.skipped) appendCommandOutput(lines, run.deploy);
  }
  if (run.decisions?.length) {
    lines.push('', 'User decisions:');
    for (const decision of run.decisions) lines.push(`- ${decision.label} [${decision.screen}]`);
  }
  if (run.rollback) lines.push('', `Rollback: ${run.rollback.status}`);
  if (run.error) lines.push('', `Error: ${run.error.message ?? run.error}`);
  return `${lines.join('\n').trimEnd()}\n`;
}


export function formatCompletionForClipboard(run) {
  const counts = run.plan?.counts ?? {};
  const lines = [
    `ZIPFLOW RUN ${run.id}`,
    '',
    `Project: ${run.projectPath}`,
    ...(run.kind ? [`Action: ${actionLabel(run.kind)}`] : []),
    ...(run.archivePath ? [`Archive: ${run.archivePath}`] : []),
    `Status: ${run.status}`,
    '',
    `Changes: ${counts.created ?? 0} added · ${counts.updated ?? 0} changed · ${counts.deleted ?? 0} removed`,
    `Unchanged: ${counts.unchanged ?? 0} · Ignored: ${counts.skipped ?? 0} · Preserved: ${counts.preserved ?? 0}`,
    `Checks: ${run.checks ? `${run.checks.passed} passed · ${run.checks.failed} failed` : 'not run'}`,
    `Commit: ${run.commit ? `${run.commit.revision} ${firstLine(run.commit.message)}` : 'none'}`,
    `Deploy: ${run.deploy ? (run.deploy.ok ? 'passed' : run.deploy.skipped ? 'skipped' : 'failed') : 'not run'}`,
  ];
  if (run.llm?.summary?.length) lines.push('', 'Summary:', ...run.llm.summary.map((line) => `- ${line}`));
  return lines.join('\n');
}

export function formatFailureForClipboard(run) {
  const failed = run.checks?.results?.find((item) => !item.ok);
  const lines = [
    `ZIPFLOW RUN ${run.id}`,
    '',
    `Project: ${run.projectPath}`,
    ...(run.kind ? [`Action: ${actionLabel(run.kind)}`] : []),
    ...(run.archivePath ? [`Archive: ${run.archivePath}`] : []),
  ];
  if (run.plan?.counts) lines.push('', 'Applied plan:', ...formatCounts(run.plan.counts));
  if (failed) {
    lines.push('', `Failed check: ${failed.name}`, `Exit code: ${failed.code ?? 'n/a'}`, '', 'Output:');
    lines.push(([failed.stdout, failed.stderr].filter(Boolean).join('\n').trim() || '(no output)'));
  } else if (run.deploy && !run.deploy.ok && !run.deploy.skipped) {
    lines.push('', `Failed deploy command: ${run.deploy.commandText}`, `Exit code: ${run.deploy.code ?? 'n/a'}`, '', 'Output:');
    lines.push(([run.deploy.stdout, run.deploy.stderr].filter(Boolean).join('\n').trim() || '(no output)'));
  } else if (run.error) {
    lines.push('', `Error: ${run.error.message ?? run.error}`);
  }
  return lines.join('\n');
}

function appendCommandOutput(lines, result) {
  lines.push(`  Exit code: ${result.code ?? 'n/a'}`);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (output) lines.push('', output, '');
}

function formatCounts(counts) {
  return [
    `- Created: ${counts.created ?? 0}`,
    `- Updated: ${counts.updated ?? 0}`,
    `- Deleted: ${counts.deleted ?? 0}`,
    `- Preserved: ${counts.preserved ?? 0}`,
    `- Unchanged: ${counts.unchanged ?? 0}`,
    `- Skipped: ${counts.skipped ?? 0}`,
    `- Conflicts: ${counts.conflicts ?? 0}`,
  ];
}

function formatArchiveDisposition(disposition) {
  if (disposition.action === 'moved') return `moved to ${disposition.path}`;
  if (disposition.action === 'deleted') return 'deleted';
  if (disposition.action === 'kept') return 'kept in place';
  if (disposition.action === 'failed') return `policy failed: ${disposition.error}`;
  return disposition.action ?? 'unknown';
}

function formatDuration(milliseconds = 0) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}

function actionLabel(kind) {
  if (kind === 'manual-checks') return 'Manual tests against current project';
  if (kind === 'manual-deploy') return 'Manual deployment of current project';
  return String(kind ?? 'Update');
}
