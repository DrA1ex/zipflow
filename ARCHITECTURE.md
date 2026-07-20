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
- `settings-panel.js` owns global settings navigation, modal editor state, validation, persistence, and model refreshes.
- `settings-panel-state.js` owns reusable category/detail focus transitions and nested-panel restoration.
- `settings-options.js` declares stable left-pane sections, dependent right-pane controls, non-focusable section/stat rows, and reusable field metadata for modal editors.
- `settings-model.js` owns atomic model selection and LM Studio unload/reload behavior.
- `settings-model-check.js` owns connection and protocol compatibility tests.
- `settings-model-replay.js` owns read-only historical patch replay and its streaming workspace.
- `settings-storage.js` owns source-archive and backup statistics, cleanup, and retention actions.
- `llm-progress.js` maps streaming model events into a transient Activity view.
- `archive-policy.js` applies the global source-ZIP disposition after a run is kept.
- `export-flow.js` owns the interactive Create ZIP workflow.
- `state.js` contains UI state helpers.

Flow modules call domain services but do not implement ZIP parsing, hashing, Git parsing, or filesystem transactions.

### `src/diff`

Builds bounded per-file comparisons for review. Text files produce a shared line model rendered as unified or side-by-side views. `hunks.js` groups distant changes with bounded context and exposes stable offsets for cyclic N/P navigation. Binary and oversized inputs return explicit informational records. Diff computation is independent of Terlio so it can be regression-tested without a terminal.

### `src/ui`

Builds declarative Terlio views from application state.

Rendering does not perform project mutations. Global settings use a stable two-panel category/page layout. `Tab` changes pane focus without activating an item. Multi-parameter categories render compact value rows, non-focusable section/stat rows, and one explanation below the list. Nested selection replaces only the right pane and retains category, parameter, and current-value positions. LM Studio model selection can enter a dedicated right-pane configuration state without replacing the category pane; the radio marker communicates selection while loaded state is muted secondary metadata. Load-time settings remain editable and are applied through an explicit unload/reload cycle when needed. Project discovery is stored as a framed Activity message rather than a permanent project panel. Activity uses Terlio's component-level text selection; `Ctrl+T` is the explicit escape hatch for native terminal selection elsewhere. Pointer callbacks dispatch the same actions used by keyboard input. The selected Terlio semantic theme is resolved from global settings on every render, so theme changes apply immediately. Zipflow targets Terlio 1.1.2: runtime `animationFrame` drives spinners only while a rendered component requests animation, dynamic blocking overlays keep replay layout responsive, and virtualized `ScrollPane` rendering is paired with Zipflow-side transcript caching so expanded 10k-line logs are not rewrapped on every scroll frame.

#### Terlio component ownership

Zipflow delegates generic terminal UI behavior to Terlio instead of assembling terminal geometry itself:

- `WorkspaceShell`, `WorkspacePane`, and `WorkspaceFooter` own the application frame;
- `ScrollPane` owns Activity and diff scrolling, pointer-wheel dispatch, selection, and viewport-only rendering for very large line sets;
- `SelectList` owns project actions, settings choices, model lists, and path-completion rows;
- `SplitPane` owns the persistent two-column settings layout;
- `BottomOverlay` and `Modal` own completion and editor overlays without shifting the base layout;
- `TextEditorView` and `handleInputEditorKey` own editable text behavior;
- `KeyValueBlock` owns the framed `Project detected` summary;
- `ProgressBar`, `RequireViewport`, and Terlio theme/color helpers own generic progress, viewport, and styling behavior.

Custom rendering is limited to domain behavior Terlio does not provide: semantic unified/side-by-side source diffs with hunk offsets, typed/collapsible Activity history, and workflow-specific labels and state transitions. UI regression tests assert the selected Terlio node types and reject manual rounded-border construction in `src/ui`.

### `src/settings`

Persists versioned global application settings in `~/.zipflow/settings.json`. Settings are deliberately separate from project workflows. They include the local LLM provider, optional bearer token, selected model and instance, separate prompt/summary/commit languages, archive-review mode, change-delivery strategy, failed-check analysis policy, source-ZIP disposition and retention, backup retention, and managed-file recording policy. Migration preserves the legacy single output language for summaries and commit messages while defaulting prompts to English.

### `src/llm`

Uses provider-specific adapters. LM Studio model metadata comes from the native `/api/v1/models` endpoint, including parameter counts and loaded-instance configuration. `settings-model.js` persists optional per-model load parameters, unloads stale LLM instances, and invokes `/api/v1/models/load` to make the selected configuration active; generation uses only the native `/api/v1/chat` stream, including model-load, prompt-processing, reasoning, message, and error events. Ollama model metadata comes from `/api/ps` and `/api/show`; generation uses its OpenAI-compatible chat-completion stream. Loaded LM Studio instances are resolved before generation and addressed by instance ID. Model metadata, the resolved instance, context configuration, and bearer token are captured once per LLM run and reused by structure review, patch analysis, chunk synthesis, and repair requests; a successful generation is never invalidated by a later metadata refresh. Load-time settings are not repeated, while an optional saved request-context override is passed to `/api/v1/chat`. API tokens are applied only as authorization headers and are never emitted through Activity events. An `AbortSignal` is threaded through metadata, request, and SSE consumption so `Esc` cancels only LLM generation while the archive plan continues.

`model-info.js` resolves the active or configured context size with a conservative fallback. `patch-budget.js` reserves context for instructions and output, keeps a complete changed-file manifest, and distributes available diff hunks across files. Context overflow and local compute-memory errors trigger progressively smaller-patch retries. `diagnostics.js` stores a bounded, sanitized request/result/error record in the run directory.

`archive-review.js` can compare bounded project/archive trees before change generation. `delivery.js` selects a bounded full patch, an explicit changed-path list, or file-by-file patch batches; adaptive delivery chooses between full-patch and chunked analysis from the discovered context budget. Chunked analysis stores compact notes for each batch and synthesizes them in a final request. Deep review extends the readable response with `assessment`, `confidence`, and concise reasons. `response.js` parses the user-facing section protocol while a hidden JSON-repair request handles models that ignore it or return reasoning-only output. `failure.js` can explain a failed check in a fresh context or with the compact preceding change-review context. LM Studio native requests flatten prior assistant context and the current request into one valid string input because the endpoint does not accept chat-history message objects in `input`. LLM errors remain non-fatal to archive application.

### `src/patch`

Builds and persists `changes.patch` from the pre-apply project snapshot and extracted archive. Text files use unified diff records; binary and oversized files use explicit change markers. The complete patch is stored with the run while the LLM prompt receives a bounded representation.

### `src/history`

Persists per-project paths previously created or updated by Zipflow. Recording can be disabled without deleting existing data; clearing is a separate confirmed action. Managed-history snapshot deletion is unavailable while recording is disabled, and recording cannot be disabled while an active workflow depends on that deletion scope. `analytics.js` aggregates recent check and provider/model timing samples into medians, averages, success rates, retry/truncation counts, and recent trends. Applying updates advances the set only when recording is enabled; rollback restores its previous state.

### `src/project`

Detects the project root, technologies, package managers, recommended checks, `./scripts` commands, and deployment candidates. Each technology has an isolated detector; Swift/macOS support lives in `detectors/swift.js`, while generic script discovery is isolated in `project/scripts.js`.

### `src/workflow`

Defines defaults, normalizes older workflow files, and persists versioned workflows keyed by canonical project path.

### `src/export`

Collects source paths for tracked, non-ignored, interactive, and all-file exports, then writes ZIP archives. Protected `.git/` and `.zipflow/` roots are filtered below the UI layer.


### `src/app/manual-flow.js`

Runs configured checks or deployment against the current local project without applying an archive. Manual actions create ordinary persisted run reports and expose LLM failure explanation only as an explicit result-screen action.

### `src/archive`

Validates and extracts ZIP archives into an isolated temporary directory. It rejects traversal, absolute paths, `.git`, symbolic links, duplicate or case-colliding paths, and configured size-limit violations.

A single top-level wrapper is evaluated before metadata, LLM review, or final planning. Zipflow compares the wrapper-as-root and literal-subdirectory plans. When the literal interpretation would create one new directory while deleting or replacing the real project tree, the user must choose the archive root explicitly or cancel.

`disposition.js` owns the global post-run policy for the source ZIP. Move mode records only Zipflow-managed archives in `archive-index.json`; retention and size pruning can therefore never delete unrelated files from the selected directory.

`risk.js` compares archive metadata and snapshot scope with recent successful project runs, producing explicit old-archive, large-deletion, and file-count shrink warnings.

`metadata.js` reads supported archive control files, preferring `.zipflow/commit-message.txt`. Control files can provide a commit message but never become project files or snapshot deletion targets.

### `src/plan`

Compares extracted files with the local project, classifies changes, applies exclusions, calculates snapshot deletions, and intersects the result with Git status to identify real conflicts.

Incoming paths matched by `.gitignore` and every `.zipflow/` path are skipped unconditionally. Snapshot deletion also preserves ignored files. `.gitignore` itself is deletion-protected even when absent from a snapshot. Files recognized as credentials, private keys, secrets, or local databases are likewise never snapshot-deletion targets. Other dot-prefixed names receive no special treatment unless protected explicitly or ignored by Git.

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

Contains filesystem, hashing, paths, identifiers, and child-process lifecycle helpers. Path suggestion discovery treats an existing entered directory as a browse root, preserves ordinary dot-paths, and returns rich file/directory actions consumed by an overlay state machine in `app/path-suggestions.js`.

## Setup lifecycle

The setup wizard follows this order:

```text
project
  -> optional git init
  -> create a recommended .gitignore only when none exists
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

Global settings use a two-panel category/detail state machine. The left panel contains stable top-level categories without descriptions. The right panel displays concise `Parameter: value` rows, section headings, and read-only statistics; only actionable rows receive focus. Explanations appear below the focused list. `Tab` switches pane focus, `Enter` or `Space` activates, and returning restores prior category, parameter, and value positions. Dependent controls are omitted or disabled with an explicit reason, and input-like values open in a modal without replacing either panel.

## Interactive review model

The main project screen exposes the selected workflow parameters before offering a fast update path. Fine-tuning remains a separate action rather than an unavoidable part of every run.

Run UI state is layered without changing the underlying transaction model:

```text
compact plan
  -> grouped plan review
  -> file list
  -> unified or side-by-side diff
  -> return to the same file and selection
```

Conflict review uses a queue over the plan's conflicting items. A decision removes one item from the queue and advances to the next; bulk choices populate the same decision map without duplicating application logic. Diff views store their originating screen, item list, selected index, and introduction text so returning never loses the user's position.

Activity messages are typed as information, running state, success, warning, error, user choice, or final summary. Durable blocks longer than three lines start collapsed with semantic summaries and can be toggled at the current scroll position; project discovery and the final summary remain expanded. When the reader is above the bottom, appended entries preserve position and expose a full-width clickable unread indicator; streaming replacement does not count every token as a new entry. Live LLM text preserves provider line breaks and is wrapped with Terlio's width-aware text utility before rendering. The current five-stage run position is derived from application state and displayed separately in the header.

Run history is persisted in existing run records rather than a second event database. Presentation separates archive updates, manual tests, and manual deployments, with independent type and status filters. Archive hashes support duplicate warnings, and workflow `lastRunId` resolves the deliberate repeat-last action.

## Run lifecycle

A normal run follows this order:

```text
archive input
  -> project lock
  -> isolated extraction
  -> archive metadata
  -> persisted changes.patch
  -> optional LLM structure guard or deep patch review
  -> readable streamed local LLM analysis using path, patch, or file-batch delivery
  -> immediate durable verdict and summary in Activity before commit-message selection
  -> deterministic archive age/snapshot shrink review
  -> optional reasoning-draft formatting pass
  -> copyable Activity plan
  -> bulk conflict policy
  -> optional per-file conflict decisions
  -> optional checkpoint
  -> plan freshness verification
  -> backup
  -> transactional apply
  -> checks
  -> optional local LLM failed-check explanation
  -> optional result commit
  -> optional deployment
  -> source ZIP keep, move, or delete policy
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
- an existing `.gitignore` is never rewritten or extended;
- dotfiles and dot-directories are synchronized normally unless protected, ignored, or part of the permanent safety set (`.env`, `.env.*`, `.venv/**`, `.DS_Store`);
- protected and untracked ignored paths are removed from result-commit staging;
- local LLM failures are recorded but cannot block planning or application;
- local LLM archive verdicts are advisory and cannot disable deterministic protections;
- suspicious archive age or snapshot shrink requires an explicit review decision;
- API tokens are used only in request headers and are not copied into Activity or run reports;
- source archive retention removes only files recorded in Zipflow's archive index;
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
- global settings persistence, schema migration, pane-focus navigation, section/stat rendering, and compact descriptions;
- LM Studio and Ollama model metadata, atomic model selection, unload/reload configuration, separate prompt/summary/commit languages, compatibility tests, read-only historical replay, context budgeting, structural patch truncation, adaptive/full/path-list/file-batch delivery, optional authorization, native and OpenAI-compatible streams, readable wrapped progress, context/OOM retries, reasoning-only responses, hidden repair requests, failure explanations, and diagnostics;
- source archive keep, move, delete, statistics, indexed cleanup, retention, and size-limit behavior;
- backup statistics, guarded cleanup, retention by age/size, active-run protection, and rollback availability;
- commit-message editor fallback, typing, deletion, and multiline input;
- patch creation from archive-versus-snapshot changes;
- managed-file recording policy, guarded deletion scope, and separate clear action;
- Git initialization, ignore generation, and first commit;
- all four ZIP export modes;
- copyable and collapsible Activity, readable LLM streaming, final-summary ordering, and native-selection fallback;
- bulk-before-manual conflict UX and one-file conflict queues;
- unified and side-by-side file diff rendering with hunk navigation;
- compact workflow home, five-stage run progress, duplicate/old/shrinking archive warnings, performance analytics, and persisted run history;
- ZIP preview and post-create actions;
- typed Activity and TUI rendering.

## Public dependency lock URLs

`package-lock.json` is part of the distributable source archive and must retain public `https://registry.npmjs.org/` tarball URLs. Local CI, proxy, or private mirror URLs must never be committed into the lockfile.


### Terminal navigation invariants

- `Esc` navigates backward or cancels the active sub-process; it never exits from the top-level project menu. Application exit is explicit through `Ctrl+C` or the `Exit` action.
- Path completion is an overlay. Archive input shows aligned `DIR` and `ZIP` markers and never submits a selected completion until the user confirms the completed path separately.
- The framed project Activity message calculates all borders from one visible inner width. Complete historical patches use semantic diff coloring inside Activity.
- The completed-run menu exposes one primary action for returning to archive waiting, avoiding synonymous duplicate actions.

## LM Studio model identity

Zipflow keeps LM Studio catalog model keys and loaded instance IDs separate. The catalog `key` returned by `GET /api/v1/models` is the only value sent in the `model` field of `POST /api/v1/chat` and stored as the selected model. A `loaded_instances[].id` value is runtime metadata used only to detect an already loaded model and display its active configuration. Legacy settings that stored a numbered instance ID are resolved against the current catalog before a request is sent.
