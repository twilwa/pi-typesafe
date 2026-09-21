# Jev semantic lint — adoption matrix

Lane: lint, diagnostic and AGENTS conventions (Linear **TES-93**, child of **TES-59**), 2026-09-21.
Baseline is the completed lint-convention audit (scout `fw-lint-convention-audit`); this matrix is
the implementation follow-up and does not repeat the audit.

Package under consideration: `@shahriarbijoy/eslint-plugin-jev@0.3.0`
([review](./package-review.md)). ESLint is applied **only to JavaScript and TypeScript**; it is
never forced onto Python, Bash or Bend repositories.

## Matrix

| Repo                           | Language scope                                | Verdict            | Reason                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pi-typesafe**                | TypeScript, ESLint 10 flat config, exact pins | **Pilot — done**   | Only repo already carrying flat config, exact pins and a `npm run check` that CI mirrors. Piloted on 5 files / 15 functions; see [pilot](./pilot-2026-09-21.md).                                                                                   |
| **jev-code**                   | TypeScript fork                               | **Later rollout**  | No lint at all today, so ESLint itself must land before any semantic layer. Release is held on an upstream licence question; adding tooling now would tangle an unrelated blocker. Sequence: flat config + `check` script first, then this plugin. |
| **factory-visibility**         | Vanilla web `*.js`, no `package.json`         | **Later rollout**  | In JS scope, but has no package manifest, so the plugin has nowhere to pin. An integration lane is live in that repo — **do not touch it**; matrix entry only. Revisit once that lane lands and a manifest exists.                                 |
| **research-agent**             | Python project with stray `.ts` files         | **Not applicable** | The `.ts` files are incidental to a non-JS project, not a TypeScript codebase. Standing up ESLint to lint strays would create a toolchain the project does not otherwise need. Delete or relocate the strays instead.                              |
| **research-wiki**              | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **harness-lab**                | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **jev-lab**                    | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **fleet-learning**             | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **factory-tools**              | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **story-to-anime**             | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **engineering-workflow-study** | Python                                        | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |
| **firstmate**                  | Python / Bash                                 | **Not applicable** | Not a JS/TS codebase.                                                                                                                                                                                                                              |

One pilot, two later-rollout candidates, nine not applicable.

## Rollout preconditions

Any repo adopting this must carry, from the pilot's experience:

1. `provider: "typesafe"` set explicitly — the default `"auto"` silently falls back to OpenRouter
   when `OPENROUTER_API_KEY` is present ([review §2](./package-review.md)).
2. A model pinned to a resolved id, not the `jev-latest` alias.
3. `strict: true` at `warn` severity, plus a wrapper that prints **skipped**, so an inactive run can
   never read as clean.
4. The semantic rules in a **separate** config file, leaving the deterministic `lint`/`check` path
   untouched and offline.
5. Ignores covering generated, vendored and secret-bearing paths: `dist`, `coverage`,
   `node_modules`, `package-lock.json`, `.env*`.
6. A README note stating that the API receives only function name, signature, comment and body, and
   cannot prove cross-function architecture or correctness.

## Proposed per-repo custom questions

`jev/check` questions are proposed only where a **deterministic** check cannot do the job — never
for anything countable, which ordinary ESLint rules already do exactly and for free. Maximum three
per repo. Every question is worded so that **"yes" means violation**.

### pi-typesafe — none proposed

The two repo-specific invariants worth enforcing are both better served deterministically or not
served at all by a per-function judge:

- _"Does this judge failure change the tool result?"_ — real invariant, but it spans
  `sidecar.ts` and `verdict.ts`, and the API sees one function at a time. Out of reach by
  construction; the existing unit tests already cover it.
- _"Is advisory mode still the default?"_ — a single config literal. A deterministic test asserts
  this today, exactly, and should keep doing so.

Adding a judged question here would buy noise, not signal.

### jev-code — proposed when it reaches rollout (max 3)

1. `no-silent-catch` — "Does this function swallow a caught error without logging it, rethrowing it,
   or returning a value that records the failure?" Yes = violation. Deterministic linting can see a
   bare `catch {}` but not a `catch` whose body discards the error through a branch.
2. `no-secret-in-message` — "Does this function put a token, key, password or other credential value
   into a log line or error message?" Yes = violation. Name-based greps catch the variable _named_
   `token`; they do not catch the interpolated value that came from one.
3. `upstream-attribution` — "Does this function's comment claim behaviour that the body inherits
   from upstream rather than implements here?" Yes = violation. Directly serves the open licence and
   provenance question; nothing deterministic can judge a prose claim.

### factory-visibility — proposed when it reaches rollout (max 2)

1. `no-secret-in-message` — as above; a browser bundle is the worst place to leak one.
2. `dom-handler-honesty` — "Does this function's name or comment promise it only reads page state
   while the body also mutates the DOM or issues a network request?" Yes = violation. The audit
   found handler-shaped functions doing more than their names admit; this is exactly the
   name-vs-body judgement, scoped to the one pattern that matters in vanilla web code.

Each of these must be validated against observed fixtures in its own repo before being switched on
— `name-matches-body` is the only rule with any calibration today, and these are new questions, not
that rule.

## Follow-ups to file

Agent-proposed, linked to TES-93, one per later-rollout repo:

- **jev-code**: stand up ESLint flat config and a deterministic `check` script, then adopt the
  semantic layer with the three questions above. Blocked on the upstream licence question.
- **factory-visibility**: add a `package.json` and flat config once the live integration lane lands,
  then adopt with the two questions above.
