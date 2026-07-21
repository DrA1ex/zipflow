# Settings, history, and storage

## Global settings

Press `Ctrl+B` to open global settings.

Settings include:

- Terlio semantic theme;
- compact or live running-check output;
- local LLM provider, endpoint authentication, model, and languages;
- archive review and change-delivery behavior;
- source ZIP disposition;
- archive retention and size limits;
- backup retention and size limits;
- managed-file recording and reset actions.

Settings are saved immediately in:

```text
~/.zipflow/settings.json
```

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

Cancelled runs, failures before application, and rollbacks before a run is kept do not consume the source archive.

## Backups

Backups are stored separately under:

```text
~/.zipflow/backups
```

or the active `ZIPFLOW_HOME`.

Zipflow can keep all backups or prune them by age and total size. Automatic pruning never removes the backup of the active run.

Manual cleanup warns when affected history entries will lose rollback capability.

## Run history

Every archive run records:

- archive hash and metadata;
- safety warnings and model assessment;
- user decisions and change plan;
- checks and durations;
- commit and deployment results;
- archive disposition;
- rollback state.

Manual checks and manual deployments appear as separate record types and explain why no file diff or rollback action exists.

Archive-update details can open the stored multi-file diff when a patch is available.

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
  archive-index.json
  workflows/
  runs/
  backups/
  projects/
    <project-id>/managed-files.json
  tmp/
  locks/
```

Use `ZIPFLOW_HOME` to isolate all Zipflow state:

```bash
ZIPFLOW_HOME=/tmp/zipflow-test zipflow
```
