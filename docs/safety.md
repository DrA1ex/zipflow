# Safety, conflicts, and rollback

## Protected paths and archive validation

Zipflow rejects or protects content before archive application.

Archive validation rejects:

- paths that escape the extraction root;
- symbolic links;
- `.git` entries;
- duplicate archive paths;
- suspicious archive sizes or expansion behavior.

The following project paths are always protected from archive application:

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

Snapshot deletion preserves `.gitignore` and locally sensitive data such as credential files, private keys, secret-bearing configuration, and local databases.

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

## Stale-plan protection

After the plan is reviewed and before files are written, Zipflow verifies that affected paths still match the state used to create the plan. If another process or the user changed those files in the meantime, application stops instead of overwriting the newer state.

## Transactional application

Zipflow creates a path-specific backup before changing the project. The apply operation then writes only the selected changes.

If application fails after touching files, Zipflow restores every affected path from the backup before reporting the error.

Checks, commits, and deployment happen after the filesystem transaction has completed.

## Git commits

Zipflow separates two commit purposes:

- a **checkpoint commit** before conflicting local changes are overwritten;
- a **result commit** after the selected update is kept.

Each purpose is configured independently.

Result commits stage only paths applied by the current run. Protected `.zipflow/` paths and untracked paths ignored by Git are filtered before staging. Pre-existing staged changes block automatic result commits so unrelated index contents cannot be included accidentally.

Zipflow never pushes commits.

If required checks fail and the user keeps the update, Zipflow can still offer a result commit for the applied paths. Deployment remains skipped for the failed run.

## Rollback

Rollback restores the exact contents that existed immediately before the run. It does not reset the project to Git `HEAD` and does not rewrite Git history.

Rollback is blocked when an affected path changed after the run. This prevents newer work from being overwritten silently.

Backup retention can make old runs no longer rollback-capable. History reports this as **Rollback unavailable** rather than failing only after the user attempts it.

## Deployment boundary

Deployment is a separate post-check action. It can run only after all required checks pass and after the optional result commit step.

A failed deployment does not automatically roll back project files because the deployment command may already have changed an external system.
