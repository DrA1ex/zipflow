# Getting started

## Start Zipflow in a project

Zipflow always operates on the current project directory:

```bash
cd ~/dev/my-project
zipflow
```

There are no command submodes. Setup, archive application, checks, commits, deployment, history, export, settings, and rollback are available from the interactive interface.

## First launch

Zipflow resolves the canonical project root and scans the project before presenting a setup wizard. The detected project information is also written to Activity in a framed **Project detected** block so it remains available while the run continues.

The setup wizard lets you review:

- detected technologies;
- automatically discovered checks;
- custom validation commands;
- archive interpretation and snapshot deletion rules;
- conflict and checkpoint behavior;
- result commit behavior and message source;
- optional deployment after successful checks.

Recommended choices are selected initially. The workflow is saved only after final confirmation. Starting setup again does not remove the active workflow until its replacement has been confirmed and saved successfully.

## Projects without Git

If the directory is not a Git repository, Zipflow offers to initialize it.

After `git init`, Zipflow can:

1. create a project-aware `.gitignore` when one does not already exist;
2. preserve an existing `.gitignore` byte-for-byte;
3. add existing non-ignored project files to an initial commit.

Continuing without Git is also supported, although Git improves conflict detection and makes project history easier to inspect.

## Daily workflow

Once a workflow exists, Zipflow starts directly in archive-waiting mode.

Enter a ZIP path or drag the archive into the terminal. Path completion scans the entered location while you type and shows matching directories and ZIP files in an overlay. Selecting a suggestion fills the field; a separate `Enter` submits the completed path, so completion never starts an update unexpectedly.

The normal run has five stages:

```text
Archive -> Review -> Apply -> Checks -> Finish
```

After a completed run, **Finish and wait for next archive** returns directly to the archive prompt.

## Project menu

Press `Esc` from the archive prompt to open the compact project menu. `Esc` on the menu does not exit Zipflow; use **Exit** or `Ctrl+C`.

The menu can provide:

- **Change workflow** to edit the saved project configuration;
- **Repeat last archive** to rebuild the previous plan against the current working tree;
- **Run history** to inspect previous updates and manual actions;
- **Run tests** when checks are configured;
- **Run deployment** when a deployment command is configured;
- **Create ZIP** to export project files after reviewing the selection.

When editing a workflow, the current configuration remains active until the changed workflow is confirmed and saved.

## Manual checks and deployment

Manual checks and deployments operate on the current project without applying an archive. They create the same text and JSON reports as archive runs and appear in run history as separate record types.

When a manual action fails and local LLM failure analysis is configured, Zipflow can offer **Explain error with local LLM**. The explanation runs only after explicit selection.

## Creating a ZIP

**Create ZIP** supports four modes:

- **Git-tracked files** — a compact Git-based source snapshot;
- **Non-ignored files** — tracked and untracked files except paths matched by project ignore rules;
- **Custom selection** — a hierarchical file browser with tri-state folders;
- **Everything, including ignored files** — an advanced mode followed by a sensitive-file review.

Ignored, generated, potentially sensitive, `.git/`, and `.zipflow/` paths begin excluded in custom selection. Internal Git and Zipflow paths require explicit confirmation before inclusion. Active locks and temporary runtime files remain unavailable.

The default output path is outside the project so the archive cannot include itself.
