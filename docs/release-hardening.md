# Release hardening

Zipflow 1.3.2 includes the first low-risk release-hardening phase. The work keeps the established archive workflow and interface intact while strengthening correctness and reproducibility around package installation, update checks, operation cleanup, command execution, file modes, persistence, and local storage.

## Reproducible installations

Runtime dependencies use exact versions. The published package includes `npm-shrinkwrap.json`, and `npm run test:package` packs Zipflow, installs the tarball into two isolated consumers, compares the resolved runtime versions, and runs the packaged `zipflow --version` command.

Both `package-lock.json` and `npm-shrinkwrap.json` retain public `https://registry.npmjs.org/` tarball URLs.

## Command and cancellation behavior

A cancelled project check remains a cancelled workflow operation. It is not converted into a failed check, does not increase the failed count, and does not enter failed-check LLM analysis.

Built-in syntax and formatting checks prefix discovered relative paths with `./`. Tools that support an option terminator also receive `--`, so names beginning with `-`, names containing spaces, and Unicode names remain filenames.

The command-directory form remains:

```text
web/ :: npm test
```

The separator is recognized only outside quoted command text. Relative directories containing spaces can be quoted:

```text
"web app/" :: npm test
```

A command such as `python -c 'print("a::b")'` continues to run from the workspace root.

## File modes and persistence

ZIP entries now distinguish missing Unix mode metadata from an explicit mode. Updating an existing executable without mode metadata preserves its current mode; a new file without metadata uses the safe regular-file default.

Critical JSON replacement writes and synchronizes a temporary file, atomically renames it, and synchronizes the parent directory where the platform supports it. Existing settings backup recovery remains unchanged.

## Retention and locks

Run history is pruned after 90 days and bounded to 512 MiB by default. Active, non-terminal, or explicitly retained run records are never selected for pruning. Startup cleanup removes temporary run directories only when no active run record protects them.

Project locks now include a random owner token and heartbeat. Fresh locks retain the existing single-project ownership behavior, dead owners are reclaimed immediately, and a stale heartbeat prevents a reused unrelated PID from holding a project lock indefinitely.
