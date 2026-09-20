# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- See `README.md` for verified Pi/TypeSafe contracts, scope boundaries, credentials, and validation commands.
- The Pi entry is `src/extension.ts`; question policy lives in `src/checks.ts`, failure/timeout handling in `src/sidecar.ts`, and runtime response checks in `src/verdict.ts`. Keep advisory mode the default and judge failures a quiet no-op.
- Keep SDK request/response types authoritative; the thin boundary is `src/typesafe.ts`.
- Offline development must work without credentials; keep live tests in `test/integration/` and skip them when the key is absent.
- Treat the filesystem check as a path-based model assessment, not deterministic containment; `README.md` documents alias/race limits and best-effort timing.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
