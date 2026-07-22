# Archive workflows

## Archive inspection

Zipflow performs archive analysis before changing project files:

1. Validate the selected ZIP as a regular, non-symlink file.
2. Inspect and extract it into an isolated temporary directory.
3. Reject unsafe or ambiguous archive entries.
4. Determine whether a wrapper directory should be treated as the project root.
5. Read supported archive metadata.
6. Compare archive contents with the current project by content hash.
7. Build a change plan and a unified `changes.patch`.
8. Optionally run local LLM review or summarization.
9. Evaluate deterministic age and snapshot-shrink warnings.
10. Present the plan, warnings, conflicts, and diffs for review or an enabled autopilot gate.

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

The complete stored patch remains available from run history after the run. Autopilot receives only a bounded decision context and an explicit action allowlist; it does not replace this deterministic plan.

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

Multi-line commit messages are supported. When archive metadata is selected but no supported file exists, the deterministic fallback is:

```text
zipflow: apply <run-id>
```

At commit time, Zipflow can present every distinct usable proposal: local LLM output, archive metadata, a configured workflow template, and the generated fallback. Selecting a proposal creates the commit directly. **Edit message…** opens the preferred proposal in a multiline editor, and **Continue without commit** keeps the files without committing them.

## Archive age and shrink warnings

Before application, Zipflow compares the incoming archive with recent successful runs for the same project. It warns when:

- the ZIP modification time is materially older than the last applied archive;
- snapshot mode would delete at least ten paths and a large fraction of the managed scope;
- the snapshot contains far fewer files than the previous applied archive.

Warnings include measured counts and ratios. Manual mode requires review. Guarded autopilot pauses when the evidence or risk is not suitable for automatic continuation. A local LLM `suspicious` or `unsuitable` verdict appears on the same safety-review screen but remains advisory.

## Duplicate archives and repeat

Every archive update records the archive hash. In Manual mode, selecting a previously applied hash shows the earlier result before continuing.

Autopilot rebuilds the plan against the current project. When no content changes remain, it records a `duplicate_skipped` run and returns to archive waiting without checks, commit, deployment, or another LLM decision.

**Repeat last archive** deliberately bypasses the normal duplicate prompt and rebuilds the plan against the current working tree. If the completed run moved the source ZIP into managed storage, Zipflow repeats the managed copy. If the source was kept in place, it repeats the original path. Recorded fallback locations are checked only when the preferred path is unavailable. This is useful after changing workflow settings or correcting an external problem.

## Source archive disposition

After a kept update, the selected ZIP can remain in place, move to managed archive storage, or be deleted. Before move or deletion, Zipflow hashes the source again so a different file cannot be consumed under the original plan.

Cancelled runs, failures before application, and rollbacks before a run is kept do not consume the source archive.
