// Fixture config for the wrapper-classification test: the semantic rules plus
// an error-severity deterministic rule, so a run can exit 1 while the plugin is
// simultaneously inactive. Used with JEV_FAKE_ANSWERS/JEV_FAKE_ERRORS so the
// test stays offline.
import jev from "@shahriarbijoy/eslint-plugin-jev";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { jev },
    settings: {
      jev: { provider: "typesafe", model: "jev-1.13.0", strict: false },
    },
    rules: {
      "no-unused-vars": "error",
      "jev/name-matches-body": ["warn", { threshold: 0.8 }],
    },
  },
];
