# Pi 0.87.0 compatibility

Tested on 2026-09-22 with Node.js 24.21.0 and
`@earendil-works/pi-coding-agent` 0.87.0. Pi 0.87.0 was installed only in an
isolated scratch prefix. The repository's pinned 0.85.1 installation remained
unchanged.

## Result

The extension code is compatible with Pi 0.87.0. The full offline gate passed
against that release:

- Prettier, ESLint, and TypeScript completed without errors.
- 48 tests ran. 47 passed, none failed, and the live TypeSafe test skipped
  because `TYPESAFE_API_KEY` was absent.
- The unit suite loaded `src/extension.ts` through Pi 0.87.0's real extension
  loader and found one `tool_call` handler and one `tool_result` handler.
- No paid TypeSafe calls ran.

The same `npm run check` gate passed in the repository's pinned Pi 0.85.1
environment before the compatibility run. After the metadata fix and its test,
the gate ran 49 tests: 48 passed, none failed, and the live test skipped.

## Packaging break

The implementation needed no changes, but the package metadata rejected Pi
0.87.0. Installing a packed copy beside Pi 0.87.0 failed with npm exit code 1:

```text
npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error Found: @earendil-works/pi-coding-agent@0.87.0
npm error Could not resolve dependency:
npm error peer @earendil-works/pi-coding-agent@">=0.85.1 <0.86.0" from pi-typesafe@0.1.0
```

The smallest fix is to widen the peer range to `>=0.85.1 <0.88.0`. The pinned
development dependency stays at 0.85.1, so the normal gate continues to test the
oldest supported release. A package metadata test records the two verified
boundaries. After the change, a clean consumer install with Pi 0.87.0 succeeds
without `--force` or `--legacy-peer-deps`.

## Commands

The 0.87.0 scratch copy used the repository source, tests, scripts, and configs
with only its development Pi version changed:

```sh
npm install --legacy-peer-deps --prefix .compat-pi-0.87.0
node -p "require('./.compat-pi-0.87.0/node_modules/@earendil-works/pi-coding-agent/package.json').version"
npm run check --prefix .compat-pi-0.87.0
```

`--legacy-peer-deps` was required only to assemble the pre-fix test prefix while
the package still declared the old peer range. The post-fix packed-package
consumer installation used ordinary `npm install`.
