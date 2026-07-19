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

If the directory is not a Git repository, Zipflow first offers to initialize it. After `git init`, it can create or extend a project-aware `.gitignore` and then add the existing non-ignored files to a first commit. Continuing without Git remains possible.

The wizard explains the purpose of each stage and lets you review:

- detected project technologies;
- automatically discovered checks;
- custom validation commands;
- archive interpretation and snapshot deletion rules;
- conflict and checkpoint behavior;
- result commit behavior and message source;
- optional deployment after successful checks.

Recommended choices are already selected. The wizard saves the workflow only after the final confirmation. Starting setup again never removes the current workflow before its replacement is successfully saved.

## Checks and custom commands

Detected checks are shown as a multi-select list. `Space` or `Enter` toggles a check.

When adding a custom check, Zipflow first asks for the exact command and then asks for the short name displayed in the workflow and run results. Custom checks can later be edited or removed from the same list.

## Applying an archive

Choose **Start an update**, then drag a ZIP file into the terminal or enter its path.

Zipflow performs the following sequence:

1. Extracts the archive into an isolated temporary directory.
2. Rejects unsafe paths, symbolic links, `.git` entries, duplicate paths, and suspicious archive sizes.
3. Detects a wrapper project directory only when it contains project markers.
4. Reads optional archive metadata such as the result commit message.
5. Compares archive files with the current project by content hash.
6. Writes a unified `changes.patch` representing the archive against the pre-apply local snapshot.
7. Optionally sends that patch to the configured local LLM for a concise summary and proposed commit message.
8. Writes a copyable Activity summary with every created, updated, deleted, preserved, and skipped path.
9. Creates a path-specific backup before changing the project.
10. Verifies that files have not changed since the plan was shown.
11. Applies the selected changes as a recoverable transaction.
12. Runs the configured checks.
13. Optionally creates a result commit and runs deployment.
14. Offers a report or rollback when appropriate.

If application fails after touching files, Zipflow restores every affected path from the backup before reporting the error.

## Conflict behavior

Uncommitted changes do not block an update by themselves.

A conflict is reported only when the archive would update or delete a path that currently has a Git change. Unrelated local changes are left alone. If the current file already has exactly the same content as the archive, it is classified as unchanged rather than conflicting.

When conflicts exist, Zipflow first presents bulk choices: replace every conflict, keep every local conflict, choose files manually, or cancel and select the archive again. Per-file decisions appear only after **Choose files manually**. An optional checkpoint commit can preserve affected local files immediately before archive versions are used.

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

Zipflow can use either Ollama or LM Studio through their shared OpenAI-compatible HTTP surface. Configure the provider, optional bearer token, model, and response language in `Ctrl+B` settings.

Default local endpoints:

```text
Ollama:    http://127.0.0.1:11434/v1
LM Studio: http://127.0.0.1:1234/v1
```

When enabled, every inspected archive with content changes produces:

- `~/.zipflow/runs/<run-id>/changes.patch`;
- a short Activity summary;
- a proposed commit message stored in the JSON and text run reports.

The system and user prompts are always English. The selected language applies only to the generated summary and commit message. Zipflow uses a streaming request, so Activity shows the elapsed time, received chunks, the current model draft, and the structured answer as it arrives. Both `reasoning_content` and `reasoning` streams are understood.

Zipflow requests structured JSON and validates both fields before using them. If a reasoning model consumes its output budget before producing JSON, Zipflow performs a second compact formatting request against the generated draft. If only a useful summary can be recovered, that summary is kept while the commit message uses the configured fallback. Local LLM failures never block archive application.

The workflow commit-message source can be set to **Local LLM**. It uses the generated message first, then `.zipflow/commit-message.txt`, then `zipflow: apply <run-id>`.

## Git commits

Zipflow separates two commit purposes:

- a checkpoint commit before conflicting local changes are overwritten;
- a result commit after required checks pass.

Each purpose is configured on its own wizard step. Result commit message settings are shown only when result commits are enabled.

Result commits stage only paths applied by the current run. Protected `.zipflow/` paths and untracked paths ignored by Git are filtered before staging, so archive metadata cannot break a commit. Pre-existing staged changes block automatic commits so Zipflow cannot accidentally include unrelated index contents. No push is performed.

## Deployment

Deployment is a separate post-check action, not a validation check. It runs only after every required check has passed and after the optional result commit step.

A workflow can configure one shell command with one of these policies:

- **Ask** — offer to run it after successful checks;
- **Always** — run it automatically;
- **On demand** — keep a **Run deployment** action on the successful result screen;
- **Disabled** — do not configure deployment.

Deployment stdout, stderr, exit code, and duration are saved in the run report. A failed deployment does not silently roll back local files because the command may already have changed an external system.

## Global settings

Press `Ctrl+B` to open a two-pane settings panel. These settings are global and apply to every project.

Current settings include:

- any semantic theme shipped by Terlio: Dark, Mono, Amber, Ocean, Forest, Synth, Slate, Paper, or Matrix;
- compact running-check output or the latest non-empty command output line;
- local LLM provider: Disabled, Ollama, or LM Studio;
- an optional bearer token used for both model discovery and generation;
- a model fetched from the selected server's model list;
- the language used for generated summaries and commit messages;
- the post-run source ZIP policy: leave in place, move to archive storage, or delete;
- archive directory, retention period, and maximum managed archive size when move mode is enabled;
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

Move mode creates its directory when selected or first used. The default retention is 30 days and the default maximum size is 1 GB. Cleanup removes the oldest entries first, but it only touches archives recorded in Zipflow's own archive index. Unrelated files in the same directory are never deleted. Cancelled runs, failures before application, and rollbacks before a run is kept do not consume the source archive.

## Supported project detection

### Node.js and TypeScript

Zipflow reads `package.json`, detects the package manager, discovers relevant scripts, and can run changed-file JavaScript syntax checks. TypeScript checks are suggested when a local compiler or project script is available.

### Python

Zipflow detects common Python project files, selects a virtual-environment interpreter when available, checks changed Python files with `py_compile`, and suggests pytest when tests are detected.

### CMake

Zipflow detects CMake projects and suggests configure, build, and test commands for projects without presets. Projects with presets can add their preferred preset commands as custom checks.

### Go

Zipflow suggests formatting, vet, test, and build checks.


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

```text
↑ / ↓       move through choices
Space       toggle or select the current option
Enter       select, toggle, continue, or submit an editor
Ctrl+Enter  insert a new line in the commit-message editor
Esc         go back
Tab         complete paths or switch settings panes
← / →       switch settings panes
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
