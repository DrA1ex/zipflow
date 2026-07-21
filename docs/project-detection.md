# Project detection and checks

Zipflow inspects the current project and proposes checks appropriate for the detected technologies. Every proposed command can be reviewed before the workflow is saved.

## Node.js and TypeScript

Zipflow reads `package.json`, detects the package manager, discovers relevant scripts, and can run changed-file JavaScript syntax checks.

TypeScript checks are proposed when a local compiler or suitable project script is available.

## Python

Zipflow recognizes common Python project files, prefers a virtual-environment interpreter when available, checks changed Python files with `py_compile`, and proposes pytest when tests are detected.

## CMake and C++

For projects without presets, Zipflow can propose configure, build, and test commands. Projects using presets can add the preferred preset commands as custom checks.

## Go

Zipflow can propose formatting, vet, test, and build checks.

## Swift and Xcode

Swift projects receive suitable `swift test`, `swift build`, and inferred macOS `xcodebuild` checks.

The inferred Xcode scheme is shown in the workflow and can be replaced.

## Project scripts

Zipflow inspects the project's `scripts` directory as well as package-manager scripts.

Check-like scripts are offered in the checks step. Deploy, release, and publish scripts are prioritized as deployment choices. Other runnable scripts remain available as optional commands.

A custom command can always be added.

## Custom checks

When adding a custom check, Zipflow asks for:

1. the exact shell command;
2. the short name displayed in the workflow and run results.

Custom checks can later be edited or removed from the same list.

## Deployment policies

A workflow can configure one deployment command with one of these policies:

- **Ask** — offer to run it after successful checks;
- **Always** — run automatically after successful checks;
- **On demand** — keep a **Run deployment** action on the successful result screen;
- **Disabled** — do not configure deployment.

Deployment stdout, stderr, exit code, and duration are saved in the run report.
