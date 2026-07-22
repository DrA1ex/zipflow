# Settings, history, and storage

## Global settings

Press `Ctrl+B` to open global settings.

Settings include:

- Terlio semantic theme;
- compact or live running-check output;
- local LLM provider, authentication, model, load configuration, and languages;
- archive review and change-delivery behavior;
- source ZIP disposition;
- archive retention and size limits;
- backup retention and size limits;
- managed-file recording and reset actions.

Settings are loaded before interactive input begins and are saved immediately in:

```text
~/.zipflow/settings.json
```

Before replacing a valid settings file, Zipflow writes:

```text
~/.zipflow/settings.backup.json
```

The local LLM bearer token is not written to either settings file. Zipflow stores it through the operating-system credential service:

- macOS Keychain on macOS;
- a Secret Service-compatible system keyring through `secret-tool` on Linux.

Zipflow does not create an encrypted sidecar whose decryption key is stored beside it, and it does not fall back to plaintext when secure storage is unavailable. Saving a new token fails with an actionable error instead. Existing `settings.json`, `settings.backup.json`, or legacy `credentials.json` tokens are moved into the system credential store and scrubbed from disk only after the protected write succeeds.

The operating-system login or keyring unlock protects the credential encryption key, so Zipflow does not introduce a second application password. This protects credentials at rest and prevents obtaining them by browsing `~/.zipflow`. It does not claim to isolate the token from arbitrary malicious software already running as the same logged-in user while that user's credential store is unlocked.

On Linux, install `secret-tool` and run a Secret Service provider such as GNOME Keyring or another compatible implementation before saving a token. On headless systems without a credential service, leave persistent authentication unset rather than adding a plaintext fallback.

If the primary settings file becomes unreadable, the backup is restored automatically. Model and loaded-instance selection, source archive policy, storage directories, and retention limits remain preserved across compatible patch upgrades; the bearer token is read independently from the system credential store.

The default maximum rollback-backup storage remains 2 GB.

## Source ZIP disposition

After a successful update is kept, Zipflow can:

- **Do nothing** — leave the selected ZIP in place;
- **Move to archive storage** — move it to managed storage;
- **Delete source ZIP** — remove it after completion.

The default is **Do nothing**.

Managed archive storage defaults to:

```text
~/zipflow-archive
```

The directory is created when selected or first used. Settings expose managed file count, used space, oldest archive, retention period, and maximum size.

**Clear now** removes only archives recorded in Zipflow's archive index. Unrelated files in the same directory are not deleted.

Before moving or deleting an archive, Zipflow verifies that the source is still the regular file whose hash was inspected. Cancelled runs, failures before application, and rollbacks before a run is kept do not consume the source archive.

## Backups

Backups are stored separately under:

```text
~/.zipflow/backups
```

or the active `ZIPFLOW_HOME`.

Zipflow can keep all backups or prune them by age and total size. Automatic pruning never removes the backup of the active run.

Manual cleanup warns when affected history entries will lose rollback capability. Those entries then show **Rollback unavailable**.

## Run history

Every archive run records:

- archive hash and metadata;
- safety warnings and model assessment;
- manual and autonomous decisions;
- change plan and stored patch;
- checks and durations;
- commit and deployment results;
- archive disposition;
- rollback state.

Pending or executing autonomous decisions found after restart are marked interrupted and are not replayed automatically.

Manual checks and manual deployments appear as separate record types and explain why no file diff or rollback action exists.

Archive-update details can open the stored multi-file diff when a patch is available.

## Duplicate-skipped runs

When an archive is inspected in autopilot mode and the rebuilt plan contains no content changes, Zipflow records a `duplicate_skipped` run. It does not run checks, create a commit, deploy, or request another autonomous decision.

This provides an auditable result without performing no-op work.

## Performance analytics

History analytics aggregates recent runs and reports:

- median and average durations;
- success rates;
- minimum and maximum durations;
- recent trends for each check;
- provider/model generation performance;
- frequency of reduced LLM inputs;
- average generation attempt count.

Previous medians are used as estimates while checks and LLM analysis are running.

## Storage layout

By default, Zipflow uses:

```text
~/.zipflow/
  settings.json
  settings.backup.json
  archive-index.json
  workflows/
  runs/
  backups/
  projects/
    <project-id>/managed-files.json
  tmp/
  locks/
```

Zipflow creates its state directories with owner-only permissions (`0700`) and atomically written state files with owner-only permissions (`0600`). Credentials remain outside this tree in the operating-system credential store.

Use `ZIPFLOW_HOME` to isolate all Zipflow state:

```bash
ZIPFLOW_HOME=/tmp/zipflow-test zipflow
```

Temporary and lock directories are managed by Zipflow. Active operations own their child processes and cancellation state so an interrupt can cleanly return to the interactive application.


## Interface language packs

`interfaceLanguage` is stored in ordinary settings because it is not sensitive. It defaults to `en`. The optional `system` value resolves the operating-system locale to an installed pack and falls back to English. Built-in packs are shipped with Zipflow; user packs are loaded from `~/.zipflow/languages/*.json` during startup or with **Refresh languages** in the picker.

Each pack is validated against [`docs/i18n/language.schema.json`](i18n/language.schema.json). Invalid files are ignored and never partially registered. Message lookup uses the active pack first and English second, so a small custom pack can override selected strings without copying the complete catalog.

Language files do not contain executable code. Zipflow reads JSON only, validates metadata, strings, and placeholder patterns, and does not evaluate expressions from a pack.

