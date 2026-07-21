# Safety, conflicts, and rollback

## Input ZIP boundary

Zipflow treats every input ZIP as untrusted. The selected archive must be a regular file and must not be a symbolic link.

Archive inspection rejects:

- path traversal, absolute paths, drive-relative paths, and backslash escape variants;
- Windows device names and alternate data streams;
- `.git` entries;
- encrypted entries;
- symbolic links, devices, sockets, FIFOs, and other unsupported special entries;
- duplicate paths;
- case-insensitive and Unicode-equivalent collisions;
- file-versus-directory parent conflicts;
- excessive path depth or entry counts;
- oversized expanded data;
- suspicious compression ratios.

The archive is extracted into an isolated temporary directory only after entry validation.

## Project filesystem boundary

Extraction is not the only confinement layer. Every affected project path is revalidated during:

- plan creation;
- backup creation;
- application;
- rollback.

If an existing project component becomes a symbolic link after the plan was reviewed, the operation aborts instead of following the link outside the project. Backup and temporary targets use no-follow and exclusive-creation behavior where applicable. Output ZIP creation refuses symbolic-link destinations, and export does not follow Git-tracked symbolic links.

The following trees are always protected from archive application:

```text
.git/
.zipflow/
```

Permanent local-safety exclusions also include:

```text
.env
.env.*
.venv/**
.DS_Store
```

Dotfiles and dot-directories are otherwise ordinary project paths. Paths such as `.github/` and `.config/` are synchronized unless excluded by the project's existing ignore rules or another safety rule.

Snapshot deletion additionally preserves `.gitignore`, environment and credential files, private keys and certificate containers, secret-bearing configuration, and local databases. These rules apply in every decision mode, including Full autopilot.

## Conflict detection

Uncommitted changes do not block an update by themselves.

A conflict exists only when the archive would update or delete a path that currently has a Git change. Unrelated local changes are left alone. When the current file already has exactly the same content as the archive, it is classified as unchanged rather than conflicting.

Conflict review begins with bulk choices:

- replace every conflict with the archive version;
- keep every local version;
- choose files manually;
- cancel and select another archive.

Manual review advances one file at a time. Each file can keep the local version, use the archive version, apply the same decision to the remaining conflicts, or open a diff before deciding.

An optional checkpoint commit can preserve affected local files immediately before archive versions are applied.

Guarded autopilot does not decide ambiguous conflict replacement. Full autopilot can choose only among Zipflow-provided eligible actions and remains subject to protected paths, state checks, and the configured confidence threshold.

## Stale-plan and state-integrity protection

After the plan is reviewed and before files are written, Zipflow verifies that affected paths still match the state used to create the plan. If another process or the user changed those files, application stops instead of overwriting newer state.

Autonomous decisions also record state hashes. If the project changes while the model is deciding, the result is not executed automatically.

## Transactional application

Zipflow creates a path-specific backup before changing the project. The apply operation writes only selected changes.

If application fails after touching files, Zipflow restores every affected path from the backup before reporting the error.

Cancellation is deferred during atomic filesystem steps until the current step can finish or be restored. This prevents `Ctrl+C` from leaving a partially applied project.

Checks, commits, and deployment happen after the filesystem transaction has completed.

## Git commits

Zipflow separates two commit purposes:

- a **checkpoint commit** before conflicting local changes are overwritten;
- a **result commit** after the selected update is kept.

Each purpose is configured independently.

Result commits stage only paths applied by the current run. Protected `.zipflow/` paths and untracked paths ignored by Git are filtered before staging. Pre-existing staged changes block automatic commits so unrelated index contents cannot be included accidentally.

Full autopilot can amend or squash only eligible unpublished Zipflow commits exposed by the application. The model cannot choose arbitrary commit hashes. Zipflow never pushes or force-pushes.

## Rollback

Rollback restores the exact contents that existed immediately before the run. It does not reset the project to Git `HEAD` and does not rewrite Git history.

Rollback validates the project/run binding and backup manifest before writing. It is blocked when an affected path changed after the run, preventing newer work from being overwritten silently.

Backup retention can make old runs no longer rollback-capable. History reports this as **Rollback unavailable** instead of failing only after an attempt.

## Deployment boundary

Deployment is a separate post-check action. In Manual and Guarded modes, it runs only after required checks pass and after the optional result commit step.

Full autopilot can choose the already configured deployment after failed checks only when the workflow explicitly enables that capability. It cannot invent a command or modify the deployment configuration.

A failed deployment does not automatically roll back project files because the command may already have changed an external system.
