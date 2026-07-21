# Development

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

This starts Zipflow in the current working directory. To test it against another project, either change to that project after linking the command globally or provide an isolated checkout for development.

## Link the development command

From the Zipflow source directory:

```bash
npm link
```

The globally available `zipflow` command now points to the current checkout:

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

## Package inspection

Before publishing, inspect exactly what npm will include:

```bash
npm pack --dry-run
```

The published package is intentionally limited to the executable, source files, documentation, README, architecture document, and license.

Create a local package tarball for installation testing:

```bash
npm pack
npm install --global ./zipflow-<version>.tgz
```

## Publishing

Update the version using the normal npm version command, verify the package, inspect the tarball contents, and publish publicly:

```bash
npm version patch
npm run verify
npm pack --dry-run
npm publish --access public
```

Choose `minor` or `major` instead of `patch` when the release requires it.

## Project structure

See [Architecture](../ARCHITECTURE.md) for layer ownership, lifecycle boundaries, extension points, safety rules, and testing strategy.

All project Markdown documentation is written in English.

Public dependency registry URLs in `package-lock.json` must remain public and must not be rewritten to private or internal mirrors.
