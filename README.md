# Zipflow

Zipflow is an interactive terminal application for safely applying ZIP archives with source-code updates to local projects.

It is built for development workflows where each iteration arrives as an archive and must be reviewed, merged into the current working tree, validated, optionally committed, deployed, and sometimes rolled back.

Zipflow has one command:

```bash
zipflow
```

Project setup, archive review, conflict resolution, checks, commits, deployment, history, export, and rollback are all handled inside the interactive interface.

## Highlights

- Reviews an archive before changing the project.
- Shows created, updated, deleted, preserved, ignored, and conflicting paths.
- Supports overlay archives and full-project snapshots.
- Applies changes as a recoverable transaction with path-specific backups.
- Detects conflicts only on paths changed by both the archive and the local working tree.
- Runs project-aware checks and an optional deployment command.
- Creates optional checkpoint and result commits without staging unrelated work.
- Can summarize changes and explain failures through Ollama or LM Studio.
- Keeps run history, reports, stored patches, and rollback metadata.
- Creates project ZIP archives with a reviewable file selection.

## Requirements

- Node.js 20 or newer
- macOS or Linux
- A terminal with TTY support
- Git is recommended, but not required

## Installation

### Install from npm

Install Zipflow globally so the `zipflow` command is available from any project directory:

```bash
npm install --global zipflow
```

Update to the latest published version:

```bash
npm install --global zipflow@latest
```

Remove it:

```bash
npm uninstall --global zipflow
```

### Link a local source checkout

Use `npm link` when developing Zipflow or running an unpublished checkout:

```bash
cd /path/to/zipflow
npm install
npm link
```

The global `zipflow` command now points to that checkout:

```bash
cd /path/to/project
zipflow
```

Remove the global link when it is no longer needed:

```bash
npm unlink --global zipflow
```

## Quick start

Open the project you want to update and start Zipflow:

```bash
cd ~/dev/my-project
zipflow
```

On the first launch, Zipflow detects the project, discovers suitable checks and deployment commands, and opens a setup wizard. Recommended choices are preselected and nothing is saved until the final confirmation.

For later runs, Zipflow opens directly in archive-waiting mode:

1. Drag a ZIP file into the terminal or enter its path.
2. Review the detected archive root, changed paths, warnings, conflicts, and diffs.
3. Choose how conflicts should be handled.
4. Apply the update.
5. Run configured checks, optionally commit and deploy, then keep or roll back the result.

The main run progression is:

```text
Archive -> Review -> Apply -> Checks -> Finish
```

## Archive modes

**Overlay archive** is the default. Files present in the archive are created or updated, while files missing from the archive remain untouched.

**Full project snapshot** treats the archive as the managed project contents. Missing files may be deleted according to the configured policy. Protected, ignored, sensitive, untracked, or unmanaged paths remain preserved unless an explicit advanced policy allows otherwise.

See [Archive workflows](docs/archive-workflows.md) for root detection, archive metadata, snapshot policies, duplicate handling, and review behavior.

## Safety model

Before changing the project, Zipflow:

- extracts into an isolated temporary directory;
- rejects unsafe paths, symbolic links, duplicate entries, `.git` contents, and suspicious archive sizes;
- compares files by content hash;
- records a unified patch and run report;
- checks for local conflicts and stale plans;
- creates a backup of every affected path.

If applying changes fails after files were touched, Zipflow restores the affected paths automatically. A later rollback is allowed only while those paths still match the state produced by the run, so newer work is not overwritten silently.

The `.git/` and `.zipflow/` trees are always protected. Permanent local-safety exclusions include `.env`, `.env.*`, `.venv/**`, and `.DS_Store`.

See [Safety, conflicts, and rollback](docs/safety.md) for the complete behavior.

## Supported projects

Zipflow detects and proposes checks for:

- Node.js and TypeScript
- Python
- CMake and C++
- Go
- Swift Package Manager
- macOS Xcode projects

It also inspects project scripts for test, check, deploy, release, and publish commands. Every detected command can be reviewed, replaced, or supplemented with a custom command.

See [Project detection and checks](docs/project-detection.md).

## Local LLM integration

Zipflow can use a local Ollama or LM Studio model to:

- assess whether an archive appears suitable for the current project;
- summarize source changes;
- propose a commit message;
- explain failed checks or deployment output.

Model output is advisory. It never replaces deterministic path validation, Git conflict detection, backups, or tests. Local model failures do not block archive application.

See [Local LLM integration](docs/local-llm.md) for providers, delivery modes, prompt budgeting, replay, and diagnostics.

## Project actions

Press `Esc` from the archive prompt to open the project menu. Depending on the configured workflow, it provides:

- **Change workflow**
- **Repeat last archive**
- **Run history**
- **Run tests**
- **Run deployment**
- **Create ZIP**
- **Exit**

Global settings are available with `Ctrl+B`.

## Essential controls

```text
↑ / ↓       move through choices
Space       toggle or select the current option
Enter       open, continue, or submit
Esc         go back or open the project menu
Tab         complete paths or switch Settings panes
Page Up     scroll upward
Page Down   scroll downward
End         return to the latest Activity entry
Ctrl+B      open or close global settings
Ctrl+T      toggle native terminal text selection
Ctrl+C      stop safely and terminate active child processes
```

Context-sensitive help is available with `?`. Diff review and text editors expose additional shortcuts when active.

See [Interface and controls](docs/controls.md) for the complete reference.

## Data and storage

Zipflow stores its settings, workflows, reports, patches, backups, and managed-file history under:

```text
~/.zipflow/
```

Set `ZIPFLOW_HOME` to use another location, including an isolated directory for tests.

Source archives are left in place by default. Settings can instead move successfully applied archives to managed storage or delete them after completion. Backup and archive retention are configured separately.

See [Settings, history, and storage](docs/settings-and-storage.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Archive workflows](docs/archive-workflows.md)
- [Safety, conflicts, and rollback](docs/safety.md)
- [Project detection and checks](docs/project-detection.md)
- [Local LLM integration](docs/local-llm.md)
- [Settings, history, and storage](docs/settings-and-storage.md)
- [Interface and controls](docs/controls.md)
- [Development](docs/development.md)
- [Architecture](ARCHITECTURE.md)

## Development

```bash
npm install
npm run verify
```

`npm run verify` runs source checks and the automated test suite. See [Development](docs/development.md) for local linking, repository checks, packaging, and project conventions.

## License

MIT
