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


## Patch 1.0.3 interaction contracts

- Plan review owns an explicit decision for every added, changed, and removed path. Apply, backup, verification, managed-file history, commit context, and final counts consume the selected subset rather than the original plan totals.
- Page navigation is focus-aware. `Page Up` and `Page Down` move the active file/history/check list on list screens and fall back to Activity scrolling elsewhere.
- Context docks have fixed geometry, a visible accent marker, and an explicit full-help affordance when text is truncated. Long help and notices use a wrapping, scrollable overlay.
- Real process `SIGINT` is routed through the same operation manager as keyboard `Ctrl+C`; the application exits only when no operation owns cancellation.
- LM Studio catalog and loaded-instance identifiers are normalized through `model-identity.js` for compatibility state and performance analytics.

## Layers

### `src/app`

Owns the interactive state machine.

- `controller.js` handles application-wide navigation, input dispatch, stable menu selection, and global settings access.
- `setup-flow.js` coordinates project, policy, Git, deployment, and review stages.
- `setup-git-init.js` owns optional repository initialization, recommended ignore rules, and the first commit.
- `setup-checks.js` owns check selection and the custom-check editor flow.
- `run-flow.js` coordinates archive inspection, planning, conflict decisions, checkpointing, and application.
- `plan-selection.js` owns per-path Apply/Keep decisions, selected counts, and durable selection records used by review, apply, and reporting.
- `run-postcheck.js` owns checks, result commits, deployment, and successful completion.
- `run-rollback.js` owns run details and exact rollback.
- `run-lifecycle.js` owns cancellation, failure reporting, locks, and temporary cleanup.
- `settings-panel.js` owns global settings navigation, modal editor state, validation, persistence, and model refreshes.
- `settings-panel-state.js` owns reusable category/detail focus transitions and nested-panel restoration.
- `settings-options.js` declares stable left-pane sections, dependent right-pane controls, non-focusable section/stat rows, and reusable field metadata for modal editors.
- `settings-model.js` owns atomic model selection and LM Studio unload/reload behavior.
- `settings-model-check.js` owns connection and protocol compatibility tests.
- `settings-model-replay.js` owns the shared read-only historical replay workspace, scrolling, copy, and diagnostics behavior.
- `settings-autopilot-replay.js` reconstructs historical decision gates and compares Guarded and Full autopilot without executing any action.
- `settings-storage.js` owns source-archive and backup statistics, cleanup, and retention actions.
- `llm-progress.js` maps streaming model events into Activity and retains the completed raw reasoning/answer as a collapsed durable block.
- `archive-policy.js` applies the global source-ZIP disposition after a run is kept.
- `export-flow.js` owns the interactive Create ZIP workflow.
- `state.js` contains UI state helpers.

Flow modules call domain services but do not implement ZIP parsing, hashing, Git parsing, or filesystem transactions.

### `src/diff`

Builds bounded per-file comparisons for review. Text files produce a shared line model rendered as unified or side-by-side views. `hunks.js` groups distant changes with bounded context and exposes stable offsets for cyclic N/P navigation. Binary and oversized inputs return explicit informational records. Diff computation is independent of Terlio so it can be regression-tested without a terminal.

### `src/ui`

Builds declarative Terlio views from application state.

Rendering does not perform project mutations. Global settings use a stable two-panel category/page layout. Settings writes are serialized partial updates: the latest persisted record takes precedence over a stale panel snapshot, then only the requested patch is applied. The bearer token is loaded from the operating-system credential store and is omitted from settings JSON and backups. Node test workers use a process-specific in-memory credential backend and temporary Zipflow home unless `ZIPFLOW_HOME` is explicit. Together these rules prevent unrelated UI saves or the project test suite from resetting or exposing real credentials and archive policy. `Tab` changes pane focus without activating an item. Multi-parameter categories render compact value rows, non-focusable section/stat rows, and a fixed two-row context dock below the list. Nested value pages use one row for the parameter contract and one for the selected value; unused footer space is returned to the list. Workflow setup and Change Workflow render every choice as one physical row and reserve a stable two-row context dock; other workflow, history, export, and recovery menus use a one-row dock. Selected descriptions never participate in list-item height or pane-height calculation. `src/ui/select-rows.js` converts semantic menu objects into minimal physical SelectList rows so Terlio cannot implicitly append descriptions, disabled reasons, or values to the row body. Nested selection replaces only the right pane and retains category, parameter, and current-value positions. The global key-hint footer is deliberately untitled rather than presented as a `STATUS` panel. Editors use a Zipflow wrapper around Terlio's editor-line renderer to apply a muted placeholder while preserving the visible cursor and native editing semantics. LM Studio model selection can enter a dedicated right-pane configuration state without replacing the category pane; the radio marker communicates selection while loaded state is muted secondary metadata. Load-time settings remain editable and are applied through an explicit unload/reload cycle when needed. Historical replay is a single accent-framed blocking overlay: its identity/status header and command/position footer are fixed, while only the borderless central output viewport scrolls. Preview actions are anchored to the modal bottom by a real growable layout node, and streaming output is wrapped and cached against the current viewport width. Parsed output is rendered from structured fields and completed raw model streams are compacted without removing them from copied diagnostics. Project discovery is stored as a framed Activity message rendered with Terlio `PropertyRows`, so key/value columns align without manual padding, rather than a permanent project panel. Activity uses Terlio's component-level text selection; `Ctrl+T` is the explicit escape hatch for native terminal selection elsewhere. Pointer callbacks dispatch the same actions used by keyboard input. The selected Terlio semantic theme is resolved from global settings on every render, so theme changes apply immediately. Zipflow targets Terlio 1.1.3: runtime `animationFrame` drives spinners only while a rendered component requests animation, dynamic blocking overlays keep replay layout responsive, virtualized `ScrollPane` rendering is paired with Zipflow-side transcript caching so expanded 10k-line logs are not rewrapped on every scroll frame, and fenced code or JSON is routed through the library's syntax-highlighting surface.

#### Terlio component ownership

Zipflow delegates generic terminal UI behavior to Terlio instead of assembling terminal geometry itself:

- `WorkspaceShell` and `WorkspacePane` own the application frame; the global key-hint footer is a dedicated untitled bordered `Box`, so Terlio cannot inject a fallback `STATUS` title;
- `ScrollPane` owns Activity and diff scrolling, pointer-wheel dispatch, selection, and viewport-only rendering for very large line sets;
- `SelectList` owns project actions, settings choices, model lists, and path-completion rows;
- `SplitPane` owns the persistent two-column settings layout;
- `BottomOverlay` and `Modal` own completion and editor overlays without shifting the base layout;
- `renderTextEditorLines` and `handleInputEditorKey` own editable text behavior, while `ZipflowTextEditorView` applies the shared muted-placeholder presentation; bracketed or normalized paste is intercepted before ordinary key handling and inserted atomically;
- Terlio's syntax-highlighting export owns language-aware code rendering behind Zipflow's fenced-block and JSON parser;
- `KeyValueBlock` owns the framed `Project detected` summary;
- `ProgressBar`, `RequireViewport`, and Terlio theme/color helpers own generic progress, viewport, and styling behavior.

Custom rendering is limited to domain behavior Terlio does not provide: semantic unified/side-by-side source diffs with hunk offsets, typed/collapsible Activity history, and workflow-specific labels and state transitions. UI regression tests assert the selected Terlio node types and reject manual rounded-border construction in `src/ui`.


### `src/i18n`

Loads versioned interface-language JSON packs before ordinary rendering begins. Built-in packs ship under `src/i18n/locales`; user packs are discovered in `~/.zipflow/languages` (or `ZIPFLOW_HOME/languages`) and validated as data against `language.schema.json`. The runtime accepts only metadata strings, exact message strings, and bounded named-placeholder patterns. It does not import JavaScript, evaluate expressions, follow paths declared by a pack, or resolve remote schema references.

The active pack is represented in application state so rendering remains deterministic and cache signatures can include the language. Shared workflow chrome, setup menus, settings, context help, Activity, replay workspaces, statuses, and toasts route through one translation boundary. Missing strings fall back to the built-in English catalog, allowing third-party packs to be incremental while keeping every screen usable. Changing the language reconfigures the registry atomically and rerenders without rewriting project workflows.

All selectable collections pass through `src/ui/select-rows.js` before reaching Terlio. The adapter deliberately removes semantic help fields and produces one physical row containing only identity, label, and interaction flags. Descriptions and disabled reasons remain in the translated context dock. This prevents language-dependent row heights, duplicated help, and viewport/scroll drift. Historical autopilot replay also treats malformed or legacy null decision entries as absent evidence rather than dereferencing them.

### `src/settings`

Persists versioned global application settings in `~/.zipflow/settings.json`. Settings are loaded before the TUI starts accepting input, preventing startup keystrokes from saving defaults over persisted values. Before replacing a valid primary file, the store writes `settings.backup.json`; an unreadable primary is restored from that backup. The LLM bearer token is deliberately excluded from both files and resolved through `src/security/credential-store.js`, which uses macOS Keychain or a Linux Secret Service-compatible keyring. Legacy plaintext tokens are migrated and scrubbed only after a protected write succeeds; new token writes have no plaintext fallback. Settings are deliberately separate from project workflows. They include the interface language and custom-pack selection, the local LLM provider, optional bearer token, selected catalog model and loaded instance, separate prompt/summary/commit languages, archive-review mode, change-delivery strategy, failed-check analysis policy, source-ZIP disposition and retention, backup retention, and managed-file recording policy. Migration preserves credentials and archive policy, preserves the legacy single output language for summaries and commit messages, defaults model prompts to English, and defaults the interface to English; users may explicitly choose operating-system language resolution with English fallback.

### `src/security`

`credential-store.js` is the only persistence boundary for LLM bearer tokens. It derives a stable account identifier from the active Zipflow home, uses the native macOS Keychain command or Linux `secret-tool`, and never stores a decryption key in the Zipflow state tree. Unsupported or unavailable secure stores reject token persistence. The implementation protects secrets at rest and against direct filesystem inspection; it does not promise isolation from arbitrary code already executing as the same unlocked operating-system user.

### `src/llm`

Uses provider-specific adapters. LM Studio model metadata comes from the native `/api/v1/models` endpoint, including parameter counts and loaded-instance configuration. `settings-model.js` persists optional per-model load parameters, unloads stale LLM instances, and invokes `/api/v1/models/load` to make the selected configuration active; generation uses only the native `/api/v1/chat` stream, including model-load, prompt-processing, reasoning, message, and error events. Ollama model metadata comes from `/api/ps` and `/api/show`; generation uses its OpenAI-compatible chat-completion stream. Loaded LM Studio instances are resolved before generation and addressed by instance ID. Model metadata, the resolved instance, context configuration, and bearer token are captured once per LLM run and reused by structure review, patch analysis, chunk synthesis, and repair requests; a successful generation is never invalidated by a later metadata refresh. When a loaded instance is selected, generation addresses that instance directly and does not repeat `context_length`; this reuses the same allocation for reviews and compatibility tests instead of asking LM Studio to create another instance. Load-time settings are sent only when a model is not already loaded. API tokens are applied only as authorization headers and are never emitted through Activity events. An `AbortSignal` is threaded through metadata, request, and SSE consumption so `Esc` cancels only LLM generation while the archive plan continues.

`model-info.js` resolves the active or configured context size with a conservative fallback. `patch-budget.js` reserves context for instructions and output, keeps a complete changed-file manifest, and distributes available diff hunks across files. Context overflow and local compute-memory errors trigger progressively smaller-patch retries. `diagnostics.js` stores a bounded, sanitized request/result/error record in the run directory.

`archive-review.js` can compare bounded project/archive trees before change generation. `delivery.js` selects a bounded full patch, an explicit changed-path list, or file-by-file patch batches; adaptive delivery chooses between full-patch and chunked analysis from the discovered context budget. Chunked analysis stores compact notes for each batch and synthesizes them in a final request. Deep review extends the readable response with `assessment`, `confidence`, and concise reasons. `response.js` parses the user-facing section protocol while a hidden JSON-repair request handles models that ignore it or return reasoning-only output. `failure.js` can explain a failed check in a fresh context or with the compact preceding change-review context. LM Studio native requests flatten prior assistant context and the current request into one valid string input because the endpoint does not accept chat-history message objects in `input`. LLM errors remain non-fatal to archive application.

### `src/archive/discovery.js`

Performs the optional recent-archive scan used from archive waiting. It scans only the remembered directory and only regular ZIP files not older than 24 hours. ZIP contents are represented by validated central-directory paths and are never extracted during discovery. `discovery-match.js` compares those paths with the current project, accounts for one common wrapper directory, rewards project markers and exact source-path overlap, and rejects weak generic matches. Candidate selection always re-enters the normal archive-inspection pipeline.

### Input serialization and paste

`src/ui/editor-paste.js` normalizes bracketed or structured paste events into one editor insertion. Multiline editors preserve line breaks; single-line editors flatten them. `src/app/input-action-gate.js` is a controller-owned single-flight boundary for submit and activation actions. It spans the complete asynchronous action, including Git commands, so trailing paste bytes or repeated keys cannot dispatch a second mutation while the first is active.

### Rich code rendering

`src/ui/rich-text.js` separates ordinary text, fenced code, and standalone JSON without changing the stored source text. `src/ui/syntax-render.js` uses the documented Terlio 1.1.3 `highlightSyntaxLines`, `highlightSyntax`, and `SyntaxText` surfaces in that order, adapting their output into Activity lines with a plain-text fallback. Activity, live LLM output, saved raw responses, and model replay all use this shared path.

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
  -> decision mode and dangerous-mode confirmation
  -> deployment policy
  -> deployment command, when applicable
  -> review and atomic workflow replacement
```

Global settings use a two-panel category/detail state machine. The left panel contains stable top-level categories without descriptions. The right panel displays concise `Parameter: value` rows, section headings, and read-only statistics; only actionable rows receive focus. A fixed two-row context dock appears below the focused list, clipping long context instead of changing geometry; full help remains available in a native blocking Terlio help overlay with background dimming and shadow. Short notifications use Terlio's native toast manager. `Tab` switches pane focus, `Enter` or `Space` activates, and returning restores prior category, parameter, and value positions. Dependent controls are omitted or disabled with an explicit reason, and input-like values open in a modal without replacing either panel.

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

Activity messages are typed as information, running state, success, warning, error, user choice, bounded Autopilot decision, run boundary, or final summary. Structured `Key: value` labels are styled with the active accent and expansion instructions are muted. Generated review-coverage blocks stay expanded because they are short and immediately useful; other durable blocks longer than three lines start collapsed with semantic summaries and can be toggled at the current scroll position. Project discovery and the final summary remain expanded. When the reader is above the bottom, appended entries preserve position and expose a full-width clickable unread indicator; streaming replacement does not count every token as a new entry. Live LLM text preserves provider line breaks and is wrapped with Terlio's width-aware text utility before rendering. The current five-stage run position is derived from application state and displayed separately in the header.

Run history is persisted in existing run records rather than a second event database. Its choice pane scales between compact and extended layouts, exposing up to sixteen rows when content and terminal height allow; Page Up/Page Down and Home/End navigate the focused list. Presentation separates archive updates, manual tests, and manual deployments, with independent type and status filters. Archive hashes support duplicate warnings, and workflow `lastRunId` resolves the deliberate repeat-last action. Repeat prefers the managed destination recorded after a move, otherwise the original kept source, and verifies that the selected path still exists before inspection. Every archive plan with zero created, updated, deleted, and conflicting paths is recorded as `no_changes` in all decision modes. This deterministic branch applies source-archive disposition and returns to archive waiting without creating a patch or invoking LLM review, apply, checks, commit, or deployment.

## Run lifecycle

A normal run follows this order:

```text
archive input
  -> project lock
  -> isolated extraction
  -> archive metadata
  -> deterministic plan
  -> no_changes completion when the plan is empty
  -> otherwise persisted changes.patch
  -> optional LLM structure guard or deep patch review
  -> readable streamed local LLM analysis using path, patch, or file-batch delivery
  -> immediate durable verdict and summary in Activity before commit-message selection
  -> deterministic archive age/snapshot shrink review
  -> optional bounded plan-application decision
  -> optional reasoning-draft formatting pass
  -> copyable Activity plan
  -> bulk conflict policy
  -> optional per-file conflict decisions
  -> optional checkpoint
  -> plan freshness verification
  -> backup
  -> transactional apply
  -> checks
  -> optional local LLM failed-check explanation or bounded failed-check decision
  -> optional result commit, eligible amend, or bounded Zipflow-only squash
  -> optional bounded deployment decision and configured deployment
  -> source ZIP keep, move, or delete policy
  -> report
  -> cleanup
```

The project lock spans inspection through completion so two Zipflow processes cannot build and apply stale plans concurrently. Project identity is based on the canonical filesystem path, so aliases such as macOS `/var` and `/private/var` or a symlink cannot create duplicate workflows or bypass the lock.

On-demand deployment can run from the completed screen after run resources have been released. Its result is appended to the existing run report.

## Operation and cancellation model

Only one application-level operation may be active. `OperationManager.begin()` creates an owned `AbortController`, operation identity, kind, label, phase, cancellation state, and optional critical-section callbacks. Phase transitions use `operation.handoff(callback)`, which releases the completed operation before the next phase begins; apply → checks, checks → commit/deployment, commit → deployment, and deployment → finalization therefore cannot overlap in the operation manager. Async archive work, LLM generation and decisions, checks, deployment, model operations, export, cleanup, apply, and rollback consume that signal.

Terlio 1.1.3 still exits on workspace-level `Ctrl+C` before application `onKey` handling, so Zipflow removes the raw `0x03` byte before Terlio parses it and routes that byte directly to the operation manager. A narrow workspace-event interception and process `SIGINT` listener remain as defensive routes; all three enter the same operation manager. The first `Ctrl+C` while an operation is active never exits the process. It requests cancellation and invokes the operation-specific cancel hook. If the operation is inside a critical filesystem section, the request is recorded and delivered after the section reaches a safe boundary. A second interrupt requests force cancellation and terminates only child processes owned by Zipflow. Once the operation finishes and the UI is idle, a later `Ctrl+C` exits normally.

Cancellation is a first-class result, not a generic failure. Apply cancellation restores all touched paths before presenting the cancelled screen. LLM-decision cancellation pauses autonomy and returns to the same manual gate. Tests, deployment, replay, export, and storage operations return to their nearest stable screen.

## Bounded autonomy model

Workflow version 7 stores an immutable autonomy snapshot with one of three profiles: Manual, Guarded, or Full. Profiles expand into capabilities rather than scattering mode-name checks through the code. Guarded uses a higher effective-confidence threshold and excludes failed-check commits, deployment after failed checks, ambiguous conflict resolution, and Git-history rewrite. Full enables those supported capabilities but cannot weaken hard safety rules.

At each supported gate, the app builds structured context and an explicit `allowedActions` list. `src/autonomy/decision-engine.js` asks the selected local model for a strict JSON decision. It validates gate and action identity, normalizes evidence and risk fields, computes effective confidence from coverage, risk, ambiguity, and completeness, and performs one bounded repair request when needed. Invalid, low-confidence, cancelled, unavailable, or state-drifted decisions use a deterministic fallback or return to the manual UI.

The result-commit gate is built from the exact post-apply Git entries for applied paths, separately classified unrelated entries, workflow commit policy, message candidates, and Zipflow-issued eligible rewrite targets. The prompt states that reaching the gate is already a request to decide, so a model cannot treat the absence of an additional user command as evidence for `skip`. Explicit automatic commit policy is executed deterministically before advisory Autopilot selection.

Decision records are persisted before execution with `pending`, `executing`, `executed`, `failed`, or `not-executed` state. Side-effect modules mark transitions and revalidate state immediately before acting. Startup recovery marks unfinished decisions interrupted and never replays them automatically. Git rewrite candidates are generated by Zipflow, limited to eligible unpublished contiguous Zipflow commits, and referenced by application-issued IDs; the model cannot select arbitrary revisions. Deployment always uses the command snapshot already stored in the workflow and never model-generated shell text.

## Safety boundaries

The following rules are enforced below the UI layer:

- archive paths cannot escape extraction root and cannot use absolute, drive-relative, backslash-escape, alternate-data-stream, or Windows device-name forms;
- `.git` cannot arrive from an archive;
- symbolic links, devices, sockets, FIFOs, encrypted entries, and other unsupported special entries are rejected;
- duplicate, case-colliding, Unicode-equivalent, and file-versus-directory parent-conflicting paths are rejected before extraction;
- archive entry count, depth, expanded size, individual size, and compression ratio are bounded;
- the source ZIP, output ZIP, backup files, project descendants, and rollback targets are revalidated against symlink substitution at every side-effect boundary;
- archive control files and the complete `.zipflow/` tree are not applied to the project;
- files matched by `.gitignore` are not created, updated, or deleted;
- an existing `.gitignore` is never rewritten or extended;
- dotfiles and dot-directories are synchronized normally unless protected, ignored, or part of the permanent safety set (`.env`, `.env.*`, `.venv/**`, `.DS_Store`);
- protected and untracked ignored paths are removed from result-commit staging;
- local LLM failures are recorded but cannot block planning or application;
- local LLM archive verdicts and autonomous decisions cannot disable deterministic protections or execute actions outside an application allowlist;
- suspicious archive age or snapshot shrink requires an explicit review decision;
- API tokens are used only in request headers and are not copied into Activity or run reports;
- source archive retention removes only files recorded in Zipflow's archive index;
- files changed after plan review abort application;
- partial application failures trigger automatic restoration;
- rollback refuses paths modified after the run;
- automatic commits refuse pre-existing staged changes;
- deployment uses only the command captured in the workflow snapshot; Manual and Guarded require successful checks, while Full may proceed after failures only through an explicit supported capability and records the run with errors;
- cleanup terminates all active child processes.

The UI may offer less conservative policies, but those policies cannot disable backups, archive path validation, transaction restoration, or child-process ownership.


### Historical autopilot simulation

`settings-autopilot-replay.js` consumes immutable historical run records and derives only gates for which the record contains relevant state: plan application, conflict resolution, failed-check handling, result commit, and deployment. It evaluates Guarded and Full profiles independently using the current model configuration. Profile restrictions are represented as deterministic simulated decisions—for example, Guarded asks the user for conflicts and skips deployment after failed checks—rather than sending impossible actions to the model. Model proposals below the profile confidence threshold are displayed as `ask-user`, matching live autonomy fallback semantics.

The simulator never calls application, Git, backup, archive-disposition, deployment, or run-persistence services. Its only side effect is a cancellable local LLM request and transient UI state. Pure scenario reconstruction and comparison accept an injected decision requester, which keeps the behavior regression-testable without a running provider.

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
- global settings persistence, schema migration, interface-language discovery/validation/fallback, pane-focus navigation, section/stat rendering, and compact descriptions;
- LM Studio and Ollama model metadata, atomic model selection, unload/reload configuration, separate prompt/summary/commit languages, compatibility tests, read-only historical replay, context budgeting, structural patch truncation, adaptive/full/path-list/file-batch delivery, optional authorization, native and OpenAI-compatible streams, readable wrapped progress, context/OOM retries, reasoning-only responses, hidden repair requests, failure explanations, and diagnostics;
- source archive keep, move, delete, statistics, indexed cleanup, retention, and size-limit behavior;
- backup statistics, guarded cleanup, retention by age/size, active-run protection, and rollback availability;
- commit-message editor fallback, typing, deletion, atomic multiline paste, and duplicate-submit single-flight behavior;
- recent archive discovery age filtering, central-directory-only matching, wrapper normalization, weak-match rejection, cancellation, and normal-inspection handoff;
- Terlio 1.1.3 fenced-code and streaming/standalone JSON syntax routing;
- patch creation from archive-versus-snapshot changes;
- managed-file recording policy, guarded deletion scope, and separate clear action;
- Git initialization, ignore generation, and first commit;
- all four ZIP export modes;
- copyable and collapsible Activity, readable LLM streaming, final-summary ordering, and native-selection fallback;
- bulk-before-manual conflict UX and one-file conflict queues;
- unified and side-by-side file diff rendering with hunk navigation;
- compact workflow home, five-stage run progress, duplicate/old/shrinking archive warnings, performance analytics, and persisted run history;
- ZIP preview and post-create actions;
- typed Activity and TUI rendering;
- operation-aware first/second `Ctrl+C`, critical-section cancellation, child-process force stop, and stable cancellation recovery;
- Manual, Guarded, and Full autonomy profiles, historical Guarded-versus-Full simulation, structured allowlists, confidence degradation, repair/fallback, state drift, paused decisions, execution-state audit, and restart recovery;
- safe amend/squash candidate generation limited to eligible unpublished Zipflow commits;
- malicious ZIP symbolic links and special entries, traversal variants, Unicode/case collisions, path-type conflicts, compression bombs, existing project symlink directories, output/backup symlink substitution, protected deletion, and source-archive replacement.

## Public dependency lock URLs

`package-lock.json` is part of the distributable source archive and must retain public `https://registry.npmjs.org/` tarball URLs. Local CI, proxy, or private mirror URLs must never be committed into the lockfile.


### Terminal navigation invariants

- `Esc` navigates backward or cancels the active sub-process; it never exits from the top-level project menu. `Ctrl+C` cancels the single active operation first and exits only when the application is idle; `Exit` remains explicit.
- Path completion is an overlay. Archive input shows aligned `DIR` and `ZIP` markers and never submits a selected completion until the user confirms the completed path separately. With an empty field, the first `Enter` only arms discovery and the second press within 1.5 seconds scans the remembered folder; neither press can race another activation.
- The framed project Activity message calculates all borders from one visible inner width. Complete historical patches use semantic diff coloring inside Activity.
- The completed-run menu exposes one primary action for returning to archive waiting, avoiding synonymous duplicate actions.

## Release versioning

The current public release is `1.1.1`. The application follows semantic versioning beginning with `1.0.0`. Compatible fixes and small improvements increment patch (`1.0.x`); substantial backward-compatible features increment minor (`1.x.x`); incompatible changes require a major increment. `package.json`, the root package record in `package-lock.json`, and `src/version.js` are kept identical and verified by tests.

## LM Studio model identity

Zipflow keeps the persisted catalog model key and the selected loaded instance ID separate. The catalog key remains the stable configuration identity. When `loaded_instances[].id` is available, it is stored in `llmSelectedInstanceId`, resolved against the current catalog, and sent to `POST /api/v1/chat` so every review and compatibility request reuses the exact loaded instance. No `context_length` override is included for an already loaded instance. If the instance is stale or absent, Zipflow falls back to the catalog key and may let the provider load the model using the saved configuration.
