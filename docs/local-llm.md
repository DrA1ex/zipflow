# Local LLM integration

Zipflow supports Ollama and LM Studio through provider-specific adapters.

Default local endpoints are:

```text
Ollama:    http://127.0.0.1:11434
LM Studio: http://127.0.0.1:1234
```

An optional bearer token can be configured for model discovery and generation.

## What the model can do

Depending on workflow settings, a local model can:

- assess whether the archive structure appears suitable for the current project;
- summarize source changes;
- propose a concise commit message;
- explain failed checks or deployment output.

The model verdict is advisory. It can require an explicit safety-review screen, but it never replaces path validation, ignore rules, Git conflict detection, backups, or tests.

A local model failure never blocks archive application.

## Archive review levels

The **Archive review** setting controls whether the model judges archive suitability:

- **Summary only** — generate a summary and commit message without a verdict;
- **Structure guard** — compare current-project and archive directory trees;
- **Sample guard** — combine trees, the changed-path manifest, and representative patch excerpts;
- **Deep patch review** — produce an assessment, reasons, summary, and commit message from the selected change representation.

A strongly unsuitable structure verdict stops additional patch summarization for that request and explains why the archive appears unrelated.

## Change delivery modes

The **Change delivery** setting controls what source evidence reaches the model:

- **Adaptive** — use a bounded full patch when it fits, a representative sample for medium changes, and capped batches for large changes;
- **Full patch** — send one context-budgeted patch request;
- **Representative sample** — send the complete manifest and representative excerpts;
- **Capped batches** — analyze a limited number of priority batches before synthesis;
- **Changed paths only** — send explicit create, update, and delete records without file contents;
- **File-by-file chunks** — exhaustively analyze bounded file batches and synthesize one result.

Bounded modes report both manifest coverage and file-content coverage in Activity, replay, and diagnostics.

The complete `changes.patch` is stored with the run even when the model receives a reduced representation.

## Failed checks

The **Failed checks** setting can:

- leave failures without a model explanation;
- explain the failed command in a fresh model context;
- continue from the compact context of the preceding change review.

Same-context analysis sends the prior review result together with the failed command and output instead of resending the entire patch.

## Prompt budgets and retries

Before generation, Zipflow discovers the model context size and loaded instances when possible, then calculates a conservative prompt budget.

Instructions and output receive reserved space. When a complete patch is too large, Zipflow retains the full changed-file manifest and distributes retained hunks across files rather than cutting the patch at an arbitrary byte boundary.

Context-overflow and out-of-memory responses trigger a smaller-input retry and are reported explicitly.

## LM Studio behavior

Zipflow uses LM Studio's native model catalog and streaming API to read model parameter counts, loaded-instance configuration, context size, and available load or prompt-processing progress.

The selected loaded instance ID is used directly. Changing load-time configuration unloads and reloads the selected model when needed. Selecting another model unloads stale LLM instances so Zipflow does not accumulate duplicate active models.

Configurable LM Studio options can include context length, evaluation batch size, Flash Attention, KV-cache placement, and expert count.

## Ollama behavior

Zipflow uses native Ollama metadata endpoints to discover model information and context size, then uses the OpenAI-compatible streaming chat endpoint for generation.

## Output parsing and diagnostics

Primary generation uses a readable section protocol containing a summary, commit message, and optional assessment.

When a model ignores the requested format or spends its output budget on reasoning, Zipflow can perform a hidden compact repair request. If only a useful summary can be recovered, the summary is kept and the configured commit-message fallback is used.

Provider errors and sanitized raw diagnostics are saved under the run directory as:

```text
llm-diagnostics.json
```

Press `Esc` during generation to cancel only the local LLM request. Archive analysis continues with normal fallbacks.

## Replay and model testing

**Test selected model** provides:

- a quick connection and compatibility check;
- a read-only replay of a historical archive update with the current model settings.

Replay shows the selected archive update and safety scope before opening the generation workspace. It never changes project files.

## Languages

Prompt, summary, and commit-message languages are configured separately. New installations default to English prompts. Migrated installations preserve the previous output language where possible.
