// Optional semantic lint. Layered on top of the deterministic `eslint.config.js`
// so that `npm run lint` — and therefore `npm run check` — stays deterministic
// and offline. Run it with `npm run lint:semantic`, which needs a TypeSafe key.
//
// Every function linted here is sent to the TypeSafe API: name, signature,
// leading comment and body only. See docs/jev-lint/package-review.md.
import jev from "@shahriarbijoy/eslint-plugin-jev";
import base from "./eslint.config.js";

export default [
  ...base,
  {
    name: "jev/semantic",
    // Source only. Tests, fixtures and scripts are not worth the calls, and the
    // benchmark fixtures deliberately contain misleading names.
    files: ["src/**/*.ts"],
    plugins: { jev },
    settings: {
      jev: {
        // Pin the backend. Left at the default "auto" the plugin falls back to
        // OpenRouter whenever OPENROUTER_API_KEY happens to be set, which would
        // send this source to a third party with no diagnostic.
        provider: "typesafe",
        // Pinned to the id validated by the seed benchmark (9/10), not the
        // moving "jev-latest" alias. Re-run scripts/jev-bench.ts before moving it.
        model: "jev-1.13.0",
        // Report a missing key or an unreachable API as a diagnostic instead of
        // one console warning per process. Does not change severity: these stay
        // warnings. This is what keeps an inactive run from reading as clean.
        strict: true,
        concurrency: 4,
        // A per-file deadline covering every function in the file, not a
        // per-request timeout.
        timeoutMs: 30000,
        maxFunctionTokens: 4000,
        cacheDir: "node_modules/.cache/eslint-plugin-jev",
      },
    },
    rules: {
      // Advisory. "Yes" means violation; the probability and threshold are in
      // every message so a reader can judge the judgement.
      "jev/name-matches-body": ["warn", { threshold: 0.8 }],
      "jev/comment-matches-code": ["warn", { threshold: 0.8 }],
      "jev/helpful-error-message": ["warn", { threshold: 0.85 }],
      // Reports functions too large to judge rather than dropping them quietly.
      "jev/too-large": "warn",
    },
  },
];
