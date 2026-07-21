# Decision modes and autopilot

## Decision mode versus archive policy

Decision mode is configured per project workflow and is independent of the archive policy profile.

- Archive policy defines deterministic file-handling defaults such as overlay versus snapshot behavior and deletion scope.
- Decision mode defines who resolves supported runtime choices: the user or a bounded local-LLM decision engine.

Hard path validation, protected paths, backups, transaction restoration, Git staging boundaries, and no-push rules are identical in every mode.

## Manual

**Manual** preserves the traditional Zipflow workflow. The application follows configured deterministic defaults and asks the user whenever an unresolved decision remains.

No LLM decision compatibility test is required.

## Guarded autopilot

**Guarded autopilot** allows the configured local model to resolve routine, reversible decisions.

It pauses or returns control to the user when meaningful risk is present, including:

- user-staged Git changes;
- ambiguous conflict replacement;
- a commit after failed required checks;
- Git-history rewriting;
- deployment after failed checks;
- incomplete evidence or low effective confidence;
- project state drift while a decision is pending.

Guarded mode can participate in supported gates for plan application, failed-check recovery, ordinary result commits, and configured deployment when its safety preconditions are met.

## Full autopilot · Dangerous

**Full autopilot · Dangerous** requires a separate confirmation during setup.

It can additionally choose among supported actions that may have higher consequences, including:

- archive or local outcomes for eligible conflicts;
- keeping and committing an update after failed checks;
- amending or bounded squashing of eligible unpublished Zipflow commits;
- running the already configured deployment after failed checks;
- bounded retry decisions for checks and deployment.

It remains constrained. Full autopilot cannot invent commands, modify the workflow, select arbitrary commits, push, force-push, bypass protected paths, disable backups, or weaken transaction restoration.

## Compatibility requirement

Autopilot is available only after the selected Ollama or LM Studio model passes the autonomous-decision compatibility test.

The test is separate from ordinary summarization compatibility because autonomous decisions require a strict structured response, valid action selection, and reliable confidence reporting.

## Bounded decision contract

At each decision gate, Zipflow creates an explicit allowlist of actions. The model receives:

- the gate identifier;
- a bounded context describing the current run;
- deterministic state hashes;
- the exact allowed action values;
- relevant evidence, risks, coverage, and constraints.

The model must return a structured decision containing the selected action, confidence, summary, evidence, risks, and conditions. Zipflow rejects responses that do not match the current gate or choose an action outside the allowlist.

## Confidence and fallback

Zipflow calculates effective confidence from the model's reported confidence and the quality of the available evidence. Incomplete patch coverage, elevated risk, ambiguity, or incomplete state reduce the effective value.

Guarded mode requires a higher confidence threshold than Full mode. If the decision is invalid, unavailable, below threshold, or stale, Zipflow uses the gate's deterministic fallback or returns control to the user.

The model is never treated as evidence that deterministic validation succeeded.

## Supported gates

Depending on workflow capabilities, Guarded and Full modes can participate in:

- plan application and archive-risk review;
- eligible local-work and conflict handling;
- retry, rollback, or keep decisions after checks;
- result commit, eligible amend, or bounded squash decisions;
- configured deployment and bounded deployment retry decisions.

The actual allowed actions are generated at runtime from project state. The presence of a gate does not guarantee that every possible action is available.

## Cancellation and resume

Pressing `Esc` or cancelling an active LLM decision pauses autopilot for the current run. Zipflow shows the equivalent manual checkpoint and can offer **Resume autopilot** later.

A cancelled decision is not silently retried. Pending or executing decisions discovered after an application restart are marked interrupted and are never replayed automatically.

## Decision records

Each autonomous decision records information needed for later review, including:

- gate and mode;
- allowed and proposed actions;
- selected action and target;
- reported and effective confidence;
- evidence, risks, and conditions;
- provider and model identity;
- state hashes;
- execution state and duration.

These records are stored with the run and appear in reports and history where relevant.

## Choosing a mode

Use **Manual** when every update needs direct review or no compatible local model is available.

Use **Guarded autopilot** for routine archives when you want automation to stop at meaningful risk.

Use **Full autopilot · Dangerous** only for projects whose backups, tests, Git state, deployment command, and rollback procedures have already been validated. The danger is that it may choose risky supported actions, not that it receives unrestricted access.
