# Zipflow

Zipflow is an interactive terminal application for safely applying ZIP archives with source-code updates to local projects.

It is built for development workflows where each iteration arrives as an archive and must be reviewed, merged into the current working tree, validated, optionally committed, deployed, and sometimes rolled back.

Zipflow has one command:

```bash
zipflow
```

Project setup, archive review, conflict resolution, checks, commits, deployment, history, export, autopilot, and rollback are all handled inside the interactive interface.

## Highlights

- Reviews an archive before changing the project.
- Shows created, updated, deleted, preserved, ignored, and conflicting paths.
- Supports overlay archives and full-project snapshots.
- Applies changes as a recoverable transaction with path-specific backups.
- Revalidates project paths during planning, backup, apply, and rollback.
- Detects conflicts only on paths changed by both the archive and the local working tree.
- Runs project-aware checks and an optional deployment command.
- Creates optional checkpoint and result commits without staging unrelated work.
- Can summarize changes, explain failures, and make bounded workflow decisions through Ollama or LM Studio.
- Supports Manual, Guarded autopilot, and explicitly dangerous Full autopilot decision modes.
- Keeps run history, reports, stored patches, decision records, and rollback metadata.
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
3. Resolve decisions manually or let an enabled bounded autopilot handle supported checkpoints.
4. Apply the update as a recoverable transaction.
5. Run configured checks, optionally commit and deploy, then keep or roll back the result.

The main run progression is:

```text
Archive -> Review -> Apply -> Checks -> Finish
```

See [Getting started](docs/getting-started.md) for first-run setup, Git initialization, the project menu, and daily use.

## Archive modes

**Overlay archive** is the default. Files present in the archive are created or updated, while files missing from the archive remain untouched.

**Full project snapshot** treats the archive as the managed project contents. Missing files may be deleted according to the configured policy. Protected, ignored, sensitive, untracked, or unmanaged paths remain preserved unless an explicit advanced policy allows otherwise.

See [Archive workflows](docs/archive-workflows.md) for root detection, archive metadata, snapshot policies, duplicate handling, and review behavior.

## Safety model

Zipflow treats every input archive as untrusted. Before changing the project, it validates the ZIP structure, extracts into an isolated directory, compares content by hash, records a patch, checks local conflicts, verifies that the plan is still current, and creates a backup of every affected path.

Archive validation rejects traversal and ambiguous paths, encrypted or special entries, `.git` contents, duplicate and Unicode-equivalent paths, file/directory conflicts, excessive expansion, and suspicious compression ratios. Existing project paths are revalidated during every filesystem phase so a path replaced by a symbolic link after review is not followed outside the project.

If applying changes fails after files were touched, Zipflow restores the affected paths automatically. A later rollback is allowed only while those paths still match the state produced by the run, so newer work is not overwritten silently.

The `.git/` and `.zipflow/` trees are always protected. Permanent local-safety exclusions include `.env`, `.env.*`, `.venv/**`, and `.DS_Store`. Snapshot deletion also preserves credentials, private keys, certificate containers, secret-bearing configuration, and local databases.

See [Safety, conflicts, and rollback](docs/safety.md) for the complete behavior.

## Decision modes and autopilot

Each project workflow has a decision mode:

- **Manual** asks the user at every unresolved checkpoint.
- **Guarded autopilot** allows a compatible local model to resolve routine, reversible decisions and pauses for meaningful risk, incomplete evidence, low confidence, staged user work, or state drift.
- **Full autopilot · Dangerous** can additionally choose supported high-risk actions such as keeping and committing failed updates, resolving eligible conflicts, rewriting eligible unpublished Zipflow commits, or running configured deployment after failed checks.

Autopilot never receives unrestricted shell control. Zipflow supplies a finite action allowlist at each decision gate, records the decision and evidence, checks confidence and project state, and falls back to deterministic or manual handling when the result is invalid or unsafe.

See [Decision modes and autopilot](docs/autopilot.md) before enabling autonomous decisions.

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
- explain failed checks or deployment output;
- resolve explicitly supported autopilot checkpoints.

Model output never replaces deterministic archive validation, path confinement, Git conflict detection, backups, tests, or transactional restoration. Ordinary local-model failures do not block manual archive application.

See [Local LLM integration](docs/local-llm.md) for providers, model loading, delivery modes, prompt budgeting, replay, diagnostics, and autonomy compatibility.

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
Page Up     move or scroll one page upward
Page Down   move or scroll one page downward
Home        move to the first item where supported
End         move to the last item or latest Activity entry
Ctrl+B      open or close global settings
Ctrl+T      toggle native terminal text selection
G           reveal the current run report where available
Ctrl+C      cancel an active operation; exit while idle
```

Context-sensitive help is available with `?`. Diff review and text editors expose additional shortcuts when active.

See [Interface and controls](docs/controls.md) for operation-aware cancellation and the complete reference.

## Data and storage

Zipflow stores its settings, workflows, reports, patches, backups, managed-file history, and autonomy records under:

```text
~/.zipflow/
```

Set `ZIPFLOW_HOME` to use another location, including an isolated directory for tests.

Settings are written with a recoverable `settings.backup.json`. Source archives are left in place by default; settings can instead move successfully applied archives to managed storage or delete them after completion. Backup and archive retention are configured separately.

See [Settings, history, and storage](docs/settings-and-storage.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Archive workflows](docs/archive-workflows.md)
- [Safety, conflicts, and rollback](docs/safety.md)
- [Decision modes and autopilot](docs/autopilot.md)
- [Project detection and checks](docs/project-detection.md)
- [Local LLM integration](docs/local-llm.md)
- [Settings, history, and storage](docs/settings-and-storage.md)
- [Interface and controls](docs/controls.md)
- [Development and publishing](docs/development.md)
- [Architecture](ARCHITECTURE.md)

## Development

```bash
npm install
npm run verify
```

`npm run verify` performs source checks and runs the automated test suite. See [Development and publishing](docs/development.md) for linking, package inspection, release versioning, and publication.

## License

[MIT](LICENSE)
