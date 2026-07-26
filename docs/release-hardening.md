# Release hardening

Zipflow hardening protects the boundaries that can realistically damage a local project: untrusted ZIP input, stale project state, automatic command execution, interrupted filesystem changes, and accidental concurrent Zipflow instances. It does not try to create a security boundary against arbitrary software already running as the same logged-in user.

## Reproducible package

Runtime dependencies use exact versions. The published package includes `npm-shrinkwrap.json`, retains public npm registry URLs, and exposes `npm run test:package` for isolated package-install verification.

## Archive snapshot

The selected ZIP must be a regular non-symlink file. Zipflow opens it without following the leaf symlink, copies it once into a private run directory while calculating SHA-256, and closes the original descriptor. All central-directory reads and extraction passes open the private snapshot independently.

This prevents pathname replacement from substituting different archive bytes without sharing a file descriptor between ZIP readers. The snapshot is owned by the complete asynchronous archive-inspection scope and is removed only after that owner settles.

Archive validation still rejects traversal, absolute paths, `.git` entries, encrypted data, symbolic links and special files, exact path collisions, target-filesystem case collisions, file/directory conflicts, excessive entry counts, expanded sizes, and compression ratios. Windows-only portability names are not rejected on supported Unix targets merely for being non-portable to Windows.

## Filesystem application

Before application, affected project paths are revalidated and reviewed `beforeHash` values are checked. Zipflow creates a path-specific backup in a temporary sibling directory, verifies copied files against the reviewed hashes, writes the manifest, and publishes the backup by atomic rename.

Rollback validates the complete backup before its first project mutation. Application uses destination-local temporary files and atomic replacement where possible. Cancellation waits for the current atomic step or recovery boundary.

Disk-space preflight is intentionally conservative but approximate. It rejects clear shortages for extraction, backup data, replacement temporaries, metadata, and a fixed safety margin. It does not claim to model filesystem compression, snapshots, sparse files, or every rollback byte exactly, and it does not replace ordinary source-file or transaction errors.

Ordinary Settings, history, and report writes use private temporary files plus atomic rename. Durable fsync-based replacement is reserved for fatal recovery state, where surviving a sudden system failure materially changes recovery behavior.

## Project lock and shared storage

A project lock is created exclusively and contains the owner PID, a random owner token, the run ID, and creation time. It performs no periodic heartbeat writes. A dead or clearly expired owner can be reclaimed; release succeeds only for the matching owner token.

Shared Settings/index/cleanup mutations use short static owner-token leases. Reads are not leased. Active runs use static ownership markers so another process does not prune their backup or history while they are running. Settings revisions provide compare-and-swap behavior: unrelated stale patches can merge, while conflicting stale writes fail explicitly.

## Internal binaries

The **Binaries** settings page remains available for Git, npm, Node.js, the system opener, Python, and gofmt. Automatic selection resolves absolute executable paths while excluding candidates inside the active project and project-local `node_modules/.bin` directories.

A manual absolute-path override is always available, including for project-local tools. Zipflow validates that it is an executable file and shows a warning when the override bypasses automatic exclusions. The purpose is deterministic tool selection and support for tools outside `PATH`, not a claim that Zipflow can defend against a compromised user environment.

## Git hooks and initial commit

Automatic Zipflow commits disable repository hooks by default with a command-scoped empty `core.hooksPath`. A configured workflow may explicitly allow project hooks; repository configuration is not rewritten.

The initial commit enumerates candidates instead of running `git add --all`. Credential-like files and private keys are excluded by default. Generated directories, local databases, and large files are presented as review warnings rather than being treated as credentials. The review lists every excluded path and lets the user explicitly include all reviewed candidates.

## Project-command environments

Checks and deployment have separate global policies:

- checks default to a sanitized environment that removes common credential variables and agent sockets while retaining normal execution paths and project-local package binaries;
- deployment defaults to the inherited environment because deployment commonly depends on credentials or agents.

Either policy can be changed to sanitized or inherited. This is an environment-reduction feature, not a process sandbox.

## Operation and UI behavior

There is at most one active operation. Its state is limited to running, cancelling, or critical; completed, failed, and cancelled are terminal results rather than active-operation states. Action availability is derived from whether an operation owns the workflow.

Ordinary navigation remains synchronous. Duplicate submissions use local action gates, and asynchronous path completion, diff loading, replay, and similar requests use local abort/generation guards. There is no global UI action queue that changes every keyboard and pointer contract into an asynchronous one.

Cancellation remains a priority path. Fatal recovery requests cancellation, records durable recovery state, stops child processes, and retains the project lock until operation ownership ends or the process exits.

## Bounded external data

Local LLM requests use independent connection, total, and idle deadlines. SSE events, unparsed buffers, JSON/error bodies, reasoning, answers, and retained diagnostics have byte limits. Streaming updates carry deltas instead of repeatedly copying the complete answer.

Child-process stdout and stderr use byte-bounded segmented buffers and throttled notifications. Truncated output is marked explicitly while preserving a valid UTF-8 tail.

## Self-update verification

After a global npm update attempt, Zipflow resolves installed package metadata, verifies that the declared CLI remains inside the package directory, and runs it with the current Node.js executable and `--version`. Results are classified as updated, unchanged, or uncertain. An uncertain replacement permits exit only so the old process cannot continue against an unknown installation state.
