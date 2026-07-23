# Zipflow

Zipflow is an interactive terminal application for safely reviewing and applying source-code updates delivered as ZIP archives.

It inspects an archive before touching the project, shows the planned file changes, handles conflicts, creates recoverable backups, runs project checks, and can optionally commit or deploy the result.

## Install

Zipflow requires Node.js 20 or newer on macOS or Linux.

```bash
npm install --global zipflow
```

Then run it from a project directory:

```bash
cd /path/to/project
zipflow
```

## Quick start

On the first run, Zipflow:

1. Detects the project and immediate subprojects.
2. Suggests tests, checks, and deployment commands.
3. Lets you review the workflow before saving it.

For each update:

1. Enter or drag the ZIP path into the terminal.
2. Review the archive root, warnings, changed files, conflicts, and diff.
3. Apply the update as a recoverable transaction.
4. Run the configured checks.
5. Optionally create a Git commit and run deployment.
6. Keep the result or roll it back from history.

```text
Archive → Review → Apply → Checks → Finish
```

## Main features

- Overlay updates and full-project snapshots.
- Archive validation and project-path confinement.
- File-level conflict review and diff inspection.
- Automatic restoration when application fails partway through.
- Stored backups and guarded rollback.
- Node.js, Python, CMake/C++, Go, SwiftPM, and Xcode detection.
- Multi-project workspaces with commands executed from their configured subdirectories.
- Custom checks and deployment commands using `web/ :: npm test` syntax.
- Optional local LLM integration through Ollama or LM Studio.
- Manual, Guarded autopilot, and Full autopilot decision modes.
- Run history, performance analytics, reports, stored patches, and ZIP export.
- English and Russian interface coverage, with additional built-in and custom language packs.

## Useful controls

```text
↑ / ↓       move through choices
Shift+↑/↓   reorder checks during workflow setup
Space       toggle or select
Enter       open or confirm
Esc         go back; from the archive prompt, open the project menu
Tab         complete paths or switch Settings panes
Shift+Tab   return to the parent directory during path completion
/           search the active list
?           open contextual help or structured statistics
Ctrl+B      open global settings
Ctrl+T      toggle native terminal text selection
Ctrl+C      cancel an active operation; exit while idle
```

Press `Esc` from the archive prompt to open project actions such as Change workflow, Run history, Run tests, Run deployment, Create ZIP, and Exit.

## Documentation

Start with the [documentation index](docs/README.md).

- [Getting started](docs/getting-started.md)
- [Archive workflows](docs/archive-workflows.md)
- [Safety, conflicts, and rollback](docs/safety.md)
- [Project detection and checks](docs/project-detection.md)
- [Multi-project workspaces](docs/multi-project-workspaces.md)
- [Local LLM integration](docs/local-llm.md)
- [Decision modes and autopilot](docs/autopilot.md)
- [Settings, history, and storage](docs/settings-and-storage.md)
- [Interface and controls](docs/controls.md)
- [Interface localization](docs/i18n/README.md)

## Development

```bash
npm install
npm run verify
npm run release:check
```

See [Development and publishing](docs/development.md) for local linking, verification, package inspection, versioning, and npm publication.

## License

[MIT](LICENSE)
