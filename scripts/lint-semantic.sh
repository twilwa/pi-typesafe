#!/usr/bin/env bash
# Optional semantic lint (eslint-plugin-jev, judged by TypeSafe's Jev model).
#
# Advisory by design: this script never fails the build on a judgement. What it
# does guarantee is that a run which did not actually judge your code says so.
# A semantic run is evidence only about the functions it judged.
#
#   set -a; . ~/.config/typesafe/env; set +a
#   npm run lint:semantic
#
# Without a key the plugin reports its rules inactive and this script prints
# SKIPPED. It never prints a clean result for a check that did not run.
set -uo pipefail

banner() { printf '\n%s\n' "────────────────────────────────────────────────────────"; }

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  banner
  echo "SKIPPED: semantic lint did not run — TYPESAFE_API_KEY is not set."
  echo "This is NOT a clean result. No function was judged."
  echo "Load the key and re-run:  set -a; . ~/.config/typesafe/env; set +a"
  banner
  exit 0
fi

out=$(npx eslint --no-error-on-unmatched-pattern -c eslint.semantic.config.js "$@" 2>&1)
status=$?
printf '%s\n' "$out"

banner
if printf '%s' "$out" | grep -q "eslint-plugin-jev:"; then
  echo "SKIPPED (partly or wholly): the plugin reported itself unavailable above."
  echo "Treat this run as inconclusive, not clean."
elif [ "$status" -gt 1 ]; then
  echo "SKIPPED: eslint exited $status before finishing. Inconclusive, not clean."
else
  echo "Semantic lint ran. Any warnings above are advisory judgements with a"
  echo "probability attached, not proof. Functions skipped for the per-file"
  echo "deadline or a rate limit are NOT reported by the plugin, so this is"
  echo "evidence only about the functions actually judged."
fi
echo "The API saw only each function's name, signature, leading comment and body."
banner
exit 0
