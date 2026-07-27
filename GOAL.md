# Zipflow Release Hardening Goal

## Document purpose

This document defines the phased hardening plan for Zipflow after the 1.3.1 code audit. It is intended to be the stable reference for future implementation work and for continuing the project in a new conversation or development context.

The plan deliberately starts with changes that are narrow, behavior-preserving, and easy to validate with the existing test suite. Larger filesystem and architectural changes are deferred until the current behavior is protected by additional regression tests.

## Primary objective

Prepare Zipflow for a safer, more stable, and more coherent public npm release without unnecessarily redesigning the product or changing established user workflows.

The work should improve:

- filesystem safety;
- Git safety;
- process execution trust boundaries;
- cancellation and operation-state consistency;
- multi-process storage safety;
- LLM request reliability;
- update reliability;
- configuration consistency;
- release reproducibility;
- maintainability of the orchestration layer.

## Guiding rules

1. Preserve current product behavior unless a phase explicitly changes it.
2. Add targeted regression tests before or together with every bug fix.
3. Run the complete test suite with the user-provided Terlio package after every phase.
4. Keep public package registry URLs unchanged.
5. Use English for all project documentation, source comments, tests, and Markdown.
6. Avoid broad formatting or style changes in unrelated files.
7. Prefer one shared mechanism over repeated local fixes.
8. Do not introduce TypeScript during this hardening effort.
9. Do not implement terminal escape sanitization in Zipflow yet; this is deferred to Terlio.
10. Do not publish a phase until its migration, regression, package, and clean-install tests pass.

## Explicit product decisions

The following decisions are approved and must be preserved throughout implementation:

- Git hooks are disabled for automatic Zipflow commits by default.
- A configured project may later explicitly allow Git hooks through project settings.
- The Git-hooks option belongs in the configured workflow/project settings, not in the initial setup wizard.
- Internal binary paths are configurable in global settings.
- Binary settings show the resolved path, support path completion, and validate the selected executable.
- Project checks and deployment commands use a sanitized environment by default.
- The environment policy is configurable globally.
- Full Autopilot receives a clear warning modal, but the product should not be overloaded with excessive additional confirmation layers.
- Dependency versions are pinned for reproducible npm installations.
- Large-output handling should use the Terlio large-text mechanism where suitable; otherwise Zipflow will use bounded Buffer chunk queues.
- State consistency improvements must be implemented without converting the project to TypeScript.
- Release engineering additions should remain minimal and practical.

## Deferred work

### Terminal escape sanitization

Terminal control-sequence sanitization is intentionally deferred. It should be fixed in Terlio so every application using the library receives the same protection. Zipflow should later adopt the fixed Terlio release and add integration tests, but should not create a competing local sanitizer in this plan.

### Large architectural redesign

The first phases must not perform a broad rewrite. Use-case extraction and state restructuring happen only after low-risk hardening has passed the complete test suite.

---

# Phase 0 — Baseline and change control

## Goal

Create a reliable baseline before hardening begins, so every later change can be compared against known behavior.

## Work items

1. Record the current Zipflow version, package contents, and full test result.
2. Install dependencies using the user-provided Terlio package and the exact dependency set used by the project.
3. Run and archive:
   - `npm run check`;
   - full `npm test`;
   - `npm pack --dry-run`;
   - clean installation from the generated `.tgz` into an isolated npm prefix;
   - basic `zipflow --version` and startup smoke tests.
4. Add a release-hardening test grouping or naming convention so new tests are easy to identify.
5. Confirm that no current behavior is intentionally changed in this phase.

## Deliverables

- passing baseline test report;
- recorded package manifest;
- clean-install smoke result;
- this `GOAL.md` committed to the project.

## Exit criteria

- The complete current test suite passes.
- The packed npm artifact installs and starts in an isolated prefix.
- All later phase branches can be compared against this baseline.

---

# Phase 1 — Low-risk correctness and reproducibility

## Goal

Fix narrow correctness defects and make installations reproducible without changing the main workflow architecture.

## 1.1 Pin runtime dependencies

### Changes

- Replace caret ranges for runtime dependencies with exact versions.
- Add `npm-shrinkwrap.json` so the published package installs the tested dependency graph.
- Keep public npm registry URLs.
- Ensure the shrinkwrap is included in the published package.
- Add a release test that installs the packed `.tgz` and verifies resolved dependency versions.

### Acceptance criteria

- Two clean installations of the same Zipflow version resolve identical runtime dependency versions.
- Terlio behavior is fixed to the tested version.

## 1.2 Use a reliable SemVer implementation

### Changes

- Replace custom numeric SemVer comparison with the pinned `semver` package or an equivalent exact string-based implementation.
- Cover prerelease, build metadata, very large numeric identifiers, and invalid registry responses.

### Acceptance criteria

- Update checks make correct decisions for all valid SemVer cases.
- Invalid versions never reach npm installation commands.

## 1.3 Preserve cancellation semantics for checks

### Changes

- Do not convert `cancelled` process errors into failed test results.
- Propagate cancellation to the workflow operation layer.
- Keep genuine process failures represented as failed checks.

### Tests

- cancelling a running test returns a cancelled operation;
- cancellation does not increase the failed-check count;
- a real exit code still creates a failed result;
- cancellation does not trigger LLM failure explanation automatically.

## 1.4 Guarantee operation release

### Changes

- Add `try/finally` to every operation that currently calls `begin()` and manually calls `finish()`.
- Introduce a helper such as `operationManager.run(kind, callback)` for scoped operations.
- Migrate the Git checkpoint path first.

### Acceptance criteria

- An exception in status collection, LLM generation, Git checkpoint creation, persistence, or rendering never leaves an operation active.

## 1.5 Harden built-in command arguments

### Changes

- Prefix relative paths with `./` where needed.
- Pass `--` before filenames where the tool supports it.
- Validate all built-in check argument construction.

### Tests

Use filenames such as:

- `--eval`;
- `--help`;
- `-write.go`;
- `-`;
- names containing spaces and Unicode.

### Acceptance criteria

- Built-in checks treat every discovered path as a file, never as an option.

## 1.6 Make command-directory syntax unambiguous

### Changes

- Parse `cwd :: command` only when the left side matches a valid relative directory form.
- Do not interpret `::` inside quoted command text as a directory separator.
- Add escaping or a documented literal syntax if needed.
- Continue storing `cwd` and `commandText` separately.

### Tests

- `web/ :: npm test` resolves to `cwd=web`;
- `python -c 'print("a::b")'` remains a root command;
- invalid or outside-workspace paths are rejected.

## 1.7 Preserve executable modes on updates

### Changes

- Distinguish a missing ZIP mode from an explicit non-executable mode.
- Preserve an existing file mode when an updated archive entry has no mode metadata.
- Use a safe default for newly created files.

### Acceptance criteria

- Updating an executable script without mode metadata does not remove its executable bit.

## 1.8 Add run and temporary-data retention

### Changes

- Add retention for run history by age and total size.
- Remove orphaned temporary directories at startup.
- Never prune active runs.
- Allow important runs to be retained if the existing model supports it without large UI changes.

### Acceptance criteria

- Storage remains bounded.
- Active and explicitly protected runs are not removed.

## 1.9 Make atomic JSON writes durable

### Changes

For critical JSON files:

1. write through a file handle;
2. call `fsync`/`sync` on the temporary file;
3. atomically rename it;
4. sync the parent directory.

Apply this to:

- settings;
- workflows;
- run records;
- archive indexes;
- backup manifests;
- active-operation metadata.

### Acceptance criteria

- Existing backup recovery still works.
- Interrupted-write tests never produce partially valid JSON.

## 1.10 Improve project-lock identity without overengineering

### Changes

Extend the lock with:

- PID;
- creation timestamp;
- random owner token;
- lightweight heartbeat timestamp.

Do not build a complex distributed-lock system in this phase.

### Acceptance criteria

- A stale PID reused by an unrelated process does not keep a project locked indefinitely.
- Normal project locking remains backward compatible.

## Phase 1 exit criteria

- Full test suite passes.
- Clean `.tgz` installation passes.
- No main workflow screen or wizard behavior changes except documented bug fixes.

---

# Phase 2 — Configuration and execution trust boundaries

## Goal

Make executable selection, Git hooks, process environments, initial commits, and Full Autopilot behavior explicit and configurable.

## 2.1 Global internal-binary settings

### New settings section

Add a global `Binaries` section.

Suggested entries:

- Git;
- npm;
- Node.js, if required internally;
- system opener (`open` or `xdg-open`);
- Python, Go formatter, or other internally invoked optional tools only where Zipflow owns the invocation.

### UI behavior

Each row shows:

- logical tool name;
- resolved absolute path;
- validation status;
- whether the value is automatic or manually selected.

Actions:

- `Use detected binary`;
- `Choose path`;
- `Reset to automatic`;
- `Test binary`.

Path editor requirements:

- filesystem path completion;
- `Shift+Tab` parent navigation;
- no global single-key shortcuts while editing;
- executable validation before saving;
- validation of realpath and file type;
- version/protocol probe when available.

### Resolution policy

For internal trusted operations:

- do not resolve through project-local `node_modules/.bin`;
- prefer trusted absolute system paths;
- persist an explicitly validated path;
- reject missing, non-executable, directory, or unsafe paths.

User checks and deploy commands continue to use the project command environment.

## 2.2 Project option for Git hooks

### Default

Automatic Zipflow commits run with hooks disabled.

### Project setting

Add a configured-flow project option:

```text
Git hooks for automatic commits
- Disabled — recommended
- Allow project Git hooks
```

It must not appear in the first-run wizard.

### Behavior

- Disabled mode uses a trusted empty hooks directory via Git configuration.
- Enabled mode uses normal project Git hook behavior.
- The final commit review should indicate when hooks are enabled.
- Existing workflows migrate to hooks disabled.

### Tests

- malicious or failing pre-commit and post-commit hooks are not run by default;
- explicit project opt-in runs hooks;
- changing the setting does not affect manual Git operations outside Zipflow.

## 2.3 Global process environment policy

### New global setting

```text
Project command environment
- Sanitized environment — default
- Inherit full environment
```

A later version may add a custom allowlist, but it is not required in the first implementation.

### Sanitized default

Keep only a documented safe base such as:

- `PATH`, after policy-specific construction;
- `HOME`;
- `USER`/`LOGNAME`;
- locale variables;
- terminal variables needed by child tools;
- platform essentials;
- explicit Zipflow non-secret runtime variables.

Remove common secret-bearing variables and agent sockets by default, unless required and explicitly allowed.

### UI

Before the first project command execution under sanitized mode, show a concise explanation only when helpful; do not create repeated confirmation fatigue.

### Tests

- secret-like environment variables are absent in sanitized mode;
- they remain available in inherited mode;
- working directory and normal package-manager execution still work.

## 2.4 Safer initial Git commit

### Changes

- Enumerate initial commit candidates.
- Reuse sensitive-path detection.
- Exclude Zipflow internal files independently of `.gitignore`.
- Present a review when sensitive or suspicious files are found.
- Stage approved paths explicitly rather than using unrestricted `git add --all`.

### Acceptance criteria

- `.env`, credentials, private keys, and other suspicious files are not silently committed.
- Existing ordinary initial-commit workflows remain simple when no risk is found.

## 2.5 Full Autopilot warning modal

### Behavior

When Full Autopilot is enabled for a workflow or first used after enabling:

- show one clear warning modal;
- explain that project/archive content is untrusted model input;
- explain that Zipflow applies deterministic safety checks but model decisions can still be wrong;
- keep high-risk deterministic blocks in place;
- do not add excessive repeated confirmation screens.

### Persistence

Store acknowledgement per workflow or settings version so wording changes can request acknowledgement again if necessary.

## Phase 2 exit criteria

- Internal tools use validated absolute paths.
- Git hooks are disabled by default and can be explicitly enabled per configured project.
- Project commands use sanitized environments by default.
- Initial commit does not silently include sensitive files.
- Full Autopilot has a clear one-time warning.
- Full test suite and package install smoke pass.

---

# Phase 3 — Operation-state consistency and UI concurrency

## Goal

Make operation state the single source of truth and remove races between asynchronous input, cancellation, error handling, and screen transitions.

## 3.1 Consolidate operation-derived state

### Changes

Define one operation model with states such as:

- `idle`;
- `running`;
- `cancelling`;
- `critical`;
- `completed`;
- `failed`;
- `cancelled`.

Generate UI capabilities from this state:

- `canApply`;
- `canCancel`;
- `canStartLlm`;
- `canRunChecks`;
- `canCommit`;
- `canDeploy`;
- `canOpenSettings`.

Stop using `state.busy` as an independent decision source. It may remain temporarily as a derived presentation field during migration.

### Acceptance criteria

- Impossible combinations such as an idle UI with an active operation cannot be created through normal transitions.
- Conflicting actions are disabled before reaching `OperationManager.begin()`.
- Late conflicts still produce nonfatal notices.

## 3.2 Serialize UI actions

### Changes

- Route async key and pointer actions through a shared queue.
- Keep rapid wheel/navigation events coalesced where useful.
- Preserve existing submit gating.
- Add screen-generation tokens so stale async completion results cannot update a newer screen.
- Cancel outdated path-completion and search operations.

### Acceptance criteria

- Two rapid actions cannot activate the same transition concurrently.
- An async result from a previous editor/screen is ignored after navigation.

## 3.3 Safe fatal-error cleanup

### Changes

A fatal UI or orchestration error must:

1. request cancellation of the active operation;
2. wait for a safe cancellation boundary or critical-section completion;
3. write recovery state;
4. stop active child processes;
5. release the project lock only after operation ownership ends;
6. then show or persist the fatal error.

### Acceptance criteria

- A second Zipflow instance cannot enter the same project while the first process is still modifying it after a UI error.

## 3.4 Verify interrupted self-update state

### Changes

After a cancelled or failed global npm update:

- detect the installed Zipflow version;
- verify the executable exists;
- run a minimal `--version` probe;
- distinguish unchanged, successfully updated, and uncertain installation states;
- do not allow the old process to continue normally after an uncertain replacement.

Consider treating the package-replacement subphase as critical once npm begins destructive replacement.

## Phase 3 exit criteria

- All asynchronous UI transitions are serialized or explicitly generation-guarded.
- Operation state drives action availability.
- Fatal errors cannot prematurely release project ownership.
- Interrupted self-update has a deterministic recovery result.

---

# Phase 4 — Streaming, output, storage, and multi-process reliability

## Goal

Bound resource use and prevent independent Zipflow instances from corrupting shared state or pruning each other's active data.

## 4.1 LLM request deadline and size limits

### Changes

Add independent limits for:

- connection timeout;
- total request deadline;
- idle time between stream chunks;
- maximum SSE event size;
- maximum unparsed buffer size;
- maximum reasoning size;
- maximum answer size;
- maximum retained raw response size.

Use delta updates for streaming UI where possible rather than repeatedly copying the full accumulated response.

### Acceptance criteria

- A server that opens a stream and then stalls is cancelled.
- Oversized output fails with a typed, user-readable error.
- Normal long responses continue to stream.

## 4.2 Large process-output handling

### Preferred implementation

Use Terlio's large-text/streaming source mechanism if it supports bounded append and visible-window rendering without retaining repeated full-string copies.

### Fallback

Use a Buffer-chunk ring:

- append Buffer chunks;
- maintain a byte count;
- discard oldest chunks over the limit;
- decode only the needed window or final result;
- throttle UI updates.

### Acceptance criteria

- Large stdout/stderr does not cause quadratic string copying.
- UTF-8 limits are enforced by bytes, not JavaScript character count.

## 4.3 Global storage coordination

### Changes

Add simple inter-process locks or leases for:

- settings writes;
- archive index writes;
- backup pruning/clearing;
- run-history pruning.

Add active run leases with heartbeat so cleanup protects all active runs, not only the current process.

Use revision/CAS for Settings to detect lost updates.

### Acceptance criteria

- Two instances changing unrelated settings do not silently overwrite each other.
- One instance cannot remove another active instance's backup or run data.

## Phase 4 exit criteria

- LLM and process output are bounded.
- Shared storage is safe for normal multi-instance use.
- Full test suite passes under concurrent storage tests.

---

# Phase 5 — Archive, backup, and disk preflight hardening

## Goal

Harden source identity, backup integrity, and capacity checks before changing the core apply transaction.

## 5.1 Read and hash the archive through one file descriptor

### Changes

- Open the source ZIP once with no-follow semantics.
- Capture identity with `fstat`.
- Hash from the descriptor.
- Read ZIP entries from the same descriptor.
- Revalidate identity before closing.

### Acceptance criteria

- Replacing the ZIP pathname after inspection cannot change the extracted archive.
- Stored source hash always matches the archive actually read.

## 5.2 Atomic and verified backup creation

### Changes

- Create backup in a temporary directory.
- Hash each copied file.
- Compare copied content with the expected pre-apply hash.
- Write and sync the manifest only after every file is verified.
- Atomically rename the completed backup directory into place.

Before rollback:

- verify every required backup file hash;
- refuse to restore corrupted backup content;
- explain the exact integrity error.

### Acceptance criteria

- A partial or modified backup is never treated as valid.
- Existing successful rollback behavior remains unchanged.

## 5.3 Disk-space preflight

### Changes

Estimate required capacity for:

- archive extraction;
- backup;
- temporary replacement files;
- reports and patches;
- rollback reserve.

Check project and Zipflow storage filesystems separately.

### Acceptance criteria

- Obvious insufficient-space conditions fail before extraction/apply.
- Error text reports required and available space.

## Phase 5 exit criteria

- Archive identity and backup integrity are descriptor/hash verified.
- Disk-space failures occur before project mutation where reasonably predictable.

---

# Phase 6 — Hardened filesystem transaction layer

## Goal

Eliminate the most important time-of-check/time-of-use windows during apply and rollback.

This is the first intentionally deep implementation phase and must start only after Phases 0–5 are stable.

## 6.1 Transaction abstraction

Create a dedicated filesystem transaction service responsible for:

- validating project-relative paths;
- checking parent-directory safety;
- comparing expected current file state;
- preparing temporary replacement files;
- preserving or applying modes;
- atomic replacement;
- deletion;
- rollback;
- transaction logging.

The controller and run flow must not perform direct project mutations outside this layer.

## 6.2 Per-file compare-and-swap

For every update/delete:

1. inspect the exact current target immediately before mutation;
2. compare type, hash, identity metadata, and expected state;
3. abort if the target changed since planning/backup;
4. mutate only after the check succeeds.

For every create:

- verify the destination still does not exist immediately before creation.

## 6.3 Rollback preconditions

Before replacing any current file during rollback:

- verify it still matches the run's `afterHash` or expected created/deleted state;
- stop before overwriting unrelated post-run edits;
- present a conflict review instead of forcing restoration.

## 6.4 Parent-directory race reduction

Within Node.js limits:

- repeatedly canonicalize and verify parents;
- reject symlinked parent changes;
- use no-follow flags for leaf operations;
- minimize time between verification and rename;
- document the remaining platform limitation.

If a small native helper becomes necessary for descriptor-relative `openat`/`renameat`, that requires a separate design decision and is not assumed by this goal.

## 6.5 Transaction journal and recovery

Persist enough state to distinguish:

- planned;
- backup complete;
- mutation in progress;
- mutation complete;
- rollback in progress;
- rollback complete.

Recovery must be idempotent.

## Acceptance criteria

- A concurrent file edit between planning and mutation is detected before that file is overwritten.
- A concurrent edit after apply is detected before rollback overwrites it.
- Partial failures recover only verified transaction-owned changes.
- Existing ZIP, symlink, conflict, backup, rollback, cancellation, and dirty-tree tests pass.

---

# Phase 7 — Architecture consolidation without TypeScript

## Goal

Reduce orchestration complexity after safety behavior is stable.

## 7.1 Extract use cases

Introduce explicit use-case modules such as:

- `InspectArchiveUseCase`;
- `ReviewArchiveUseCase`;
- `ApplyUpdateUseCase`;
- `RunChecksUseCase`;
- `CreateCheckpointUseCase`;
- `CreateResultCommitUseCase`;
- `DeployUseCase`;
- `SelfUpdateUseCase`.

Each use case should:

- own its operation scope;
- accept explicit dependencies;
- return a typed result object;
- avoid direct screen transitions;
- avoid implicitly starting the next use case.

## 7.2 Improve state consistency without TypeScript

Use JSDoc discriminated unions and runtime constructors.

Add:

- centralized screen identifiers;
- centralized operation identifiers;
- state constructors;
- transition assertions;
- exhaustive switches with unreachable-state errors;
- derived capability selectors.

Do not convert the codebase to TypeScript.

## 7.3 Versioned schemas

Add schemas for:

- global settings;
- workflows;
- run records;
- backup manifests;
- archive indexes;
- operation/recovery records.

Loading pipeline:

```text
parse → validate stored version → migrate → validate current version
```

Do not silently discard invalid known fields. Produce diagnostics and use safe recovery behavior.

## 7.4 Reduce controller and render coupling

- Move screen-specific actions into focused presenters/controllers.
- Keep rendering pure where practical.
- Keep one source of truth for editor screens, shortcuts, capabilities, and help context.
- Avoid unrelated formatting changes during extraction.

## Phase 7 exit criteria

- Core orchestration files have substantially lower fan-out.
- Operation ownership and result flow are explicit.
- Invalid state transitions are detected during tests.
- Existing UX remains functionally equivalent.

---

# Phase 8 — Minimal release engineering

## Goal

Add only the release safeguards that provide high value without creating excessive maintenance burden.

## 8.1 CI

Add a small CI matrix:

- Ubuntu;
- macOS;
- current supported Node.js versions, initially Node 20 and 22.

Required jobs:

- `npm run check`;
- full tests;
- package dry run;
- install generated `.tgz` into isolated prefix;
- global CLI smoke;
- public registry URL check.

## 8.2 Security and package metadata

Add or verify:

- `SECURITY.md`;
- `repository`;
- `bugs`;
- `homepage`;
- supported Node version;
- supported platforms;
- vulnerability-reporting instructions.

## 8.3 Lightweight dependency and provenance checks

- run `npm audit --omit=dev` in CI;
- enable dependency review where available;
- publish with npm provenance when release infrastructure supports it;
- generate an SBOM only if it can be added without complicating the release process.

## 8.4 Coverage focus

Do not enforce a high global coverage percentage immediately. Add focused coverage requirements for:

- archive validation;
- filesystem transaction code;
- backup and rollback;
- Git safety;
- operation management;
- binary resolution;
- update execution.

## Phase 8 exit criteria

- Every release is tested as the package users actually install.
- Basic security reporting and dependency checks exist.
- CI remains small enough to maintain.

---

# Implementation sequence summary

The approved implementation order is:

1. **Phase 0:** freeze and record the baseline.
2. **Phase 1:** narrow bug fixes, exact dependencies, durability, retention, and argument safety.
3. **Phase 2:** binary settings, hooks policy, sanitized environments, safer initial commit, Full Autopilot warning.
4. **Phase 3:** operation-state and async UI consistency.
5. **Phase 4:** bounded streams/output and multi-process storage safety.
6. **Phase 5:** archive identity, backup verification, and disk preflight.
7. **Phase 6:** hardened apply/rollback transaction layer.
8. **Phase 7:** use-case and state/schema architecture cleanup.
9. **Phase 8:** minimal CI and public-release safeguards.

Phases 0–2 are intentionally composed mostly of localized changes so current tests and behavior can be used as a strong regression baseline. Phase 6 is the largest behavioral risk and must not begin until the earlier phases are complete and stable.

---

# Required validation after every phase

Every phase must finish with:

1. `npm run check`;
2. full `npm test` using the user-provided Terlio package;
3. targeted new regression tests;
4. `npm pack --dry-run`;
5. installation of the generated `.tgz` into a clean isolated prefix;
6. CLI startup/version smoke;
7. ZIP/tarball integrity check;
8. verification that tests, local state, `node_modules`, and unintended lock files are not published;
9. documentation and language-pack synchronization;
10. a concise changelog entry describing user-visible changes and migration behavior.

No phase is complete if only static or partial tests pass.

---

# Definition of release readiness

Zipflow is ready for a broader public npm release when:

- Phases 0–6 are complete;
- automatic commits cannot run project hooks unless explicitly allowed;
- internal tools use validated binaries;
- project commands use the documented environment policy;
- archive identity and backup integrity are verified;
- apply and rollback detect concurrent changes immediately before mutation;
- operation cancellation and fatal cleanup are consistent;
- global storage is safe for multiple instances;
- LLM and process output cannot grow without bounds;
- exact runtime dependency versions are installed;
- the packed global package passes a clean-install smoke test on Linux and macOS.

Phases 7 and 8 improve maintainability and release discipline and should follow before declaring the project fully mature, but the core safety boundary is established by Phases 0–6.


---

# Phase 6 — LLM completion integrity and Codex RPC

## Goal

Make model testing and historical replay report only verified provider completion, keep large partial output responsive, and support the locally authenticated Codex CLI without requiring an HTTP compatibility server.

## Delivered work

- separate the transport compatibility marker from workflow summary and commit-message tasks;
- require terminal completion events from streamed providers and preserve typed partial-output failures;
- render historical replay through a cached Terlio virtualized line source with bounded live previews;
- add Codex app-server stdio RPC model discovery, reasoning effort, ephemeral read-only turns, deadlines, and cancellation;
- cover the complete Settings test action, interrupted replay, context exhaustion, long output, and RPC lifecycle with regression tests.

## Exit criteria

- a truncated or disconnected model response never produces `Replay completed`;
- the model compatibility button cannot fail merely because a workflow output task such as commit-message generation is enabled;
- large replay output remains scrollable and cancellable without rebuilding the complete rendered transcript on every chunk;
- Codex model selection and generation work through the configured local CLI and require a successful `turn/completed` state.


---

# Phase 6.1 — Shared Codex transport and Terlio 1.2.1

## Goal

Make Codex app-server connection ownership explicit and reusable while adopting the portable interaction and rendering fixes from Terlio.js 1.2.1.

## Delivered work

- upgrade and test against the user-provided Terlio.js 1.2.1 package;
- rely on Terlio-normalized `Shift+K/J` input and cover the new compact/default versus explicit `block` progress behavior;
- expose an editable Codex endpoint for stdio, local/secure WebSocket, and Unix sockets;
- probe and reuse the default shared Unix-socket server before starting a background listener;
- keep all custom endpoints connect-only and preserve `stdio://` as an explicit private compatibility mode;
- cover authenticated WebSocket handshakes, Unix-socket framing, no-spawn custom endpoints, and concurrent managed launch reuse.

## Exit criteria

- two operations can use an already running compatible Codex server without starting another instance;
- changing the endpoint never causes Zipflow to launch that user-managed server;
- the endpoint is editable even before Codex is selected as the active provider;
- the complete suite passes using the uploaded Terlio.js 1.2.1 package.


# Phase 6.2 — Clear provider-specific LLM settings

## Goal

Keep Codex connection ownership explicit without exposing unrelated OpenAI-compatible controls or requiring users to infer behavior from endpoint spelling.

## Scope

- show Base URL and OpenAI API mode only for the OpenAI-compatible provider;
- add one external-Codex-server toggle;
- show the actual managed default endpoint as a disabled value when the toggle is off;
- restore the saved custom endpoint when the toggle is enabled;
- preserve older non-default endpoint configurations through migration.

## Acceptance

- Codex settings contain no OpenAI-compatible Base URL or API-mode rows;
- disabling the external-server toggle forces the managed default at runtime even when a custom endpoint remains saved;
- enabling the toggle makes the saved endpoint editable and prevents managed fallback for custom network or socket endpoints.
