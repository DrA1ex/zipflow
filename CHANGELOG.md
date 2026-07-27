# Changelog

## 1.6.6 — Concrete Codex endpoints and stable model selection

- Display the fully resolved managed Codex Unix-socket address instead of the `unix://` shorthand, so the settings screen shows the real endpoint used on the current machine.
- Show concrete external-server examples (`unix:///absolute/path` and `ws://127.0.0.1:4500`) while keeping the endpoint field editable only when the external-server checkbox is enabled.
- Preserve the explicitly selected model when the model catalogue is refreshed or the Codex ownership checkbox is toggled; clear the selection only when the provider itself changes.
- Add regression coverage for the resolved endpoint value and model preservation.

## 1.6.5 — Simplified Codex connection settings

- Show OpenAI-compatible Base URL and API-mode controls only when the OpenAI-compatible provider is selected.
- Add **Use an external Codex server** as the single ownership switch for Codex connections. With it disabled, the endpoint field is read-only and displays the managed default actually used by Zipflow; with it enabled, the saved custom endpoint becomes editable and connect-only.
- Preserve existing custom Codex endpoint configurations during settings migration by enabling the external-server switch automatically when an older settings document contains a non-default endpoint.
- Replace transport-specific ownership prose in the settings page with a compact list of supported endpoint forms while retaining detailed behavior in the Local LLM guide.

## 1.6.4 — Terlio 1.2.1 and shared Codex endpoints

- Upgrade the exact Terlio.js dependency to 1.2.1 from the user-provided local package, adopt its compact default progress rendering, preserve the prior fractional-cell appearance through the explicit `block` variant, and rely on normalized `Shift+K/J` events for portable check reordering.
- Add an editable **Codex server endpoint** setting supporting `stdio://`, `ws://`, `wss://`, `unix://`, and `unix:///absolute/path`, with optional bearer-token authentication for WebSocket handshakes.
- Use the shared local `unix://` control socket by default: Zipflow first connects and completes `initialize`; only when that managed socket is unavailable does it start one detached `codex app-server --listen unix://` process and reconnect.
- Treat every changed endpoint as connect-only, so user-managed Codex servers are never started, replaced, or duplicated by Zipflow. Keep `stdio://` as an explicit private process-per-request compatibility mode.
- Add real TCP WebSocket and Unix-socket handshake tests, endpoint validation and settings coverage, custom-server no-spawn assertions, and concurrent managed-launch deduplication.

## 1.6.3 — Codex permission-profile protocol

- Initialize Codex app-server with `capabilities.experimentalApi: true`, enumerate `permissionProfile/list` with the replay working directory, and select the built-in `:read-only` profile only when the server reports it as allowed.
- Pass the selected profile through `thread/start.permissions`, as required by the current app-server protocol, without also sending legacy `thread/start.sandbox` or `turn/start.sandboxPolicy`.
- Follow permission-profile pagination, fail closed when `:read-only` is absent or denied by effective requirements, and keep a narrowly scoped compatibility fallback only for app-server versions that do not implement `permissionProfile/list`.
- Add RPC payload, pagination, managed-denial, fail-closed, and legacy-method regression coverage.

## 1.6.2 — Codex sandbox compatibility

- Stop sending the legacy `thread/start.sandbox` enum, whose spelling differs between Codex app-server protocol generations (`readOnly` versus `read-only`).
- Continue enforcing read-only execution through the explicit `turn/start.sandboxPolicy`, so omitting the thread-level compatibility field does not weaken the replay sandbox.
- Add an RPC payload regression assertion that the thread request contains no legacy sandbox field while the turn remains restricted to the replay scratch directory.

## 1.6.1 — Codex timeout determinism and faster RPC tests

- Separated Codex app-server RPC connection timeouts from the model turn's total completion deadline.
- Start idle and total generation timers only after `turn/start` returns a concrete turn ID.
- Made cancellation deterministic by emitting `stream-open` only after both thread and turn IDs are known, then sending `turn/interrupt` with both IDs.
- Kept awaited RPC and completion timers referenced so Node cannot exit with unresolved promises.
- Close Codex app-server processes deterministically and wait briefly for shutdown before escalating to `SIGKILL`.
- Replaced timing-sensitive spawned-process Codex tests with an in-memory stdio RPC fixture, reducing the suite from roughly 16 seconds to under one second on the same runtime.

## 1.6.0 — LLM completion integrity and Codex app-server

- Decouple **Test selected model** from enabled workflow output tasks: its first request now validates a fixed transport marker, while the second request validates only the autonomous-decision schema, so enabling commit-message generation cannot produce a misleading `missing commit message` failure.
- Require explicit provider completion signals for streamed Ollama, OpenAI-compatible, Responses API, and LM Studio generations. EOF, `length`, incomplete Responses, context exhaustion, and disconnected streams now produce typed errors while preserving partial output for diagnostics.
- Mark interrupted historical replays as failed instead of completed, retain partial reasoning and response text, show actionable context/output-limit guidance, and keep `Esc` cancellation bounded by provider cancellation and total/idle deadlines.
- Move replay output to a cached Terlio virtualized line source, throttle chunk invalidation, and bound only the live viewport preview while retaining larger diagnostic buffers, preventing long model responses from repeatedly rewrapping the complete transcript.
- Add a **Codex app-server** provider that launches the configured Codex CLI over stdio JSONL RPC, initializes the session, discovers models and supported reasoning efforts, starts ephemeral read-only threads and turns, validates `turn/completed`, handles context and stream failures, and interrupts turns with both thread and turn identifiers.
- Add end-to-end coverage for the settings compatibility button with commit-message tasks enabled, Codex model discovery and schema output, RPC deadlines and cancellation, provider completion guards, failed replay state, and large virtualized replay output.

## 1.5.0 — Native Ollama and OpenAI-compatible providers

- Replace Ollama's partially compatible `/v1` usage with the native `/api/tags`, `/api/ps`, `/api/show`, and `/api/chat` contracts for model discovery, context inspection, generation, structured output, streaming, and compatibility tests.
- Parse native Ollama NDJSON streams, preserve answer and thinking deltas, report token/duration statistics, and retry unsupported JSON Schema requests with Ollama JSON mode.
- Add a separate **OpenAI-compatible** provider with a configurable `/v1` base URL, optional bearer token, model discovery through `/models`, and selectable Responses API, Chat Completions, or automatic endpoint fallback.
- Add model-selectable reasoning effort values from provider default through `xhigh`, forwarding them as `reasoning.effort` for Responses API or `reasoning_effort` for Chat Completions.
- Reject credentials embedded in the configured base URL, keep tokens in the existing secure credential store, and clear cached model choices after URL or token changes.
- Add end-to-end compatibility coverage for the actual Ollama test button, OpenAI model discovery and both generation transports, endpoint fallback, streaming limits, settings migration, URL validation, and translated interface controls.

## 1.4.0 — Archive interpretation safeguards

- Detect snapshot plans that look like change-focused patch archives by combining deletion volume, deletion ratio, unchanged-file coverage, and missing top-level areas instead of relying on one raw threshold.
- Pause suspicious full-snapshot runs before application and explain why omitted ZIP paths may represent unchanged files rather than intentional removals.
- Add current-run-only **Recheck as patch / overlay** and **Recheck as full snapshot** actions that rebuild the plan, patch, safety warnings, and file decisions without changing the saved workflow.
- Add an optional **Snapshot deletion intent review** Local LLM task plus an on-demand review action that classifies planned removals as intentional, ambiguous, or likely caused by a partial patch.
- Preserve existing LLM summaries and commit-message proposals when an on-demand deletion-intent review is cancelled or fails.
- Add real-ZIP integration coverage, deterministic heuristic regression tests, LLM protocol tests, settings migration coverage, and complete built-in language-pack translations for the new workflow.

## 1.3.17 — macOS Terminal check-reorder fallback

- Added `Shift+K` and `Shift+J` as reliable check-reorder shortcuts for terminal emulators that do not report Shift-modified arrow keys distinctly, including the default macOS Terminal profile.
- Kept `Shift+Up` and `Shift+Down` support for terminals that emit modifier-aware CSI sequences.
- Updated the checks footer, controls documentation, and regression tests to exercise raw printable terminal input rather than assuming `CSI 1;2 A/B` is available everywhere.

## 1.3.16 — Existing-workflow check reorder entry fix

- Open the **Change workflow → Checks** section with an actual check selected instead of the trailing Continue action, so `Shift+Up` and `Shift+Down` work immediately on the screen where ordering is edited.
- Consume modified arrows on non-check rows with a clear status message rather than silently treating them as ordinary menu navigation.
- Report first/last-boundary attempts explicitly and add regression coverage for the complete existing-workflow route without manually forcing the selected index.

## 1.3.15 — Workflow check reordering repair

- Restored `Shift+Up` and `Shift+Down` reordering in the workflow checks menu instead of letting modified arrows fall through to ordinary selection movement.
- Routed setup-specific shortcuts before unrelated asynchronous run-screen handling and the generic busy gate, so modified arrows cannot fall through to ordinary menu navigation.
- Added a Zipflow key-normalization boundary that preserves Shift intent from Terlio raw sequences and accepts compatible modifier representations without changing plain-arrow navigation.
- Added regression coverage using actual Terlio 1.2.0 terminal input events, a full fake-TTY WorkspaceApp path, an active-operation state, and degraded adapter events that retain only the raw escape sequence.

## 1.3.14 — Terlio.js 1.2.0 compatibility

- Updated the pinned Terlio.js dependency and published lock metadata from 1.1.3 to 1.2.0.
- Adapted clipboard actions to Terlio.js 1.2.0 structured copy results so failed copies are no longer reported as successful.
- Explicitly enabled the `auto` clipboard policy to retain native clipboard support with bounded OSC 52 fallback in remote terminals.
- Kept process-level signal ownership in Zipflow by explicitly disabling Terlio.js process handlers.
- Added regression coverage for the dependency metadata, clipboard compatibility layer, runtime ownership, safe syntax styling, and the new smooth progress-bar rendering.
- Updated Terlio-facing interface tests for validated SGR sequences, screen-bound pointer actions, and adaptive multi-line `SelectList` rows.
- Let Guarded and Full autopilot re-evaluate an already used archive without stopping at the manual duplicate warning.
- Made recent-archive age checks portable across filesystems that expose both creation and modification timestamps.

## 1.3.13 — Interrupted recovery actions and selection copy

- Keep interrupted-run recovery on screen during startup instead of immediately replacing it with archive input.
- Clarify that an interrupted run with `applied` metadata is already present in the project and expose explicit keep or rollback actions.
- Preserve the original interrupted stage across repeated launches.
- Restore immediate clipboard copy when Activity or diff text selection is released.

## 1.3.12 — Manual archive selection guard

- Bind SelectList activation callbacks to the screen generation that rendered them.
- Ignore delayed activations after asynchronous navigation so an Enter from archive discovery cannot choose an action on the duplicate-archive warning.
- Apply the same stale-action guard to Settings, path completion, update, and historical replay selections.
- Add regression coverage for the manual recent-archive to duplicate-warning transition.

## 1.3.11 — Runtime progress regression fixes

- Cleared Zipflow's internal sanitized-environment marker when deployment commands intentionally inherit the full environment, while still providing the current project root.
- Kept operation details visible alongside Local LLM progress so applying and inspection screens retain their live stage text and streamed Activity output.
- Rounded live elapsed and median durations to whole seconds for stable progress rendering.
- Gave narrow Settings layouts enough category-pane width for two-line Russian labels instead of clipping the final line.
- Corrected runtime progress regression expectations to use Zipflow's established `Root` command-location label.

## 1.3.10 — Settings and live progress polish

- Prevented `Ctrl+J` from activating Settings or ordinary menu items; it now inserts a line break only in explicitly multiline editors.
- Reworked the Binaries page to use compact `✓`/`✗` states, validate automatically after a selection, show the valid/total count in the page title, and provide one final **Check all** action instead of per-tool test actions.
- Enabled wrapped Settings category labels for longer translations and completed the Russian inherited-environment label plus additional Activity and live Local LLM translations.
- Sorted double-Enter archive recommendations by creation time with the newest candidate first.
- Restored specialized live screens for checks and deployment so current command output is visible again, and added median-based progress for checks, deployment, and Local LLM work with an indeterminate loader when no estimate exists.
- Added regression coverage for Ctrl-J routing, Binaries layout, Russian wrapping and labels, archive ordering, live command output, estimated progress, and localized LLM Activity.

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
