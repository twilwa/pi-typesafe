# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- See `README.md` for verified Pi/TypeSafe contracts, scope boundaries, credentials, and validation commands.
- The Pi entry is `src/extension.ts`; sidecar question policy lives in `src/checks.ts`, failure/timeout handling in `src/sidecar.ts`, startup worker selection in `src/selection.ts`, and runtime response checks in `src/verdict.ts`. Keep advisory mode the default and judge failures a quiet no-op.
- Catalog-backed startup loading lives in `src/extension-catalog.ts`; `README.md` defines its additive manifest fields and local-only verification contract. Keep catalog decisions in the selection receipt and never download an artifact.
- Keep SDK request/response types authoritative; the thin boundary is `src/typesafe.ts`.
- Offline development must work without credentials; keep live tests in `test/integration/` and skip them when the key is absent.
- Treat the filesystem check as a path-based model assessment, not deterministic containment; `README.md` documents alias/race limits and best-effort timing.

## Linting

- `npm run check` (format, lint, typecheck, test) is the authoritative gate. It is deterministic,
  offline, and needs no credentials; CI runs the same command against Pi 0.85.1 and 0.87.0 in
  isolated prefixes. `test/integration/pi-lifecycle.test.ts` holds both releases to the real-session
  lifecycle contract. Keep it that way.
- `npm run lint:semantic` is an **optional** advisory check: `eslint-plugin-jev` asks the TypeSafe
  Jev model plain-English questions about each function, configured in `eslint.semantic.config.js`
  and never in `eslint.config.js`. It needs a key:
  Set `TYPESAFE_API_KEY` in the environment or use a gitignored local `.env` file. Never commit
  a real key or include one in CI.
- **Missing key: the rules report themselves inactive and nothing is judged.** That is a _skipped_
  result, never a clean one; `scripts/lint-semantic.sh` prints a SKIPPED banner and
  `test/unit/jev-lint.test.ts` holds it to that. Functions skipped for the per-file deadline or a
  rate limit are not reported by the plugin at all, so a semantic run is evidence only about the
  functions it actually judged.
- The wrapper classifies every run and never calls an unjudged one clean. It prints **INCONCLUSIVE**
  when the plugin says it is unavailable, when ESLint exits 2+, and when ESLint exits 1 with no
  `jev/` output at all — that last case is indistinguishable from a silent plugin failure
  (`strict: false`, a per-unit timeout, a rate limit), so it is reported as no evidence rather than
  as a pass.
- **What the API sees:** one function at a time — name, signature, leading comment and body — with
  no file path, imports, or neighbouring code. It therefore cannot prove cross-function
  architecture or correctness, only whether a name, comment and body agree with each other.
  Judgements carry a probability; they are advice, not proof, and nothing gates on them.
- Editor: point ESLint at the semantic config only if you want judgements inline, e.g. VS Code
  `"eslint.options": { "overrideConfigFile": "eslint.semantic.config.js" }` plus
  `"eslint.execArgv": ["--env-file=.env"]`. Left unset, the editor behaves exactly as before.
  `--fix` never renames anything: `name-matches-body` offers renames as editor _suggestions_ only,
  and a suggestion rewrites the declaration, not its call sites.
- Thresholds and their evidence live in `docs/jev-lint/pilot-2026-09-21.md`; the model is pinned to
  the id validated there. `name-matches-body` is calibrated (9/10 on a 10-case seed);
  `comment-matches-code` and `helpful-error-message` are **uncalibrated**. Re-run
  `npm run bench:jev` and the observed-exception fixtures before changing any threshold or the
  model pin.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
