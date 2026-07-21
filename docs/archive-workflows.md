# Archive workflows

## Archive inspection

Zipflow performs archive analysis before changing project files:

1. Extract the archive into an isolated temporary directory.
2. Validate entries and reject unsafe content.
3. Determine whether a wrapper directory should be treated as the project root.
4. Read supported archive metadata.
5. Compare archive contents with the current project by content hash.
6. Build a change plan and a unified `changes.patch`.
7. Optionally run local LLM review or summarization.
8. Evaluate deterministic age and snapshot-shrink warnings.
9. Present the plan, warnings, conflicts, and diffs for review.

Nothing is written to the project during these steps.

## Archive root confirmation

When a ZIP contains one top-level directory, Zipflow compares two interpretations:

- treat that directory as the archive project root;
- preserve it as a literal subdirectory inside the current project.

A wrapper directory is detected automatically only when it contains project markers. If keeping the directory literally would create one new folder while replacing or removing the existing project tree, Zipflow displays both compact plans and requires an explicit choice.

Swift packages (`Package.swift`) and Xcode project or workspace markers participate in root detection.

## Overlay archives

Overlay mode is the default.

Files present in the archive are created or updated. Files absent from the archive remain untouched. This mode is suitable for partial updates and patch-like source deliveries.

## Full project snapshots

Snapshot mode treats the archive as the managed project contents, so missing paths may be deleted.

Available deletion policies include:

- remove only clean Git-tracked files;
- remove only paths created or updated by previous Zipflow runs;
- an advanced policy that includes all files inside the managed scope.

Untracked or unmanaged files absent from the archive remain in place under the safe policies and are reported as preserved. Protected and excluded paths are never removed.

Managed-file history can be reset from global settings without changing project files.

## Plan and change review

The compact plan reports counts for:

- added;
- changed;
- removed;
- unchanged;
- ignored;
- preserved;
- conflicting paths.

**Review changes** opens grouped details, including reasons for skipped and preserved files.

Text changes can be displayed as a unified diff or, in a sufficiently wide terminal, a side-by-side diff. Distant edits are split into hunks. Binary and oversized files receive a safe informational comparison instead of being rendered as terminal text.

The stored patch remains available from run history after the run.

## Commit-message metadata

The preferred archive metadata path is:

```text
.zipflow/commit-message.txt
```

Legacy names remain readable:

```text
.zipflow/commit_message.txt
.commit_message
.commit_message.txt
commit_message.txt
COMMIT_MESSAGE
COMMIT_MESSAGE.txt
```

Metadata files are not copied into the project. The entire `.zipflow/` tree is protected from archive application.

Multi-line commit messages are supported. When archive metadata is selected but no supported file exists, the fallback is:

```text
zipflow: apply <run-id>
```

Other message sources include the archive filename, a generated run identifier, a fixed template, and a local LLM proposal.

## Archive age and shrink warnings

Before application, Zipflow compares the incoming archive with recent successful runs for the same project. It warns when:

- the ZIP modification time is materially older than the last applied archive;
- snapshot mode would delete at least ten paths and a large fraction of the managed scope;
- the snapshot contains far fewer files than the previous applied archive.

Warnings include the measured counts and ratios. The user can review paths and diffs, continue explicitly, or choose another archive.

A local LLM `suspicious` or `unsuitable` verdict appears on the same safety-review screen but remains advisory.

## Duplicate archives and repeat

Every archive update records the archive hash. When the same hash has already been applied, Zipflow shows the previous result before continuing.

**Repeat last archive** deliberately bypasses the duplicate guard and rebuilds the plan against the current working tree. This is useful after changing workflow settings or correcting an external problem.
