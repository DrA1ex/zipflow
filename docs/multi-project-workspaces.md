# Multi-project workspaces

Zipflow treats the selected directory as one workspace and one Git repository. The workspace may contain a project at its root and additional projects in subdirectories.

Archive application, diff review, backups, rollback, managed-file history, and result commits always use the workspace root. Project entries affect technology detection and the working directory of checks and deployment commands; they do not create independent Zipflow histories.

## Automatic scan

During project setup Zipflow inspects:

1. the workspace root;
2. immediate child directories only.

It does not recursively search deeper directories. Known dependency, cache, generated-output, environment, editor, and library directories are skipped, including `node_modules`, `.venv`, `venv`, `vendor`, `build`, `dist`, `target`, `.git`, `.zipflow`, `lib`, and `libs`.

A skipped directory can still be added manually. Symbolic links are not followed by automatic detection or command-directory validation.

## Project-structure screen

After scanning, the setup wizard shows every detected project with its relative path and technology label. The user can:

- use all selected projects;
- use only the workspace root;
- disable an individual detected project;
- add another project manually;
- rescan the workspace;
- choose another workspace root.

A manually added project may be deeper than one directory level, for example `packages/client/`. Directory completion remains available while entering the path. If marker files do not identify the technology, the directory can remain an ordinary project or receive a manual type label. Zipflow does not invent framework commands merely because a type was assigned manually.

## Command syntax

Checks and deployment commands use one compact input syntax:

```text
npm test
```

runs from the workspace root.

```text
web/ :: npm test
```

runs `npm test` with `web/` as the working directory.

The first `::` separates the relative working directory from the shell command. This makes commands such as `./scripts/test.sh` unambiguous: without `::`, they still run from the workspace root.

While editing a command, path completion applies only before `::`. Selecting a directory inserts the complete prefix:

```text
web/ :: 
```

The interface shows the parsed directory and command before saving. Stored workflow data keeps them separately:

```json
{
  "commandText": "npm test",
  "cwd": "web"
}
```

Existing workflows without `cwd` continue to run from the workspace root.

## Safety

A command directory must:

- exist;
- be a directory;
- remain inside the workspace;
- contain no symbolic-link segment;
- use a project-relative path.

If a saved directory disappears, the command fails clearly. Zipflow never falls back to the workspace root silently.

## Suggested checks and deployment

Each selected project contributes its detected checks and deployment candidates. Zipflow qualifies every command with its project path, so identical commands in different projects remain separate:

```text
Root · pytest
web/ · npm test
admin/ · npm test
```

Runtime progress, failures, stored reports, manual runs, workflow review, and deployment prompts display the effective directory together with the command.

## Workflow storage

Workflow version 8 stores the selected project entries:

```json
{
  "projects": [
    {
      "path": ".",
      "typeIds": ["python"],
      "labels": ["Python"],
      "source": "detected",
      "selected": true
    },
    {
      "path": "web",
      "typeIds": ["node"],
      "labels": ["Node.js"],
      "source": "detected",
      "selected": true
    }
  ]
}
```

Legacy workflows migrate to one selected root project automatically.
