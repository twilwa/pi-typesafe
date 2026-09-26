# Project agent memory

- `README.md` documents the TypeSafe sidecar's advisory (default), shadow, and blocking modes, checks, credentials, limits, and verification commands.
- `src/extension.ts` registers Pi hooks; `src/checks.ts` defines questions, `src/sidecar.ts` handles failures and timeouts, and `src/verdict.ts` validates answers. Judge failures must remain a quiet no-op. Keep SDK request/response types authoritative through the thin `src/typesafe.ts` boundary.
- The filesystem check is a path-based model assessment, not deterministic containment. See `README.md` for alias/race limits and best-effort timing.
- `npm run check` is the offline, credential-free gate (format, lint, typecheck, tests). CI checks Pi 0.85.1 and 0.87.0 in isolated prefixes; `test/integration/pi-lifecycle.test.ts` exercises real sessions on both. Keep live tests in `test/integration/`, skipped when no key is available.
- `npm run lint:semantic` is optional advice, never the gate. Its config is `eslint.semantic.config.js`, separate from `eslint.config.js`. Missing keys mean SKIPPED, not clean; unavailable judgment means INCONCLUSIVE. `scripts/lint-semantic.sh` and `test/unit/jev-lint.test.ts` hold this contract. The plugin sees one function at a time, not imports or callers; `docs/jev-lint/pilot-2026-09-21.md` records the model pin, thresholds, and calibration evidence. Re-run `npm run bench:jev` and the observed-exception fixtures before changing either.
- Never commit credentials. Use `TYPESAFE_API_KEY` or a gitignored local `.env`; do not add keys to CI.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
