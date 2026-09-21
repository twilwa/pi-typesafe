# Wiki record (ready to file)

Record-ready text for the fleet wiki, per TES-93. **Not filed by this lane** — a research-wiki lane
files it. Written 2026-09-21; do not edit the wiki from here.

Suggested page: _Tooling → Lint and diagnostics → Semantic lint (Jev)_.

---

## Semantic lint (eslint-plugin-jev)

**Status:** piloted in `pi-typesafe`, 2026-09-21. Advisory only. Not gating anything.

**What it is.** `@shahriarbijoy/eslint-plugin-jev@0.3.0` (MIT) turns plain-English questions into
ESLint rules, answered by TypeSafe's Jev model. Three rules are in use: `name-matches-body` (0.80),
`comment-matches-code` (0.80) and `helpful-error-message` (0.85). "Yes" always means violation.

**Where it applies.** JS/TS repositories only; never Python, Bash or Bend. Current verdicts: pilot
in `pi-typesafe`; later rollout for `jev-code` and `factory-visibility`; not applicable for
`research-agent` (stray `.ts` in a Python project) and the nine Python/Bash repos. Full matrix with
reasons and proposed per-repo questions: `docs/jev-lint/adoption-matrix.md` in `pi-typesafe`.

**What the pilot measured.** 30 live API calls against a 40-call budget. Seed benchmark 9/10 on
`name-matches-body` (the one failure a 0.79-vs-0.80 near-miss). Pilot over 5 files and 15 functions:
**zero findings**, per-request latency 67–234 ms, 3.3 s for the whole cold run, free when cached. A
positive control on a deliberately bad fixture fired all three rules, so the zero-finding result is
a true negative rather than a broken pipeline. `comment-matches-code` and `helpful-error-message`
remain **uncalibrated** — no labelled set exists for them.

**The limitation that matters.** The API receives one function at a time: name, signature, leading
comment and body only — no file path, no imports, no neighbouring code. It therefore **cannot prove
cross-function architecture or correctness**, only whether a name, comment and body agree with each
other. Deterministic lint, typecheck and tests stay authoritative.

**Three adoption traps**, all found by reading the published package rather than its README:

1. `provider` defaults to `"auto"`, which silently falls back to OpenRouter whenever
   `OPENROUTER_API_KEY` is set — sending source to a third party with no diagnostic. Always pin
   `provider: "typesafe"`.
2. The default model `jev-latest` is a moving alias, and cached answers survive the alias moving.
   Pin a resolved id (`jev-1.13.0` at pilot time).
3. Without `strict: true`, a missing key or an unreachable API is one `console.warn` per **process**
   and never appears in `--format json`. A machine reading advisory output cannot tell "clean" from
   "never ran". Even with `strict`, functions skipped for the per-file deadline or a rate limit are
   not reported at all — so wrap the run and print **skipped**, never clean.

**Cost.** $0.042 per million input tokens, output free. The pilot's 30 calls were ~11k input tokens,
well under a cent. Answers cache on disk keyed by content, so re-runs are free.

**Sources.** `docs/jev-lint/package-review.md`, `docs/jev-lint/pilot-2026-09-21.md`,
`docs/jev-lint/adoption-matrix.md` in `pi-typesafe`. Linear TES-93 (child of TES-59).
