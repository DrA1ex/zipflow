# Local LLM integration

Zipflow supports four provider modes:

```text
Ollama:            http://127.0.0.1:11434
LM Studio:         http://127.0.0.1:1234
OpenAI-compatible: configurable base URL, normally ending in /v1
Codex app-server:  configurable stdio, WebSocket, or Unix-socket RPC
```

The provider, optional bearer token, selected model, and output languages are configured in global settings. OpenAI-compatible and Codex app-server providers expose a reasoning-effort setting; only OpenAI-compatible uses the configurable HTTP API mode. Codex can use a bearer token during an authenticated WebSocket handshake. Bearer tokens are stored in macOS Keychain or the Linux system keyring rather than `~/.zipflow` JSON files. On Linux, persistence requires `secret-tool` and an active Secret Service provider; when secure storage is unavailable, Zipflow refuses to save a new token instead of falling back to plaintext.

## Choose the LLM tasks

The **LLM tasks** page contains independent checkboxes. Enable only the outputs you want:

- **Archive suitability review** — ask whether the archive plausibly belongs to the current workspace;
- **Snapshot deletion intent review** — for snapshot plans that trigger Zipflow's partial-patch heuristic, ask whether the planned removals have affirmative support in the visible changes;
- **Change summary** — generate a concise human-readable description of the source changes;
- **Failed-check explanations** — offer an LLM explanation after a configured check fails;
- **Update commit message** — generate a Git commit-message candidate for the applied archive update;
- **Dirty-tree checkpoint message** — generate the checkpoint message from tracked local changes that already existed before the archive is applied.

The tasks do not depend on each other. For example, Zipflow can request only an update commit message, only a dirty-tree checkpoint message, or both without generating a summary or archive verdict. Turning every task off keeps the provider and model configuration but prevents ordinary workflow LLM requests. Autopilot model decisions remain a separate capability and compatibility check.

Ordinary summaries and verdicts are advisory. Local LLM failures do not block manual archive application.

### Snapshot deletion intent

The deletion-intent task runs automatically only when it is enabled, the current archive interpretation is a full snapshot, the plan contains removals, and Zipflow's deterministic partial-patch heuristic is suspicious. The same check can be requested manually from the plan or archive-safety menu.

This is separate from the general archive-suitability verdict. Its response is limited to `intentional`, `ambiguous`, or `likely-partial`, with factual reasons and confidence. Zipflow supplies project/archive structure, a complete or explicitly bounded deletion manifest, and representative excerpts from files that are actually added or changed. The prompt forbids treating simple absence from the ZIP as proof that deletion was intended.

A likely-partial or ambiguous result returns the run to safety review. It does not automatically reinterpret the archive; the user can choose **Recheck as patch / overlay**. Cancelling or failing this optional review preserves any existing summary, commit-message proposal, and general archive assessment.

## Archive review methods

When **Archive suitability review** is enabled, **Archive review method** controls the evidence used for its verdict:

- **Structure guard** — compare current and archive trees;
- **Sample guard** — add the complete changed-path manifest and representative excerpts from up to five priority files;
- **Deep patch review** — assess the selected change representation.

Summary and commit-message fields are requested only when their corresponding tasks are enabled. A strongly unsuitable structure verdict stops later change-output generation for that request and explains why the archive appears unrelated. It does not replace deterministic validation.

## Change delivery modes

The independent **Change delivery** setting controls source evidence for archive review, summaries, update commit messages, and dirty-tree checkpoint messages:

- **Adaptive**;
- **Full patch**;
- **Representative sample**;
- **Capped batches**;
- **Changed paths only**;
- **File-by-file chunks**.

Bounded modes report both manifest coverage and file-content coverage so a partial review is not presented as exhaustive.

The complete `changes.patch` remains stored in the run even when the model receives a reduced representation.

## Failed checks

Enable **Failed-check explanations** in **LLM tasks** to make the action available after a check failure. The independent **Failed-check context** setting chooses whether Zipflow:

- uses a fresh model context; or
- continues from the compact context of the preceding change review.

Same-context analysis sends the prior result with the failed command and output rather than resending the complete patch.

## Commit messages

When **Dirty-tree checkpoint message** is enabled and Zipflow creates a Git checkpoint for tracked local changes, it builds a diff of the current tracked working tree without staging or modifying it. The configured change-delivery policy decides whether the model receives a full patch, representative sample, capped batches, changed paths only, or file-by-file chunks. A failed or cancelled generation falls back to the deterministic `zipflow checkpoint <run-id>` message.

The workflow commit-message source determines the preferred proposal, not the only available one. At commit time Zipflow can show distinct messages from:

- the local LLM;
- archive metadata;
- a workflow template;
- the deterministic generated fallback.

**Edit message…** opens the preferred proposal in a multiline editor. A useful summary can still be retained when the model's commit message cannot be recovered.

## Prompt budgets and retries

Before generation, Zipflow discovers model context information where possible and calculates a conservative prompt budget that reserves space for instructions and output.

Large changes are shortened structurally rather than cut at an arbitrary byte offset. The changed-file manifest is retained and diff hunks are distributed across files.

Context-overflow and out-of-memory responses trigger a smaller-patch retry and are reported explicitly. Stream EOF is not treated as success: a provider must report its terminal completion state, otherwise Zipflow preserves the partial output and returns an `incomplete_generation` or `context_exceeded` error.

## Streaming resource limits

Generation has independent deadlines for opening the connection, completing the entire request, and receiving the next stream chunk. A server that opens an SSE or NDJSON response and then stalls is cancelled rather than waiting indefinitely.

Zipflow also enforces byte-based limits for one SSE event or NDJSON record, the unparsed line buffer, model reasoning, answer text, and retained raw diagnostics. Exceeding a limit produces a typed, readable Local LLM error. Live Activity and replay workspaces consume response deltas and retain bounded preview windows instead of copying the complete accumulated response for every chunk. Historical replay uses a cached Terlio virtualized line source, so elapsed-time updates and scrolling do not repeatedly wrap the complete model transcript.

## LM Studio behavior

LM Studio uses its native model catalog and streaming chat API. Zipflow can read parameter counts, loaded-instance configuration, context size, and load or prompt-processing progress.

Selecting a model opens its load configuration. **Save and select** unloads stale LLM instances when necessary and reloads the chosen model, leaving one active LLM instance. Reviews and compatibility tests address the selected loaded instance directly so a second copy of the same model is not created accidentally.

Configurable values can include context length, evaluation batch size, Flash Attention, KV-cache placement, and expert count when supported by the model and server.

## Ollama behavior

Ollama uses its native API throughout. Model selection reads `GET /api/tags`; compatibility and context inspection use `GET /api/ps` and `POST /api/show`; generation uses `POST /api/chat` and parses its NDJSON stream. When a structured response is requested, Zipflow first sends the JSON Schema through Ollama's native `format` field and retries with native JSON mode if that server/model rejects the schema.


## OpenAI-compatible behavior

Set **Base URL** to the API root, including the version prefix expected by the server, normally `/v1`. Zipflow appends `/models`, `/responses`, or `/chat/completions`; credentials belong in **Authentication**, not in the URL.

**OpenAI API mode** can force the Responses API, force Chat Completions, or use **Auto**. Auto tries `POST /responses` first and falls back to `POST /chat/completions` only when the Responses endpoint is absent or unsupported. This keeps Responses-only coding models usable without breaking local servers that implement only Chat Completions.

**Reasoning effort** is optional. **Provider default** omits the field. Explicit values are sent as `reasoning.effort` to the Responses API and `reasoning_effort` to Chat Completions. Availability still depends on the selected server and model; a provider error is shown by **Test selected model** rather than silently changing the requested effort.

Model discovery uses `GET /models`. The selected model ID is sent unchanged, so aliases and server-specific model names remain usable.

## Codex app-server behavior

Choose **Codex app-server** to use an already authenticated Codex installation through JSON-RPC. The Codex-only connection controls are shown only while this provider is selected; OpenAI-compatible Base URL and API-mode controls are kept on the OpenAI-compatible provider page.

By default, **Use an external Codex server** is off. The endpoint field is disabled and shows the fully resolved managed Unix-socket address that Zipflow will actually use, such as `unix:///Users/name/.codex/app-server-control/app-server-control.sock`. Zipflow first connects and completes the `initialize` handshake. If that managed endpoint is unavailable, it resolves the configured `codex` binary, starts one detached app-server, and reconnects. A compatible server that is already listening is reused, including across concurrent Zipflow operations.

Enable **Use an external Codex server** to edit the endpoint and connect to a server you manage yourself. Supported editable values are `unix:///absolute/path`, local `ws://` (for example `ws://127.0.0.1:4500`), remote `wss://`, and `stdio://`. Custom WebSocket and Unix-socket endpoints are connect-only and are never started by Zipflow. `stdio://` explicitly requests a private process for each request. Plain `ws://` is accepted only for localhost; use `wss://` or an SSH port forward for remote servers. **Authentication** supplies an optional bearer token during the WebSocket handshake.

Each generation uses an ephemeral thread rooted in a private temporary directory and `approvalPolicy: never`. Zipflow opts into the experimental app-server surface, reads the paginated `permissionProfile/list` catalog for that directory, requires the built-in `:read-only` profile to be explicitly allowed, and passes its id through `thread/start.permissions`. It does not combine the profile with the legacy thread `sandbox` field or a turn-level `sandboxPolicy`.

If an older app-server does not implement `permissionProfile/list` at all, Zipflow uses only the stable legacy read-only sandbox shape without the removed `access` field. A server that advertises permission profiles but omits or denies `:read-only` fails closed instead of silently broadening access. Zipflow submits text through `turn/start`, forwards the selected model and reasoning effort, and passes a JSON Schema when structured output is required. It does not grant Codex access to the active project or ask it to run tools.

A request succeeds only after a matching `turn/completed` notification reports `completed`. Interrupted or failed turns, context-window errors, stream disconnects, idle timeouts, and the total deadline remain failures with partial output retained for replay diagnostics. `Esc` sends `turn/interrupt` with the active thread and turn identifiers.

## Output parsing and diagnostics

**Test selected model** is deliberately independent from the enabled workflow tasks. Its first request checks a fixed transport marker; its second request validates the autonomous-decision schema. Primary workflow generation still uses a readable section protocol containing only the outputs selected in **LLM tasks**. A commit-only request, for example, asks for and validates only `COMMIT MESSAGE`.

When a model ignores the requested format or spends its output budget on reasoning, Zipflow can perform a hidden compact repair request. If only a useful summary can be recovered, the summary is kept and another commit-message source is used.

Provider errors and sanitized raw diagnostics are saved under the run directory as:

```text
llm-diagnostics.json
```

Press `Esc` during review generation to cancel only that local LLM request. Archive analysis continues with normal fallbacks.

## Replay and model testing

**Test selected model** provides:

- a quick connection and generation compatibility check;
- an autonomous-decision compatibility check when autopilot is being configured;
- a read-only replay of a historical archive update using current settings;
- a read-only Guarded-versus-Full autopilot simulation reconstructed from historical run state.

Replay and autopilot simulation show the selected historical update and safety scope before opening the generation workspace. Neither changes project files, Git state, backups, source archives, or run history. Terlio 1.2.1 syntax highlighting is applied consistently to fenced code blocks and standalone JSON in live output, saved raw model responses, Activity, and historical replay. Zipflow infers JSON for partial structured streams so the response remains readable before the closing brace arrives.

During generation, raw model output is streamed in Activity. By default that temporary block disappears when Zipflow produces its parsed result. Enable **Raw model responses → Keep raw responses** to retain the completed raw response as a collapsed Activity block immediately before the parsed explanation or review. The setting uses a two-option radio list. Both values are stored as booleans, so switching between **Hide raw responses** and **Keep raw responses** updates the marker immediately and persists across restarts.

When prior runs provide a duration median for the same model, the live generation panel uses it as a progress estimate while continuing to show the current phase. Without history, the panel uses an indeterminate loader and states that no duration estimate is available; it never presents an unknown operation as already complete.

## Autopilot decisions

Autopilot uses a separate strict structured contract. Zipflow supplies the current gate, state hashes, bounded context, and exact allowed actions. Invalid actions, low effective confidence, unavailable models, and state drift cause a fallback or return to manual control.

The model never executes shell commands directly. See [Decision modes and autopilot](autopilot.md).

## Languages

Prompt, summary, and commit-message languages are configured separately. New installations default to English prompts. Migrated installations preserve previous summary and commit-message languages where possible. Ukrainian is not offered as a generated-output language.
