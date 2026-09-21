# Package review: `@shahriarbijoy/eslint-plugin-jev@0.3.0`

**Status: not blocked.** Every requirement in the lane brief is satisfiable with this
implementation. Two behaviours need explicit configuration to be safe (`provider`, `strict`) and one
gap cannot be closed by configuration at all (per-unit skips, §7). None of them contradicts a
requirement outright, so this review proceeds to adoption rather than stopping.

Reviewed by reading the published tarball, not the repository:

```
https://registry.npmjs.org/@shahriarbijoy/eslint-plugin-jev/-/eslint-plugin-jev-0.3.0.tgz
sha512-X3USBmLcDrldcza1mRu3Spkj2ZN52tHn1I8hiZKbhxlLtJWdUtKVvKdhHXmXtK3plBm/CLzmNMhFkN2aixjJ2g==
```

The recomputed SHA-512 matches the integrity the registry advertises. Shipped files are
`dist/index.js`, `dist/worker.js`, their maps, `dist/index.d.ts`, `README.md`, `LICENSE` (MIT).
There are **no install lifecycle scripts**; the package was installed with `--ignore-scripts`
regardless. Runtime dependencies are `@typesafe-ai/sdk ^0.6.0` (this repo already pins 0.6.0
exactly) and `synckit ^0.11.13`. Peer range is `eslint ^9 || ^10`; this repo is on 10.10.0.

Line references below are to the unpacked `dist/` bundles.

## 1. What is actually sent to the API

The README claims "name, signature, leading comment and body, one function at a time, no
surrounding file". **Verified by reading the code, and accurate** — with one addition the README
does not name.

`unitState` (`dist/index.js`, `src/questions/build.ts` section) is the only thing that becomes
request state:

```js
function unitState(unit) {
  const fn = { name: unit.name, signature: unit.signature };
  if (unit.comment) fn.comment = unit.comment;
  fn.body = unit.body;
  if (unit.throws.length) { fn.throws = { ... } }
  return { function: fn };
}
```

So the payload is exactly `{ function: { name, signature, comment?, body, throws? } }`, where:

- `body` is the function body only, dedented and line-tagged (`L001| …`) so the model can name a
  line. Enclosing class, imports, module scope and sibling functions are not included.
- `signature` is the text before the body, whitespace-collapsed.
- `comment` is the attached leading comment or JSDoc, and only when it is adjacent (a blank line
  between comment and function detaches it).
- `throws` is **the addition**: a map of statically-extractable `throw new X("…")` / `reject(new
X("…"))` message strings with body-relative line numbers. It is derived entirely from the body
  that is already being sent, so it widens no disclosure, but the README's four-item list does not
  mention it and a reviewer should know it is there. Template literals are included with
  interpolations rendered as `${expr}` source text — so an interpolated secret-bearing expression
  _name_ (not its value) can appear.

The request travels `client.systemOne({ state, questions, model })` → SDK `POST /v1/systemone` with
body `{ ...request, model }` (`@typesafe-ai/sdk` `dist/index.mjs:548`). The SDK adds only
`Authorization`, `Accept`, `User-Agent`, `X-TypeSafe-SDK`, `X-TypeSafe-Runtime`, `Content-Type`.

**Filename and cwd never leave the machine.** They are in the worker request object
(`req.filename`, `req.cwd`) but are used only to resolve the cache directory and look for API keys;
neither is referenced when building `state`. Confirmed by reading every use of `req.cwd` and
`req.filename` in `dist/worker.js`.

**Consequence for the README caveat we must publish:** the model sees one function at a time with
no caller, no callee body, no types beyond the signature text and no file path. It therefore cannot
speak to cross-function architecture, call-graph correctness, or whether a function is correct
against a spec it was never shown. It judges a name, a comment and a body against each other.

## 2. Provider selection — the sharpest edge

```js
var PROVIDERS = ["auto", "typesafe", "openrouter"];
DEFAULT_SETTINGS.provider = "auto";
```

Under `provider: "auto"` (the default), `resolveBackend` falls back to **OpenRouter** whenever no
TypeSafe key is found but `OPENROUTER_API_KEY` is:

```js
if (tsKey) return { backend: "typesafe", apiKey: tsKey };
if (orKey) return { backend: "openrouter", apiKey: orKey };
```

That would send this repository's source to `https://openrouter.ai/api/alpha/decisions` — a third
party, on a beta endpoint — without any diagnostic saying the backend changed. The lane brief's
"explicit TypeSafe provider" requirement is exactly the mitigation: `provider: "typesafe"` pins the
backend regardless of which keys happen to be in the environment, and makes a missing TypeSafe key
an error rather than a silent reroute. **`provider` must never be left at `auto` in this repo.**

## 3. API key resolution

`resolveApiKey(cwd)` checks, in order: `process.env.TYPESAFE_API_KEY`, then a `.env` file in the
ESLint cwd parsed by the plugin's own reader, then `~/.config/jev/config.json` (`{"apiKey": …}`).

Two notes. First, the plugin will read a repo-local `.env` on its own — so `.env*` staying
git-ignored matters for more than tidiness. This repo's `.gitignore` already covers `.env` and
`.env.*`. Second, our key lives at `~/.config/typesafe/env`, which the plugin does **not** read; it
must be exported into the environment of the process that runs ESLint. No key is written into the
repo, a `.env`, CI, or any output.

## 4. Threshold semantics — "yes" means violation

Confirmed for all three rules. Each question is a `noul` (probability) question worded so that
_true_ is the defect, and each rule reports only when the probability meets the threshold:

| Rule                    | Question asks                                                               | Report when                                           |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `name-matches-body`     | does the name promise something **different** from the body                 | `main >= threshold` (default 0.80)                    |
| `comment-matches-code`  | does the comment **contradict** the body / does the body hide a side effect | `max(contradicts, hides) >= threshold` (default 0.80) |
| `helpful-error-message` | would a reader be **unable** to tell what went wrong                        | `p >= threshold` per throw (default 0.85)             |

The custom `check` rule enforces the same convention by documentation only: the question text is
passed through verbatim and reported when the answer is yes, so a question phrased so that "yes"
means _good_ silently inverts. Our per-repo questions must be worded as defects.

Thresholds are schema-bounded to `[0.5, 1]`. The reported message always carries the probability
and the threshold it was judged against, which is what makes the output auditable.

## 5. Autofix — renames are suggestion-only

`name-matches-body` sets `hasSuggestions: true` and attaches a rename under `suggest:`. No rule in
the package defines a `fix`. ESLint never applies suggestions from `--fix`; they apply only when a
human selects the quick fix in an editor. **`eslint --fix` cannot rename anything here**, which
satisfies the "no autofix renames" requirement out of the box — no configuration needed.

Residual, worth knowing: an editor quick-fix _will_ rename on an explicit click, and it rewrites the
declaration identifier only, not call sites. The scoped instructions say so.

## 6. Concurrency, timeout, cache, model

| Setting             | Default                                 | Behaviour                                                                                      |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `concurrency`       | 6                                       | clamped to `1..16`, then `min(concurrency, cacheMisses)` workers                               |
| `timeoutMs`         | 8000                                    | **a per-file deadline, not per request** — one `AbortController` covers every unit in the file |
| `maxFunctionTokens` | 6000                                    | units above it are dropped at extraction and reported by `jev/too-large`                       |
| `cacheDir`          | `node_modules/.cache/eslint-plugin-jev` | JSONL, 20 MB cap, halved when exceeded                                                         |
| `model`             | `jev-latest`                            | an alias — see below                                                                           |

The per-file deadline is the setting most likely to surprise: a file with many uncached functions
can exhaust the budget and skip its tail (§7). The pilot config raises it accordingly.

Cache key is `sha256(backend, model, questionText, stateText)`. Because `stateText` is the full
serialized state, any edit to a function refetches only that function. The cache stores the answer,
the resolved model id and a timestamp — **not** the source. Switching `provider` or `model`
invalidates by design.

`model: "jev-latest"` is an alias, and cached answers survive the alias moving. The brief requires
pinning the validated model id; the resolved id is available because the worker records
`res.model = out.model` from the response. The benchmark run resolved it and the pinned value is
recorded in `pilot-2026-09-21.md` and set in `eslint.semantic.config.js`.

## 7. Failure reporting — the one real gap

This is the risk that matters for "never report a skipped check as clean".

**What is reported.** With `strict: true`, errors with no `unitId` — a missing key, a rejected key,
an unreachable host — are reported as a real ESLint diagnostic at line 1:
`eslint-plugin-jev: TYPESAFE_API_KEY not set … Jev rules are skipped.` `strict` does not change
severity, so at `warn` these surface without failing anything.

**What is not.** Without `strict`, those same failures are a single `console.warn`, guarded by a
module-level `warnedOnce` — i.e. **once per ESLint process, across every rule and every file**, and
never in `--format json`. A machine consumer of advisory-mode output cannot distinguish "clean" from
"never ran". This is why the semantic config sets `strict: true` despite advisory severity.

**What is not reported even in strict mode:** per-unit errors. In `createJevRule`:

```js
for (const unit of selected) {
  if (res.errors.some((e) => e.unitId === unit.id)) continue;
  spec.report({ … });
}
```

A unit skipped for `timeout` (file deadline reached), `rate_limit`, or a request-stage `too_large`
is silently passed over. `jev/too-large` covers only the _extraction_-stage skip, not the
request-stage one. The package README states this limitation plainly, and the code matches.

**Mitigation adopted.** Configuration cannot close this, so the wrapper carries it: `npm run
lint:semantic` runs through `scripts/lint-semantic.sh`, which refuses to report success on a run it
cannot vouch for, and the scoped instructions state that a semantic run is evidence only about the
functions it actually judged. The honest framing throughout is _skipped_, never _clean_.

## 8. Other observations

- `ignoreNames` defaults to `^use[A-Z]`, `^on[A-Z]`, `^handle[A-Z]`, `^toJSON$`; object-literal
  properties and anonymous `default` exports are also excluded from `name-matches-body`, on the
  stated reasoning that the consumer picks those names, not the body's author.
- `comment-matches-code` skips pragma comments (`eslint-*`, `@ts-*`, licence headers, etc.).
- The bundled `configs.recommended` turns all four rules on at `warn` and disables
  `helpful-error-message` in test files. This repo does **not** extend it — rules are listed
  explicitly so thresholds and scope stay visible in review.
- `JEV_FAKE_ANSWERS` / `JEV_FAKE_ERRORS` short-circuit the worker with scripted answers from a JSON
  file. That is the supported offline seam, and the offline tests use it — no key, no network.
- `synckit` runs the worker synchronously via a worker thread with `timeout: timeoutMs + 2000`.
