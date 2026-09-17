# pi-typesafe

Baseline for future Pi coding-agent extensions using TypeSafe AI's System One
API and Jev model. System One evaluates state against typed Choice, Score, and
Noul questions and returns structured answers. This repository provides the SDK
boundary and development tooling. Extension features, hooks, question libraries,
and decision policies remain undecided.

## Verified Pi extension mechanism

Verified against Pi's current [extension documentation](https://pi.dev/docs/latest/extensions)
and [package documentation](https://pi.dev/docs/latest/packages) on 2026-09-17:

- Extensions are TypeScript modules exporting a default factory receiving
  `ExtensionAPI` from `@earendil-works/pi-coding-agent`. Pi loads TypeScript using
  jiti without a compilation step.
- Pi discovers `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts` locally,
  with equivalent paths under `~/.pi/agent/extensions/` globally. An explicit
  file can be tried with `pi -e ./path.ts`.
- A package can put its manifest at the root, source under `src/`, and declare
  actual entry files in `package.json` under `pi.extensions`. Runtime npm
  dependencies belong in `dependencies`; Pi resolves them from `node_modules`.

That establishes TypeScript, an npm `package.json`, and a `src/` layout as a
supported foundation, and selects the JavaScript TypeSafe SDK. There is no Pi
entry file or `pi.extensions` declaration yet: the shared SDK module is not an
extension factory. Add those when the first extension is selected. Pi itself is
not needed for the current checks and has not been installed or smoke-tested.

## Development

Use Node.js 24 LTS and npm. Node runs the test TypeScript directly; `tsc` checks
its types separately. All direct dependencies are pinned and the lockfile is
committed.

```sh
npm ci
npm run check
```

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `npm run format`           | Format with Prettier                              |
| `npm run format:check`     | Check formatting                                  |
| `npm run lint`             | ESLint with TypeScript rules                      |
| `npm run typecheck`        | Strict TypeScript, no emitted files               |
| `npm test`                 | Unit tests plus credential-gated integration test |
| `npm run test:unit`        | Mocked transport only; no network                 |
| `npm run test:integration` | Live smoke test; loads optional local `.env`      |
| `npm run check`            | Formatting, lint, types, and all tests            |

After dependency installation, all checks pass offline without an API key. The
integration test reports a skip when the key is unset, empty, or whitespace.
CI runs `npm ci` and `npm run check` on Node 24 without a secret configured.

## Credentials and live testing

The SDK reads `TYPESAFE_API_KEY` from the environment when `createTypeSafe()` is
called. Copy `.env.example` to `.env` and fill in your own key to run
`npm run test:integration`. Alternatively, export the variable in your shell.
The general `npm test` command uses the existing environment; it does not load
`.env`. A configured key enables the live test, which sends a small fixed fixture
and may incur API usage. No live request was verified for this baseline because
no key was available.

Local `.env` files are ignored. Never commit credentials. Imports and static
checks do not construct a client. Explicitly constructing a client without a key
raises the SDK's configuration error; this does not prevent offline development.
The SDK also accepts `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`) and
`TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`).

## SDK boundary and verified contract

Verified against **`@typesafe-ai/sdk` 0.6.0**, including its published package
TypeScript declarations and implementation, the [JavaScript SDK guide](https://docs.typesafe.ai/sdk/javascript),
[client reference](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient),
[configuration reference](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig),
and [result reference](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult).

`src/typesafe.ts` exports `createTypeSafe(config?)` and the SDK's `choice`, `score`,
and `noul` builders. Its `systemOne(request, options?)` delegates directly to
`TypeSafeClient.systemOne`, retaining `SystemOneRequest<Q>` and
`APIPromise<SystemOneResult<Q>>`. State, named questions, optional model, per-call
options, response metadata, and SDK errors pass through. Multiple primitive
kinds can share one request. No application policy or output conversion is added.

Choice answers contain the selected label, probabilities, and confidence. Score
answers contain an expected score, rubric legend, probabilities, and confidence.
Noul answers contain `noul`, the probability of yes, without a separate confidence
field. The SDK's generic types retain question names and criteria keys.

Unit tests inject the SDK's documented `fetch` transport to verify serialization,
authentication, all three response shapes, model selection, metadata, errors,
and type inference. `test/integration/` holds the separate live smoke test and
checks response shape/range rather than assuming a deterministic model answer.
