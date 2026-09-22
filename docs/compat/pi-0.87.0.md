# Pi 0.87.0 compatibility

Tested on 2026-09-22 with Node.js 24.21.0 and
`@earendil-works/pi-coding-agent` 0.87.0. Pi 0.87.0 was installed only in an
isolated scratch prefix. The repository's pinned 0.85.1 installation remained
unchanged.

## Result

The extension code is compatible with Pi 0.87.0. The full offline gate passed
against that release:

- Prettier, ESLint, and TypeScript completed without errors.
- 60 tests ran. 59 passed, none failed, and the live TypeSafe test skipped
  because `TYPESAFE_API_KEY` was absent.
- The unit suite loaded `src/extension.ts` through Pi 0.87.0's real extension
  loader and found one `tool_call` handler and one `tool_result` handler.
- No paid TypeSafe calls ran.

The CI gate now runs the full repository suite independently against pinned Pi
0.85.1 and 0.87.0 installations. Each matrix leg copies the checkout into its
own runner-temporary prefix, installs only that leg's Pi version there, verifies
the installed version, and fails if `npm run check` fails. It never installs or
updates a host-global Pi.

## Real-session lifecycle difference

The matrix includes a real `AgentSession` test, not only an extension-loader
test. It loads pi-typesafe and an asynchronous lifecycle observer, runs an
offline faux-model turn through a custom tool, and therefore exercises
pi-typesafe's `session_start`, `tool_call`, and `tool_result` handlers. Startup
selection must write its receipt and apply the selected model before the turn.
At the first `agent_settled` boundary, the observer requests one continuation,
waits briefly, and returns; the continuation must complete and the session must
be idle after three model calls and one tool execution.

The asserted version difference is exact:

- Pi 0.85.1 starts a `triggerTurn` continuation requested by an
  `agent_settled` handler immediately, so `ctx.isIdle()` is false directly after
  the request.
- Pi 0.87.0 leaves `ctx.isIdle()` true at that point and starts the continuation
  only after all `agent_settled` handlers return.

This is the same deferral observed in
`/home/firstmate/firstmate/data/hl-solpi-deployment-check/report.md`. That report
found SoL-Pi waiting inside `agent_settled` for work that 0.87.0 cannot start
until the handler returns. Pi-typesafe is not exposed to that cycle: it
registers no `agent_settled` handler, its awaited startup work runs in
`session_start`, and its awaited tool work runs within the tool lifecycle. The
test's asynchronous settled co-handler deliberately returns without awaiting
the child continuation, proving pi-typesafe completes and the session drains on
both supported versions. No runtime hook fix was needed.

The same 60-test `npm run check` gate passed in the repository's pinned Pi
0.85.1 environment: 59 passed, none failed, and the live test skipped.

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
