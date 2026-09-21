// Standalone config for the offline test: the semantic rules with no `files`
// restriction, so the test can lint one fixture file directly. Mirrors the
// settings in eslint.semantic.config.js that matter for the missing-key path.
import jev from "@shahriarbijoy/eslint-plugin-jev";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { jev },
    settings: {
      jev: { provider: "typesafe", model: "jev-1.13.0", strict: true },
    },
    rules: {
      "jev/name-matches-body": ["warn", { threshold: 0.8 }],
      "jev/comment-matches-code": ["warn", { threshold: 0.8 }],
      "jev/helpful-error-message": ["warn", { threshold: 0.85 }],
    },
  },
];
