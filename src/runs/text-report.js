export function formatRunReport(run) {
  const lines = [
    `ZIPFLOW RUN ${run.id}`,
    '',
    `Project: ${run.projectPath}`,
    `Archive: ${run.archivePath}`,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
  ];
  if (run.archiveMetadata?.source) lines.push(`Commit message source: ${run.archiveMetadata.source}`);
  if (run.patch?.path) lines.push(`Patch: ${run.patch.path}`);
  if (run.llm) {
    lines.push('', `Local LLM: ${run.llm.provider ?? 'unknown'} · ${run.llm.model ?? 'unknown'}`);
    if (run.llm.error) lines.push(`LLM error: ${run.llm.error}`);
    else {
      lines.push('Summary:', ...(run.llm.summary ?? []).map((line) => `- ${line}`));
      if (run.llm.commitMessage) lines.push('', 'Proposed commit message:', run.llm.commitMessage);
    }
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
  if (run.rollback) lines.push('', `Rollback: ${run.rollback.status}`);
  if (run.error) lines.push('', `Error: ${run.error.message ?? run.error}`);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function formatFailureForClipboard(run) {
  const failed = run.checks?.results?.find((item) => !item.ok);
  const lines = [
    `ZIPFLOW RUN ${run.id}`,
    '',
    `Project: ${run.projectPath}`,
    `Archive: ${run.archivePath}`,
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

function formatDuration(milliseconds = 0) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}
