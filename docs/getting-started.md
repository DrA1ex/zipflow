# Getting started

## Install Zipflow

Install the published package globally:

```bash
npm install --global zipflow
```

Update or remove it with:

```bash
npm install --global zipflow@latest
npm uninstall --global zipflow
```

For a local source checkout, install dependencies and create a global development link:

```bash
cd /path/to/zipflow
npm install
npm link
```

Remove the link later with:

```bash
npm unlink --global zipflow
```

## Start Zipflow in a project

Zipflow operates on the current project directory:

```bash
cd ~/dev/my-project
zipflow
```

There are no command submodes. Setup, archive application, checks, commits, deployment, history, export, settings, autopilot, and rollback are available from the interactive interface.

## First launch

Zipflow resolves the canonical workspace root, scans it and its immediate child directories for projects, and then presents a setup wizard. The detected information is written to Activity as a framed **Project detected** block rather than consuming permanent action-pane space.

The wizard lets you review:

- detected root and subprojects;
- automatically discovered checks with their working directories;
- custom validation commands;
- archive interpretation and snapshot deletion rules;
- conflict and checkpoint behavior;
- result commit behavior and message sources;
- optional deployment;
- the decision mode: Manual, Guarded autopilot, or Full autopilot · Dangerous.

Recommended choices begin selected. The workflow is saved only after final confirmation. Reopening setup leaves the currently saved workflow active until its replacement is confirmed and written successfully.

Global settings are loaded before the interactive runtime begins accepting input. This avoids a startup window in which defaults could overwrite persisted model, credential, storage, or retention configuration.

A manually added project can be deeper than the automatic one-level scan. Checks and deployment commands accept `path/ :: command`; for example, `web/ :: npm test` runs from `web/`.

## Projects without Git

If the project is not a Git repository, Zipflow offers to initialize it.

After `git init`, Zipflow can:

1. create a project-aware `.gitignore` only when one does not already exist;
2. add existing non-ignored files;
3. create an initial commit.

An existing `.gitignore` is preserved byte-for-byte. Continuing without Git remains possible, but Git-specific conflict and commit features are unavailable.

## Daily workflow

For a configured project, Zipflow starts in archive-waiting mode:

1. drag a ZIP into the terminal or enter its path; alternatively, press `Enter` twice on the empty field to scan the last-used archive folder for matching ZIPs from the previous 24 hours;
2. review root interpretation, plan counts, warnings, conflicts, and diffs;
3. make decisions manually or allow the configured decision mode to handle supported gates;
4. apply the selected changes;
5. run checks;
6. optionally create a result commit and deploy;
7. keep the result, inspect its report, or roll it back.

The header shows:

```text
Archive -> Review -> Apply -> Checks -> Finish
```

When a path suggestion is selected, it only completes the field. Press `Enter` again to submit the archive, preventing completion from starting an update unexpectedly. On a completely empty field, the first `Enter` only arms recent-archive discovery and displays the folder; the second press within 1.5 seconds performs the scan.

In autopilot mode, reusing an archive whose content already matches the current project creates a `duplicate_skipped` run and returns to archive waiting without unnecessary checks, commits, deployment, or LLM decisions.

## Project menu

Press `Esc` from archive waiting to open the compact project menu. It can include:

- **Change workflow**;
- **Repeat last archive**;
- **Run history**;
- **Run tests**;
- **Run deployment**;
- **Create ZIP**;
- **Exit**.

`Esc` on the project menu does not terminate Zipflow. Use **Exit** or press `Ctrl+C` while no operation is active.

## Manual checks and deployment

**Run tests** and **Run deployment** operate on the current project without applying an archive. They write normal JSON and text reports and appear as distinct record types in run history.

When a manual command fails and local failure analysis is configured, Zipflow offers **Explain error with local LLM**. It is not triggered automatically from the project menu.

## Creating a ZIP

**Create ZIP** offers four source scopes:

- Git-tracked files;
- non-ignored tracked and untracked files;
- custom hierarchical selection;
- everything, including ignored files, followed by a sensitive-file review.

The sensitive-file review is optimized for decisions rather than directory browsing. Five or fewer flagged files are shown as one flat list with full project-relative paths. Larger reviews keep folders only when a folder contains several flagged choices; a directory chain that leads to one flagged file is collapsed into that file path. Space immediately switches the marker between included and excluded.

Filename-only safety detection applies to credential-like data files such as JSON files and extensionless secret files. Source files such as JavaScript, TypeScript, or Python modules are not classified as credentials merely because their filename contains words such as `credential`, `secret`, or `token`.

The output-path editor uses the same non-displacing completion overlay as archive input. Choosing **Use this directory** generates a timestamped project ZIP name in that directory. Missing `.zip` extensions are added automatically, and an existing destination requires separate overwrite confirmation.

The default output remains outside the project so the archive cannot include itself.
