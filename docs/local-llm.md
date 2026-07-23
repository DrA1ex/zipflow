# Local LLM integration

Zipflow supports local models through:

```text
Ollama:    http://127.0.0.1:11434
LM Studio: http://127.0.0.1:1234
```

The provider, optional bearer token, selected model, and output languages are configured in global settings. Bearer tokens are stored in macOS Keychain or the Linux system keyring rather than `~/.zipflow` JSON files. On Linux, persistence requires `secret-tool` and an active Secret Service provider; when secure storage is unavailable, Zipflow refuses to save a new token instead of falling back to plaintext.

## What the model can do

A local model can:

- assess archive suitability;
- summarize source changes;
- propose a commit message;
- explain failed checks or deployment output;
- resolve bounded autopilot decisions after passing a separate compatibility test.

Ordinary summaries and verdicts are advisory. Local LLM failures do not block manual archive application.

## Archive review levels

The **Archive review** setting controls suitability assessment:

- **Summary only** — summary and commit message without a verdict;
- **Structure guard** — compare current and archive trees;
- **Sample guard** — add the complete changed-path manifest and representative excerpts from up to five priority files;
- **Deep patch review** — assess the selected change representation and return verdict, reasons, summary, and commit message.

A strongly unsuitable structure verdict stops further patch summarization for that request and explains why the archive appears unrelated. It does not replace deterministic validation.

## Change delivery modes

The independent **Change delivery** setting controls source evidence:

- **Adaptive**;
- **Full patch**;
- **Representative sample**;
- **Capped batches**;
- **Changed paths only**;
- **File-by-file chunks**.

Bounded modes report both manifest coverage and file-content coverage so a partial review is not presented as exhaustive.

The complete `changes.patch` remains stored in the run even when the model receives a reduced representation.

## Failed checks

Failure analysis can:

- remain disabled;
- use a fresh model context;
- continue from the compact context of the preceding change review.

Same-context analysis sends the prior result with the failed command and output rather than resending the complete patch.

## Commit messages

The workflow commit-message source determines the preferred proposal, not the only available one. At commit time Zipflow can show distinct messages from:

- the local LLM;
- archive metadata;
- a workflow template;
- the deterministic generated fallback.

**Edit message…** opens the preferred proposal in a multiline editor. A useful summary can still be retained when the model's commit message cannot be recovered.

## Prompt budgets and retries

Before generation, Zipflow discovers model context information where possible and calculates a conservative prompt budget that reserves space for instructions and output.

Large changes are shortened structurally rather than cut at an arbitrary byte offset. The changed-file manifest is retained and diff hunks are distributed across files.

Context-overflow and out-of-memory responses trigger a smaller-patch retry and are reported explicitly.

## LM Studio behavior

LM Studio uses its native model catalog and streaming chat API. Zipflow can read parameter counts, loaded-instance configuration, context size, and load or prompt-processing progress.

Selecting a model opens its load configuration. **Save and select** unloads stale LLM instances when necessary and reloads the chosen model, leaving one active LLM instance. Reviews and compatibility tests address the selected loaded instance directly so a second copy of the same model is not created accidentally.

Configurable values can include context length, evaluation batch size, Flash Attention, KV-cache placement, and expert count when supported by the model and server.

## Ollama behavior

Ollama uses native metadata endpoints to discover model and context information, then uses its OpenAI-compatible streaming completion endpoint for generation.

## Output parsing and diagnostics

Primary review generation uses a readable section protocol containing summary, commit message, and optional assessment.

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

Replay and autopilot simulation show the selected historical update and safety scope before opening the generation workspace. Neither changes project files, Git state, backups, source archives, or run history. Terlio 1.1.3 syntax highlighting is applied consistently to fenced code blocks and standalone JSON in live output, saved raw model responses, Activity, and historical replay. Zipflow infers JSON for partial structured streams so the response remains readable before the closing brace arrives.

During generation, raw model output is streamed in Activity. By default that temporary block disappears when Zipflow produces its parsed result. Enable **Raw model responses → Keep raw responses** to retain the completed raw response as a collapsed Activity block immediately before the parsed explanation or review. The setting uses a two-option radio list. Both values are stored as booleans, so switching between **Hide raw responses** and **Keep raw responses** updates the marker immediately and persists across restarts.

## Autopilot decisions

Autopilot uses a separate strict structured contract. Zipflow supplies the current gate, state hashes, bounded context, and exact allowed actions. Invalid actions, low effective confidence, unavailable models, and state drift cause a fallback or return to manual control.

The model never executes shell commands directly. See [Decision modes and autopilot](autopilot.md).

## Languages

Prompt, summary, and commit-message languages are configured separately. New installations default to English prompts. Migrated installations preserve previous summary and commit-message languages where possible. Ukrainian is not offered as a generated-output language.
