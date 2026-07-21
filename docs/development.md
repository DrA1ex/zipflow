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

`npm run verify` performs source checks and runs the automated test suite.

The source checker enforces the JavaScript file-size policy: 1,000 lines is the hard limit and 500 lines is the preferred limit.

Run the parts separately when needed:

```bash
npm run check
npm test
```

Regression fixes should include targeted automated tests so unit or integration checks catch the same class of problem before E2E or manual use.

## Package inspection

Before publishing, inspect exactly what npm will include:

```bash
npm pack --dry-run
```

The published package includes the executable, source files, `docs/`, README, architecture document, and license.

Create a local package tarball for installation testing:

```bash
npm pack
npm install --global ./zipflow-<version>.tgz
```

Run `zipflow` from a separate test project to verify that documentation packaging and the global executable work outside the source checkout.

## Versioning

Zipflow follows semantic versioning from `1.0.0` onward:

- compatible fixes and small improvements increment `1.0.x`;
- substantial backward-compatible features increment `1.x.x`;
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

Verify the version, test suite, package contents, and locally installed tarball before publishing:

```bash
npm run verify
npm pack --dry-run
npm pack
npm install --global ./zipflow-<version>.tgz
npm publish --access public
```

The package declares public access through `publishConfig`, but keeping `--access public` in the release command makes intent explicit.

## Project structure

See [Architecture](../ARCHITECTURE.md) for layer ownership, lifecycle boundaries, extension points, safety rules, autonomous-decision boundaries, and testing strategy.

All project Markdown documentation is written in English.

Public dependency registry URLs in `package-lock.json` must remain public and must not be rewritten to private or internal mirrors.
