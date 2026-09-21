import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated, vendored and secret-bearing paths are never linted or sent anywhere.
  {
    ignores: [
      "node_modules/",
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
