#!/usr/bin/env bash
# Optional semantic lint (eslint-plugin-jev, judged by TypeSafe's Jev model).
#
# Advisory by design: this script never fails the build on a judgement. What it
# does guarantee is that a run which did not actually judge your code says so.
# A semantic run is evidence only about the functions it judged.
#
#   set -a; . ./.env; set +a
#   npm run lint:semantic
#
# Without a key the plugin reports its rules inactive and this script prints
# SKIPPED. It never prints a clean result for a check that did not run.
#
# JEV_SEMANTIC_CONFIG overrides the config path (used by the offline tests in
# test/unit/jev-lint.test.ts to drive the classification below).
set -uo pipefail

config="${JEV_SEMANTIC_CONFIG:-eslint.semantic.config.js}"

banner() { printf '\n%s\n' "────────────────────────────────────────────────────────"; }

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  banner
  echo "SKIPPED: semantic lint did not run — TYPESAFE_API_KEY is not set."
  echo "This is NOT a clean result. No function was judged."
  echo "Set TYPESAFE_API_KEY or load it from a gitignored .env file, then re-run."
  banner
  exit 0
fi

out=$(npx eslint --no-error-on-unmatched-pattern -c "$config" "$@" 2>&1)
status=$?
printf '%s\n' "$out"

# Did the semantic rules produce any output at all? Every plugin line — a
# judgement or an "eslint-plugin-jev:" diagnostic — carries a `jev/` rule id.
if printf '%s' "$out" | grep -q 'jev/'; then
  semantic_output=yes
else
  semantic_output=no
fi

banner
if printf '%s' "$out" | grep -q "eslint-plugin-jev:"; then
  echo "INCONCLUSIVE: the plugin reported itself unavailable above."
  echo "Some or all functions went unjudged. This is not a clean result."
elif [ "$status" -gt 1 ]; then
  echo "INCONCLUSIVE: eslint exited $status before finishing. Not a clean result."
elif [ "$status" -eq 1 ] && [ "$semantic_output" = no ]; then
  # The semantic rules are all `warn`, so they can never be the cause of an
  # exit 1. An exit 1 with no semantic output at all means error-severity
  # problems were reported and the rules produced nothing — which is what a
  # silent plugin failure (`strict: false`, a per-unit timeout, a rate limit)
  # also looks like. The two are indistinguishable from here, so neither
  # "clean" nor "failed" is honest.
  echo "INCONCLUSIVE: eslint reported error-severity problems and the semantic"
  echo "rules produced no output. That is what a silent plugin failure looks"
  echo "like too, so this run is no evidence that your code was judged."
  echo "Fix the errors above, then re-run to get a semantic result."
elif [ "$status" -eq 1 ]; then
  echo "Semantic lint ran, alongside error-severity problems reported above."
  echo "Fix those first; they are deterministic and authoritative."
  echo "Any jev warnings are advisory judgements with a probability attached."
else
  echo "Semantic lint ran. Any warnings above are advisory judgements with a"
  echo "probability attached, not proof. Functions skipped for the per-file"
  echo "deadline or a rate limit are NOT reported by the plugin, so this is"
  echo "evidence only about the functions actually judged."
fi
echo "The API saw only each function's name, signature, leading comment and body."
banner
exit 0
