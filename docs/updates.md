# Automatic updates

Zipflow checks for a newer published version shortly after the terminal interface starts. The check runs in the background and does not delay project detection or workflow loading.

## Supported installation

Automatic updates are enabled only when the running package is the real global npm installation returned by `npm root -g`.

Zipflow does not modify:

- a checkout started with `node bin/zipflow.js`;
- a local package installation;
- a package connected through `npm link` or another symbolic link.

This prevents development copies from being replaced unexpectedly.

## Version check

Zipflow asks the official npm registry for the version assigned to the `latest` dist-tag:

```bash
npm view zipflow@latest version --json --registry=https://registry.npmjs.org/
```

Only a valid semantic version newer than the running version opens the update dialog. Network errors, registry outages, and timeouts are ignored silently so offline use is unaffected.

The startup check can be disabled for automation or restricted environments:

```bash
ZIPFLOW_DISABLE_UPDATE_CHECK=1 zipflow
```

## Update dialog

The dialog shows the installed and available versions and offers:

- **Update now** — install the exact advertised version;
- **Later** — keep the current process and check again on a future startup.

Choosing **Update now** runs the global npm installation automatically:

```bash
npm install -g zipflow@<version> --registry=https://registry.npmjs.org/
```

The version is validated before it is passed to npm, and the command is executed without a shell. `Ctrl+C`, `Esc`, or **Cancel update** stops the active npm process.

## Restart

After npm finishes, the old process does not return to the project workflow. Continuing could mix already loaded modules with newly replaced files.

Zipflow therefore offers only:

- **Restart Zipflow** — launch the same entry point with the same arguments and working directory;
- **Exit** — close the current process and restart manually later.

## Installation failures

A failed installation stays inside the update dialog and does not open the application error screen. The dialog offers a retry or lets the user continue with the current version.

Zipflow never runs `sudo`. If npm reports `EACCES` or another permission error, configure a user-owned global npm prefix or use a Node version manager, then retry the update.
