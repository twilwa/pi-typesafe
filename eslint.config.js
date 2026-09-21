import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated, vendored and secret-bearing paths are never linted or sent anywhere.
  {
    ignores: [
      "node_modules/",
      // Deliberately bad code: the jev fixtures exist to trip rules on demand
      // under their own configs, so the deterministic lint must leave them be.
      "test/fixtures/jev-lint/",
      "coverage/",
      "dist/",
      "package-lock.json",
      ".env",
      ".env.*",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);
