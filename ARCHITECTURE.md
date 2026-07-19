# Zipflow Architecture

## Design goals

Zipflow separates the terminal interface from project analysis and filesystem operations. The interactive application coordinates independently testable services instead of embedding archive, Git, process, or persistence logic inside rendering code.

The main constraints are:

- one interactive user entry point;
- no destructive filesystem writes before a complete plan exists;
- backups restore the pre-run working tree rather than Git `HEAD`;
- unrelated Git changes remain untouched;
- result commits include only committable applied paths;
- optional local LLM analysis never becomes a prerequisite for applying an archive;
- deployment cannot run before required checks pass;
- active child processes and project locks are owned by the application lifecycle;
- JavaScript files should remain below 500 lines and may never exceed 1,000 lines.

## Layers

### `src/app`

Owns the interactive state machine.

- `controller.js` handles application-wide navigation, input dispatch, stable menu selection, and global settings access.
- `setup-flow.js` coordinates project, policy, Git, deployment, and review stages.
- `setup-git-init.js` owns optional repository initialization, recommended ignore rules, and the first commit.
- `setup-checks.js` owns check selection and the custom-check editor flow.
- `run-flow.js` coordinates archive inspection, planning, conflict decisions, checkpointing, and application.
- `run-postcheck.js` owns checks, result commits, deployment, and successful completion.
- `run-rollback.js` owns run details and exact rollback.
- `run-lifecycle.js` owns cancellation, failure reporting, locks, and temporary cleanup.
- `settings-panel.js` owns the global two-pane settings interaction.
- `export-flow.js` owns the interactive Create ZIP workflow.
- `state.js` contains UI state helpers.

Flow modules call domain services but do not implement ZIP parsing, hashing, Git parsing, or filesystem transactions.

### `src/ui`

Builds declarative Terlio views from application state.

Rendering does not perform project mutations. Activity uses Terlio's component-level text selection; `Ctrl+T` is the explicit escape hatch for native terminal selection elsewhere. Pointer callbacks dispatch the same actions used by keyboard input. The selected Terlio semantic theme is resolved from global settings on every render, so theme changes apply immediately.

### `src/settings`

Persists versioned global application settings in `~/.zipflow/settings.json`. Settings are deliberately separate from project workflows. They include the local LLM provider, selected model, and response language.

### `src/llm`

Uses one OpenAI-compatible client for Ollama and LM Studio. It lists models from `/v1/models`, requests structured JSON from `/v1/chat/completions`, validates the summary and commit message, and retries with JSON mode when a server or model rejects JSON Schema. LLM errors are non-fatal to archive application.

### `src/patch`

Builds and persists `changes.patch` from the pre-apply project snapshot and extracted archive. Text files use unified diff records; binary and oversized files use explicit change markers. The complete patch is stored with the run while the LLM prompt receives a bounded representation.

### `src/history`

Persists per-project paths previously created or updated by Zipflow. Managed-history snapshot deletion intersects missing local paths with this set. Applying updates advances the set; rollback restores its previous state; global settings can reset it explicitly.

### `src/project`

Detects the project root, technologies, package managers, and recommended checks. Each technology has an isolated detector.

### `src/workflow`

Defines defaults, normalizes older workflow files, and persists versioned workflows keyed by canonical project path.

### `src/export`

Collects source paths for tracked, non-ignored, interactive, and all-file exports, then writes ZIP archives. Protected `.git/` and `.zipflow/` roots are filtered below the UI layer.

### `src/archive`

Validates and extracts ZIP archives into an isolated temporary directory. It rejects traversal, absolute paths, `.git`, symbolic links, duplicate or case-colliding paths, and configured size-limit violations.

`metadata.js` reads supported archive control files, preferring `.zipflow/commit-message.txt`. Control files can provide a commit message but never become project files or snapshot deletion targets.

### `src/plan`

Compares extracted files with the local project, classifies changes, applies exclusions, calculates snapshot deletions, and intersects the result with Git status to identify real conflicts.

Incoming paths matched by `.gitignore` and every `.zipflow/` path are skipped unconditionally. Snapshot deletion also preserves ignored files.

Tracked-only snapshot mode reports untracked missing files as `preserved`. Managed-history mode reports paths not previously created or updated by Zipflow as `preserved`. This makes each non-deletion explicit in Activity and reports.

### `src/apply`

Owns project locks, backups, transactional application, plan freshness checks, and rollback.

`applyUpdatePlan()` verifies the plan immediately before backup. If any subsequent write fails, it restores all manifest paths before returning an error.

### `src/checks`

Runs selected checks sequentially and captures bounded stdout and stderr. Specialized changed-file runners are used for JavaScript, Python, and Go formatting; user commands are explicitly marked as shell commands.

### `src/deploy`

Runs the configured deployment command after successful checks. Deployment is not part of the check list because it may change external state and has separate `ask`, `always`, and `on-demand` policies.

### `src/git`

Wraps Git operations and parses working-tree state. Commit creation refuses an already populated index, rejects protected paths, filters untracked ignored paths, and stages only the remaining supplied paths.

Checkpoint and result commits are separate state-machine stages and use separate workflow policies.

### `src/runs`

Persists JSON and copy-friendly text reports, including preserved files, archive metadata, checkpoint commits, result commits, and deployment results.

### `src/utils`

Contains filesystem, hashing, paths, identifiers, and child-process lifecycle helpers.

## Setup lifecycle

The setup wizard follows this order:

```text
project
  -> optional git init
  -> optional recommended .gitignore
  -> optional first commit
  -> checks
  -> conflict policy
  -> archive interpretation
  -> snapshot deletion scope, when applicable
  -> checkpoint policy
  -> result commit policy
  -> commit message source, when applicable
  -> deployment policy
  -> deployment command, when applicable
  -> review and atomic workflow replacement
```

Dependent settings are omitted when their parent feature is disabled. Menu rerenders preserve selection by item identifier rather than resetting to the first item.

## Run lifecycle

A normal run follows this order:

```text
archive input
  -> project lock
  -> isolated extraction
  -> archive metadata
  -> persisted changes.patch
  -> optional local LLM summary and commit message
  -> copyable Activity plan
  -> bulk conflict policy
  -> optional per-file conflict decisions
  -> optional checkpoint
  -> plan freshness verification
  -> backup
  -> transactional apply
  -> checks
  -> optional result commit
  -> optional deployment
  -> report
  -> cleanup
```

The project lock spans inspection through completion so two Zipflow processes cannot build and apply stale plans concurrently. Project identity is based on the canonical filesystem path, so aliases such as macOS `/var` and `/private/var` or a symlink cannot create duplicate workflows or bypass the lock.

On-demand deployment can run from the completed screen after run resources have been released. Its result is appended to the existing run report.

## Safety boundaries

The following rules are enforced below the UI layer:

- archive paths cannot escape extraction root;
- `.git` cannot arrive from an archive;
- symbolic links are rejected;
- case-colliding paths are rejected before extraction can overwrite data;
- archive control files and the complete `.zipflow/` tree are not applied to the project;
- files matched by `.gitignore` are not created, updated, or deleted;
- protected and untracked ignored paths are removed from result-commit staging;
- local LLM failures are recorded but cannot block planning or application;
- files changed after plan review abort application;
- partial application failures trigger automatic restoration;
- rollback refuses paths modified after the run;
- automatic commits refuse pre-existing staged changes;
- deployment cannot start before required checks pass;
- cleanup terminates all active child processes.

The UI may offer less conservative policies, but those policies cannot disable backups, archive path validation, transaction restoration, or child-process ownership.

## Extending project support

A new project detector should return:

```js
{
  id,
  label,
  details,
  files,
  checks,
  note,
}
```

Checks use a runner `kind`. Add a specialized runner only when a check cannot be represented safely as a command and argument array.

## Testing strategy

Unit and integration tests use temporary projects and Git repositories. Regression tests cover:

- project detection and canonical root identity across filesystem aliases;
- archive root handling and path security;
- archive commit-message metadata;
- unchanged dirty files;
- unrelated local changes;
- conflicting updates;
- snapshot deletion and preserved untracked files;
- stale-plan detection;
- automatic restoration after partial failure;
- exact rollback of pre-run dirty content;
- path-scoped commits;
- staged-index protection;
- deploy command execution;
- child-process cleanup;
- custom-check prompt order;
- stable radio selection and Space activation;
- global settings persistence and rendering;
- OpenAI-compatible model discovery and structured local LLM responses;
- patch creation from archive-versus-snapshot changes;
- managed-file deletion history and reset;
- Git initialization, ignore generation, and first commit;
- all four ZIP export modes;
- copyable Activity and native-selection fallback;
- bulk-before-manual conflict UX;
- TUI rendering.
