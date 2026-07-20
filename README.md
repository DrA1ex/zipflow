# Zipflow

Zipflow is an interactive terminal application for safely applying ZIP archives with source updates to local projects.

It is designed for the workflow where an archive is generated after each development iteration and must be merged into an existing working tree, checked, optionally committed, deployed, and sometimes rolled back.

Zipflow has one user-facing entry point:

```bash
zipflow
```

There are no command submodes. Project setup, archive application, checks, commits, deployment, reports, settings, and rollback are handled inside the interactive interface.

## Requirements

- Node.js 20 or newer
- macOS or Linux
- Git is recommended but not required
- A terminal with TTY support

## Install from the source directory

```bash
npm install
npm link
```

Then open a project and start Zipflow:

```bash
cd ~/dev/my-project
zipflow
```

## First launch

Zipflow determines the current project root, scans its project files, and prepares a recommended workflow.

Project detection is recorded as a framed **Project detected** block in Activity. It contains the canonical root, detected technologies, Git state, workflow state, archive mode, selected checks, policy, commit behavior, and deployment behavior. It does not reserve permanent screen space and remains available through Activity scrolling.

If the directory is not a Git repository, Zipflow first offers to initialize it. After `git init`, it can create a project-aware `.gitignore` only when the file does not already exist, and then add the existing non-ignored files to a first commit. An existing `.gitignore` is always preserved byte-for-byte. Continuing without Git remains possible.

The wizard explains the purpose of each stage and lets you review:

- detected project technologies;
- automatically discovered checks;
- custom validation commands;
- archive interpretation and snapshot deletion rules;
- conflict and checkpoint behavior;
- result commit behavior and message source;
- optional deployment after successful checks.

Recommended choices are already selected. The wizard saves the workflow only after the final confirmation. Starting setup again never removes the current workflow before its replacement is successfully saved.

Dotfiles and dot-directories are ordinary project paths. Zipflow synchronizes paths such as `.github/`, `.config/`, and other dot-prefixed files unless the project's existing `.gitignore` excludes them. A small permanent safety set remains enabled for every workflow: `.env`, `.env.*`, `.venv/**`, and `.DS_Store`. Protected `.git/`, `.zipflow/`, and supported archive control files are also never applied.

## Daily project screen

For an existing workflow, Zipflow starts directly in archive-waiting mode. The framed **Project detected** Activity block contains the selected archive mode, checks, conflict policy, commit behavior, and deployment policy without consuming vertical space in the action pane. A separate startup hint explains that `Esc` opens the compact project menu when you need **Change workflow**, history, ZIP export, or other project actions.

Change workflow keeps `Continue` selected when each wizard page opens, and returns focus there after a setting is changed. This makes a one-setting adjustment quick while the complete selected configuration remains visible in the final review. The saved workflow remains active until the changed workflow is confirmed and saved.

The project menu also provides:

- **Repeat last archive** to rebuild the previous plan against the current project;
- **Run history** to inspect earlier decisions, checks, commits, deployment, archive disposition, and rollback state;
- **Create ZIP** with a preview before writing the archive.

During an update, the header shows the current five-stage progression:

```text
Archive -> Review -> Apply -> Checks -> Finish
```

Activity entries use stable `INFO`, `RUN`, `DONE`, `WARN`, `FAIL`, `YOU`, and `SUM` roles so current work, completed work, problems, user decisions, and the final result remain distinguishable. Any durable block longer than three lines starts collapsed with a visible arrow; scroll to it and press `E` to expand or collapse it. Project discovery and the final summary stay expanded. Long-running LLM and check steps explain what result is expected before they start.

## Supported project workflows

Zipflow detects Node.js, TypeScript, Python, CMake/C++, Go, Swift Package Manager, and macOS Xcode projects. Swift projects receive `swift test`, `swift build`, and inferred macOS `xcodebuild` checks. The inferred Xcode scheme can be reviewed or replaced in the workflow.

The project scanner also inspects `./scripts`. Check-like scripts are offered in the checks step, while deploy/release/publish-like scripts are prioritized as deployment choices. Other runnable scripts remain available as optional choices, and a custom command can always be entered.

## Checks and custom commands

Detected checks are shown as a multi-select list. `Space` or `Enter` toggles a check.

When adding a custom check, Zipflow first asks for the exact command and then asks for the short name displayed in the workflow and run results. Custom checks can later be edited or removed from the same list.

## Applying an archive

For a configured project, drag a ZIP file into the initial archive prompt or enter its path. Path input scans the entered location while you type and shows multiple matching directories and ZIP files in an overlay without shifting the layout. Use `Up`/`Down` to select a suggestion and `Tab` or `Enter` to insert it. A directory opens its contents; a ZIP file only fills the path. Press `Enter` again to submit the completed path, so completion never starts an update unexpectedly. Existing directory paths also expose an explicit **Use this directory** action in directory pickers. 
The completion overlay uses leading folder and file markers instead of trailing type descriptions, keeping names aligned and easy to scan.

Press `Esc` to return to the project menu. After a completed run, **Finish and wait for next archive** returns directly to the same prompt.

Zipflow performs the following sequence:

1. Extracts the archive into an isolated temporary directory.
2. Rejects unsafe paths, symbolic links, `.git` entries, duplicate paths, and suspicious archive sizes.
3. Detects a wrapper project directory only when it contains project markers.
4. Reads optional archive metadata such as the result commit message.
5. Compares archive files with the current project by content hash.
6. Writes a unified `changes.patch` representing the archive against the pre-apply local snapshot.
7. Optionally asks the configured local LLM to validate the archive structure or deeply review the patch while generating a concise summary and proposed commit message.
8. Evaluates deterministic archive-age and snapshot-shrink warnings before application.
9. Writes a copyable Activity summary with every created, updated, deleted, preserved, and skipped path.
10. Creates a path-specific backup before changing the project.
11. Verifies that files have not changed since the plan was shown.
12. Applies the selected changes as a recoverable transaction.
13. Runs the configured checks.
14. Optionally creates a result commit and runs deployment.
15. Offers a report or rollback when appropriate.

If application fails after touching files, Zipflow restores every affected path from the backup before reporting the error.

## Conflict behavior

Uncommitted changes do not block an update by themselves.

A conflict is reported only when the archive would update or delete a path that currently has a Git change. Unrelated local changes are left alone. If the current file already has exactly the same content as the archive, it is classified as unchanged rather than conflicting.

When conflicts exist, Zipflow first presents bulk choices: replace every conflict, keep every local conflict, choose files manually, or cancel and select the archive again. Manual review then advances one file at a time. Each file can keep the local version, use the archive version, apply the same decision to the remaining conflicts, or open a diff before deciding. An optional checkpoint commit can preserve affected local files immediately before archive versions are used.

The normal plan screen stays compact: counts for added, changed, removed, unchanged, ignored, preserved, and conflicting paths. **Review changes** opens grouped details with explicit reasons for skipped and preserved files. Text changes can be viewed as either a unified diff or, when the terminal is wide enough, a side-by-side diff. Distant changes are split into hunks; `N`/`]` and `P`/`[` move between them without losing the current file or diff mode. The mouse wheel scrolls the diff directly, alongside line, page, Home, and End keyboard navigation. Binary and oversized files receive a safe informational comparison instead of being rendered as terminal text.



## Archive safety review

Zipflow compares the source ZIP with recent successful runs for the same project. Before any project file changes, it warns when:

- the ZIP modification time is materially older than the last applied archive;
- snapshot mode would delete at least ten paths and a large fraction of the existing managed scope;
- a snapshot contains far fewer files than the previous applied archive.

Warnings show the measured counts and ratios. The user can review changed files and diffs, continue explicitly, or choose another archive. A local LLM `suspicious` or `unsuitable` verdict appears on the same screen with its reasons, clearly marked as advisory.

## Archive modes

### Overlay archive

Files present in the archive are created or updated. Files missing from the archive remain untouched.

This is the default mode.

### Full project snapshot

The archive represents the managed project contents. Missing files may be deleted.

The safe default removes only clean Git-tracked files. A second policy removes only paths that previous Zipflow runs created or updated. This managed-file history can be reset from `Ctrl+B` without changing project files. Untracked or unmanaged files absent from the archive remain in place and are explicitly reported as preserved. An advanced option can include all files inside the managed scope. Protected and excluded paths are never removed.

## Commit message from the archive

The preferred metadata path is:

```text
.zipflow/commit-message.txt
```

Legacy names remain readable for compatibility:

```text
.zipflow/commit_message.txt
.commit_message
.commit_message.txt
commit_message.txt
COMMIT_MESSAGE
COMMIT_MESSAGE.txt
```

Metadata files are never copied into the project. In fact, the entire `.zipflow/` tree is protected from archive application. Multi-line commit messages are supported.

When archive metadata is selected and no supported file exists, Zipflow falls back to:

```text
zipflow: apply <run-id>
```

Other supported message sources are the archive filename, a generated run identifier, and a configurable fixed template.


## Local LLM summaries and commit messages

Zipflow supports Ollama and LM Studio with provider-specific adapters. LM Studio uses its native model catalog and streaming chat API so Zipflow can read model parameter counts, loaded-instance configuration, context size, and model-load or prompt-processing progress. The model list keeps unloaded entries compact and marks loaded entries with their active context. Selecting an LM Studio model opens a configuration page with the primary **Use this model** action selected. Unloaded models allow load-time tuning for context length, evaluation batch size, Flash Attention, KV-cache placement, and expert count when supported. Loaded models retain their load-time settings but allow a Zipflow request-context override. Saved choices are shown beside the model on later visits. Ollama uses its native model metadata endpoints to discover the active or configured context size, then uses its OpenAI-compatible chat-completion stream for generation. Configure the provider, optional bearer token, model, and response language in `Ctrl+B` settings.

Default local endpoints:

```text
Ollama:    http://127.0.0.1:11434
LM Studio: http://127.0.0.1:1234
```

The **Archive review** setting controls whether the model also judges archive suitability:

- **Summary only** generates a summary and commit message without an advisory verdict;
- **Structure guard** first compares the current project and archive directory/file trees, then labels the archive `suitable`, `suspicious`, or `unsuitable`;
- **Deep patch review** returns the advisory assessment, reasons, summary, and commit message from the selected change representation.

The separate **Change delivery** setting controls what source-change evidence reaches the model:

- **Adaptive** sends a bounded full patch when it fits and automatically switches to file-by-file analysis for larger changes;
- **Full patch** sends one context-budgeted `changes.patch` request;
- **Changed paths only** sends only explicit `CREATE`, `UPDATE`, and `DELETE` path records, without file contents;
- **File-by-file chunks** analyzes small groups of file patches in separate bounded requests and then synthesizes their notes into one final summary and commit message.

The **Failed checks** setting can leave failures untouched, explain them in a fresh model context, or continue from the compact context of the preceding change review. The same-context mode does not resend the entire patch; it supplies the prior review result together with the failed command and output.

The verdict is advisory. It can force an explicit safety-review screen but never replaces deterministic path validation, `.gitignore`, Git conflict detection, backups, or tests. A strongly unsuitable structure verdict stops further patch summarization for that request and explains why the archive appears unrelated.

When enabled, every inspected archive with content changes produces:

- `~/.zipflow/runs/<run-id>/changes.patch`;
- an optional proposed commit message stored in the JSON and text run reports;
- an immediate expanded Activity block with the archive-suitability verdict, confidence, reasons, and summary before commit-message selection;
- a final Activity summary placed after checks, commit, and deployment, followed by one compact checks/deployment line.

The first durable LLM result is available as soon as archive analysis finishes, so the proposed commit message can be judged against the visible summary. The final block repeats the useful conclusion beside the actual check and deployment outcome. If no local model is enabled or generation is cancelled, the final block still contains the concise check result.

The system and user prompts are always English. The selected language applies only to generated user-facing text. Primary generation uses a readable text protocol with `SUMMARY`, `COMMIT MESSAGE`, and optional assessment sections. Activity streams only human-readable reasoning and response text, preserves model line breaks, and wraps long lines to the current Terlio pane width; internal JSON repair is hidden from Activity. The view also shows the exact transport and endpoint, model-load progress, prompt-processing progress when the provider exposes it, elapsed time, delivery mode, and current file batch. Press `Esc` during generation to cancel only the local LLM request; archive analysis then continues with the normal commit-message fallbacks.

Before generation, Zipflow discovers the model context size and loaded instances when possible and calculates a conservative prompt budget. For LM Studio, an already loaded instance ID is used directly, so Zipflow does not intentionally load a duplicate model. A saved request-context override is sent to the native chat endpoint without repeating the model-load request. The prompt budget reserves space for instructions and output. The complete `changes.patch` remains stored in the run, while the model receives a structurally shortened patch when necessary: the complete changed-file manifest is retained and diff hunks are distributed across files instead of cutting text at an arbitrary byte boundary. Zipflow also caps the effective prompt context conservatively to reduce local GPU-memory pressure. Context-overflow and out-of-memory responses trigger a smaller-patch retry and are reported explicitly rather than as `No usable output`.

Zipflow parses the readable section protocol and validates the resulting summary, commit message, and optional verdict. If a model ignores the requested format or spends its output budget on reasoning, Zipflow performs a hidden compact JSON-repair request against the generated draft. If only a useful summary can be recovered, that summary is kept while the commit message uses the configured fallback. Provider errors and sanitized raw diagnostics are saved in `~/.zipflow/runs/<run-id>/llm-diagnostics.json`. Local LLM failures never block archive application.

The workflow commit-message source can be set to **Local LLM**. It uses the generated message first, then `.zipflow/commit-message.txt`, then `zipflow: apply <run-id>`.

## Git commits

Zipflow separates two commit purposes:

- a checkpoint commit before conflicting local changes are overwritten;
- a result commit after required checks pass.

Each purpose is configured on its own wizard step. Result commit message settings are shown only when result commits are enabled.

Result commits stage only paths applied by the current run. Protected `.zipflow/` paths and untracked paths ignored by Git are filtered before staging, so archive metadata cannot break a commit. Pre-existing staged changes block automatic commits so Zipflow cannot accidentally include unrelated index contents. No push is performed.

## Manual project actions

For a configured workflow, the project menu exposes **Run tests** when checks are selected and **Run deployment** when a deploy command is configured. These actions operate on the current local project without applying an archive. Each action writes a normal text and JSON run report and appears in run history.

When a manual check or deployment fails and local LLM failure analysis is configured, Zipflow offers **Explain error with local LLM**. It never runs automatically from the project menu; selecting it is required. The automatic post-upload behavior remains controlled by the existing workflow settings.

## Deployment

Deployment is a separate post-check action, not a validation check. It runs only after every required check has passed and after the optional result commit step.

A workflow can configure one shell command with one of these policies:

- **Ask** — offer to run it after successful checks;
- **Always** — run it automatically;
- **On demand** — keep a **Run deployment** action on the successful result screen;
- **Disabled** — do not configure deployment.

Deployment stdout, stderr, exit code, and duration are saved in the run report. A failed deployment does not silently roll back local files because the command may already have changed an external system.

## Global settings

Press `Ctrl+B` to open global settings. The two-panel layout remains visible at every level: compact category names stay on the left and the selected category page stays on the right. Categories that contain one direct choice, such as **Theme**, **Running checks**, and **Managed history**, show their options immediately instead of adding a redundant parameter step. Multi-parameter categories show concise `Parameter: value` rows without inline help text. Selecting one temporarily replaces only the right panel with its choices and a short explanation, focused on the current value. `Enter` applies the value and `Esc` cancels it; both preserve the originating selection. Text, secret, path, and numeric values open in compact modal dialogs over both panels, with placeholders, validation, and unit hints where applicable.

Current settings include:

- any semantic theme shipped by Terlio: Dark, Mono, Amber, Ocean, Forest, Synth, Slate, Paper, or Matrix;
- compact running-check output or the latest non-empty command output line;
- local LLM provider: Disabled, Ollama, or LM Studio;
- an optional bearer token used for both model discovery and generation;
- a model fetched from the selected server's model list;
- the language used for generated summaries and commit messages;
- the post-run source ZIP policy: leave in place, move to archive storage, or delete;
- archive directory, retention period in days, and maximum managed archive size when move mode is enabled;
- a guarded action to reset the current project's managed-file history.

Settings are saved immediately in:

```text
~/.zipflow/settings.json
```


## Source ZIP policy

Global settings control what happens to the uploaded source archive after an update is kept:

- **Do nothing** — the default; leave the ZIP where it was selected;
- **Move to archive storage** — move it to `~/zipflow-archive` by default;
- **Delete source ZIP** — remove it after completion.

Move mode creates its directory when selected or first used. Its directory, retention, and size controls appear in the same right-hand pane as the move policy. Retention accepts whole days; maximum size accepts B, KB, MB, GB, KiB, MiB, or GiB. The default retention is 30 days and the default maximum size is 1 GB. Cleanup removes the oldest entries first, but it only touches archives recorded in Zipflow's own archive index. Unrelated files in the same directory are never deleted. Cancelled runs, failures before application, and rollbacks before a run is kept do not consume the source archive.

## Supported project detection

### Node.js and TypeScript

Zipflow reads `package.json`, detects the package manager, discovers relevant scripts, and can run changed-file JavaScript syntax checks. TypeScript checks are suggested when a local compiler or project script is available.

### Python

Zipflow detects common Python project files, selects a virtual-environment interpreter when available, checks changed Python files with `py_compile`, and suggests pytest when tests are detected.

### CMake

Zipflow detects CMake projects and suggests configure, build, and test commands for projects without presets. Projects with presets can add their preferred preset commands as custom checks.

### Go

Zipflow suggests formatting, vet, test, and build checks.


## Run history and repeated archives

Every run stores its archive hash, archive metadata, safety warnings, LLM assessment, user decisions, plan, checks, commit, deployment, archive disposition, and rollback status. The project home exposes a compact history list and allows opening the full run details.

**Performance analytics** aggregates recent history with medians, averages, success rates, minimum/maximum duration, and a recent trend for each check and each provider/model pair. It also reports how often LLM inputs were reduced and the average number of generation attempts. Previous medians are used as estimates while checks and LLM analysis are running.

If the same archive hash has already been applied, Zipflow shows the previous result before continuing. **Repeat last archive** deliberately bypasses that duplicate guard and rebuilds the plan against the current working tree, which is useful after changing workflow settings or resolving an external problem.

## Creating a ZIP

The project home includes **Create ZIP** with four modes:

- **Only Git-tracked files** — the smallest Git-based source snapshot;
- **All files except ignored** — tracked and untracked files except paths matched by `.gitignore`;
- **Choose top-level items** — an interactive list of project folders and files, expanded recursively after selection;
- **All project files** — includes ignored files too.

`.git/` and `.zipflow/` are protected in every mode and never appear in the interactive top-level list. The default output path is outside the project so an archive cannot include itself.

## Rollback

Rollback restores the exact contents that existed immediately before the run. It does not reset the project to Git `HEAD` and does not rewrite Git history.

Rollback is blocked if an affected path changed after the run, because overwriting newer work would be unsafe.

## Storage

Zipflow stores user data under:

```text
~/.zipflow/
  settings.json
  archive-index.json
  workflows/
  runs/
  backups/
  projects/
    <project-id>/managed-files.json
  tmp/
  locks/
```

Set `ZIPFLOW_HOME` to use a different location, for example in tests or an isolated environment.

## Controls

Context-sensitive `?` help adds a short explanation for the currently selected action to Activity. Diff review also exposes direct local shortcuts for archive/local decisions, while every action remains available through the normal menu.


```text
↑ / ↓       move through choices
Space       toggle or select the current option
Enter       select, toggle, continue, or submit an editor
Ctrl+Enter  insert a new line in the commit-message editor
Esc         go back
Tab         complete paths or open the selected settings category
← / →       return from or open a settings category
Page Up     scroll activity upward
Page Down   scroll activity downward
Ctrl+B      open or close global settings
Ctrl+T      toggle native terminal text selection
Ctrl+C      stop safely and terminate active child processes
```

Activity supports in-app drag selection while pointer controls remain active. Click an existing highlight to copy it. Press `Ctrl+T` to temporarily restore the terminal emulator's native text selection for any other UI region; press it again to restore interactive pointer controls.

## Development

```bash
npm install
npm run verify
```

`npm run verify` performs syntax checks, enforces the 1,000-line hard limit for JavaScript files, warns above the preferred 500-line limit, and runs the automated test suite.

The codebase keeps every JavaScript file below 500 lines.
