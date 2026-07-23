# Development and publishing

## Requirements

- Node.js 20 or newer
- npm
- macOS or Linux

## Install dependencies

```bash
npm install
```

## Run from the source tree

```bash
npm start
```

This starts Zipflow in the current working directory.

## Link the development command

From the Zipflow source directory:

```bash
npm link
```

The global `zipflow` command now points to the current checkout:

```bash
cd /path/to/test-project
zipflow
```

Remove the link with:

```bash
npm unlink --global zipflow
```

## Verification

```bash
npm run verify
```

`npm run verify` performs source checks and runs the automated test suite. `npm publish` also runs this verification through `prepublishOnly`.

For the complete release gate, including inspection of the files npm would publish, run:

```bash
npm run release:check
```

The source checker enforces the JavaScript file-size policy: 1,000 lines is the hard limit and 500 lines is the preferred limit. It also verifies `en.json` as the complete canonical interface catalog, rejects built-in translations with unknown English keys, and audits static UI strings for missing English entries.

Run the parts separately when needed:

```bash
npm run check
npm test
```

Regression fixes should include targeted automated tests so unit or integration checks catch the same class of problem before E2E or manual use. Node test workers automatically use a process-specific temporary Zipflow home unless `ZIPFLOW_HOME` is explicitly set, so the test suite cannot overwrite the developer's real settings or credentials. Input regressions must cover structured paste and overlapping submit events. Archive-discovery tests create real ZIP fixtures and verify age filtering, path matching, wrapper normalization, and the deliberate double-`Enter` interaction. The Terlio compatibility test must find and exercise the 1.1.3 syntax-highlighting export so a dependency API change cannot silently disable highlighting.

## Package inspection

Before publishing, inspect exactly what npm will include:

```bash
npm pack --dry-run
```

The published package includes only the executable, runtime source files, `docs/`, README, and license. Tests, local state, development archives, and `package-lock.json` are not part of the npm tarball.

Create a local package tarball for installation testing:

```bash
npm pack
npm install --global ./zipflow-<version>.tgz
```

Run `zipflow` from a separate test project to verify that documentation packaging and the global executable work outside the source checkout.

## Versioning

Zipflow follows semantic versioning from `1.0.0` onward:

- compatible fixes and small improvements increment the patch version;
- substantial backward-compatible features increment the minor version;
- breaking changes increment the major version.

The version in these locations must match:

- `package.json`;
- `package-lock.json`;
- `src/version.js` and the application header.

Use the appropriate npm command:

```bash
npm version patch
npm version minor
npm version major
```

## Publishing

Confirm the active npm account and make sure the package name is still available before the first publication:

```bash
npm whoami
npm view zipflow version
```

For a new unclaimed package, `npm view` normally returns a not-found error. For later releases, it should show the currently published version, which must differ from the local version.

Verify the version, test suite, package contents, and locally installed tarball before publishing:

```bash
npm run release:check
npm pack
npm install --global ./zipflow-<version>.tgz
zipflow
npm publish
```

`zipflow` is an unscoped public package. `publishConfig` fixes public access and the official npm registry, while `prepublishOnly` reruns the full verification immediately before publication. Inspect the tarball and test the globally installed command from a separate directory before publishing.

## Project structure

See [Architecture](architecture.md) for layer ownership, lifecycle boundaries, extension points, safety rules, autonomous-decision boundaries, and testing strategy.

All project Markdown documentation is written in English.

Public dependency registry URLs in `package-lock.json` must remain public and must not be rewritten to private or internal mirrors.
