# Changelog

## 1.3.9 — Archive snapshot lifecycle repair

- Kept the private ZIP snapshot alive for the complete asynchronous archive-inspection scope instead of deleting it immediately after returning the inspection Promise.
- Routed archive inspection through `withArchiveSource` so snapshot ownership and cleanup remain structurally paired, fixing `ENOENT source.zip` plus no-op, conflict, repeated-archive, and Local LLM workflow failures.
- Corrected migration of the legacy unified project-command environment setting so its value is copied to both checks and deployment when the split settings are absent.
- Added a regression test proving private snapshot cleanup waits until its asynchronous owner has completed.

## 1.3.8 — Practical hardening simplification

- Replaced shared-descriptor ZIP processing with a private hashed archive snapshot so each ZIP reader owns its descriptor and `EBADF` read/close failures cannot propagate through archive inspection.
- Removed the global asynchronous UI action queue; ordinary navigation is synchronous again, while duplicate submissions and stale completion/diff/replay results use local gates and generation guards.
- Simplified active operation state to running, cancelling, or critical, with completed, failed, and cancelled retained as terminal results rather than active ownership states.
- Kept the Binaries settings and manual absolute-path overrides, simplified automatic selection, and now warn clearly when a manual override bypasses project-local exclusions.
- Split project-command environments into independently configurable checks and deployment policies: sanitized checks and inherited deployment by default.
- Made initial-commit review list every omitted path and retain an explicit include-all override; generated content, databases, and large files are warnings rather than credential classifications.
- Replaced heartbeat project locks and storage leases with static owner-token records, dead/expired-owner recovery, and no periodic disk traffic.
- Reduced routine persistence to atomic temporary-file replacement, reserving fsync durability for fatal recovery state; atomic backup publication and hash verification remain intact.
- Simplified disk-space preflight to reject clear shortages without masking transaction errors or claiming an exact filesystem/rollback model.
- Applied portability collision rules according to the target filesystem instead of rejecting Unix-valid paths solely for Windows portability.

## 1.3.7 — Full-suite regression repair

- Fixed ZIP descriptor ownership so central-directory inspection and extraction can reuse one opened archive without `EBADF` failures or masking archive security errors.
- Kept disk-space preflight from replacing transactional apply and rollback failures when a reviewed incoming source disappears before mutation.
- Prevented duplicate Enter/Space activation while an action is queued or running, while preserving synchronous diff-hunk navigation results.
- Preserved complete initial Local LLM and replay snapshots alongside delta streaming, and restored explicit LLM cancellation labels in the global footer.
- Canonicalized workspace path completion and deployment path assertions on aliasing filesystems such as macOS `/var` and `/private/var`.
- Synchronized Settings, Git-hook, migration, replay, and concurrency regression contracts with the behavior introduced by release-hardening phases 2–5.

## 1.3.6 — Phase 5 archive and backup integrity

- Bound selected ZIP inspection, hashing, central-directory reads, extraction, and final identity verification to one no-follow file descriptor so replacing the pathname cannot substitute different archive bytes.
- Added atomic backup publication through a temporary sibling directory, per-file SHA-256 verification against the reviewed pre-apply state, durable manifests, and backward-compatible version 1 rollback support.
- Added complete backup verification before automatic or requested rollback so missing or modified recovery content is rejected before any project file is changed.
- Added filesystem-aware capacity preflight for extraction, backup data, replacement temporaries, reports and patches, and rollback reserve, including aggregation when project and Zipflow storage share one filesystem.

## 1.3.5 — Phase 4 bounded streaming and shared storage

- Added independent Local LLM connection, total, and idle deadlines plus byte-based limits for SSE events, JSON metadata and error bodies, unparsed input, reasoning, answers, and retained raw diagnostics.
- Replaced cumulative streaming updates with deltas and fixed-segment byte collectors so long model responses remain bounded without repeated full-response copying.
- Replaced process stdout/stderr string concatenation with byte-bounded segmented rings and throttled output notifications while preserving a valid UTF-8 tail.
- Added cross-process storage leases for Settings, archive-index mutations, backup cleanup, and run-history cleanup, including stale-owner recovery and heartbeat ownership.
- Added active-run heartbeat leases so one Zipflow instance cannot prune another instance's active backup, temporary data, or run history.
- Added Settings revisions and compare-and-swap conflict detection: unrelated stale patches merge with the latest revision, while same-field and stale full writes fail explicitly.

## 1.3.4 — Phase 3 operation and UI consistency

- Consolidated active work into one operation lifecycle with derived UI capabilities; `busy`, operation state, and action availability can no longer diverge through independent state assignments.
- Serialized asynchronous key and pointer transitions through a shared queue, coalesced pending navigation, and added screen-generation guards for stale path completion, diff loading, and replay actions.
- Added explicit operation handoff between archive inspection and background LLM review so no idle window exists between owners.
- Added fatal recovery ordering that requests cancellation, records durable recovery state, stops child processes, and retains the project lock until operation ownership actually ends.
- Added deterministic post-update verification of package metadata, executable containment and presence, and `zipflow --version`; uncertain replacements now permit exit only.

## 1.3.3 — Phase 2 execution trust boundaries

- Added global validated binary settings for Git, npm, Node.js, the system opener, Python, and gofmt; trusted internal operations now use resolved absolute executable paths and ignore project-local `node_modules/.bin`.
- Added a per-workflow Git-hooks policy. Zipflow commits disable project hooks by default through a trusted empty hooks directory, while configured workflows can explicitly opt in.
- Added a global project-command environment policy. Checks and deployment use a documented sanitized environment by default, with optional full inheritance.
- Replaced unrestricted first-commit staging with an explicit candidate review that excludes protected Zipflow paths and does not silently commit suspicious or sensitive files.
- Added a versioned one-time warning before Full Autopilot is enabled, while keeping deterministic safety blocks authoritative.

## 1.3.2 — Phase 1 release hardening

- Pinned all runtime dependencies and added a published `npm-shrinkwrap.json` plus a two-install package verification command.
- Replaced numeric SemVer coercion with exact SemVer parsing and comparison, including prereleases, build metadata, large identifiers, and invalid registry responses.
- Preserved cancelled check operations as cancellations and added scoped operation ownership for Git checkpoints.
- Hardened built-in check filenames and made `cwd :: command` parsing quote-aware and relative-directory-only.
- Preserved existing executable modes when archive entries omit Unix mode metadata.
- Added bounded run-history retention, startup cleanup for orphaned temporary run directories, durable atomic JSON writes, and heartbeat-based project-lock ownership.
- Added `zipflow --version` for package and clean-install smoke tests.
