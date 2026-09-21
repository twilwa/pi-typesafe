/**
 * Offline contracts for the optional semantic lint.
 *
 * Both tests run without a TypeSafe key and without network access: one asserts
 * the plugin announces itself as inactive rather than silently passing, the
 * other asserts the deterministic `npm run lint` does not involve the plugin at
 * all. See docs/jev-lint/package-review.md.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureDir = join(repoRoot, "test/fixtures/jev-lint");

/**
 * Run ESLint with no credentials reachable: no `TYPESAFE_API_KEY` and no
 * `OPENROUTER_API_KEY` in the environment, `HOME` pointed at an empty directory
 * so `~/.config/jev/config.json` cannot be found, and the working directory set
 * to the fixture directory so the plugin's own `.env` reader finds nothing.
 */
function eslintWithoutKey(args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), "jev-nokey-")),
  };
  delete env.TYPESAFE_API_KEY;
  delete env.OPENROUTER_API_KEY;
  try {
    return execFileSync("npx", ["eslint", ...args], {
      cwd: fixtureDir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // ESLint exits 1 when it reports problems; that is the expected path here.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === "string" && out) return out;
    throw err;
  }
}

test("without a key the plugin reports its rules inactive, not clean", () => {
  const raw = eslintWithoutKey([
    "--no-config-lookup",
    "-c",
    join(fixtureDir, "inactive.config.js"),
    "--format",
    "json",
    join(fixtureDir, "sample.ts"),
  ]);
  const results = JSON.parse(raw) as {
    messages: { message: string; ruleId: string | null }[];
  }[];
  const messages = results.flatMap((r) => r.messages);

  // The point of `strict: true`: the missing key is a real diagnostic in
  // machine-readable output, not a console warning a JSON consumer never sees.
  const inactive = messages.find((m) =>
    m.message.includes("eslint-plugin-jev:"),
  );
  assert.ok(
    inactive,
    `expected an inactive-rules diagnostic, got: ${JSON.stringify(messages)}`,
  );
  assert.match(inactive.message, /TYPESAFE_API_KEY not set/);
  assert.match(inactive.message, /skipped/i);

  // And no judgement was invented in the absence of a judge.
  const judgements = messages.filter(
    (m) =>
      m.ruleId?.startsWith("jev/") && !m.message.includes("eslint-plugin-jev:"),
  );
  assert.deepEqual(judgements, []);
});

test("the deterministic lint does not depend on the plugin", () => {
  const printConfig = (config: string): Record<string, unknown> => {
    const raw = execFileSync(
      "npx",
      [
        "eslint",
        "-c",
        config,
        "--print-config",
        join(repoRoot, "src/sidecar.ts"),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return JSON.parse(raw) as Record<string, unknown>;
  };

  const deterministic = printConfig(join(repoRoot, "eslint.config.js"));
  const jevRules = Object.keys(deterministic.rules as object).filter((r) =>
    r.startsWith("jev/"),
  );
  assert.deepEqual(
    jevRules,
    [],
    "eslint.config.js must stay deterministic: `npm run lint` and `npm run check` must not call an API",
  );
  assert.equal((deterministic.plugins as string[]).includes("jev"), false);

  // Positive control: the rules really are enabled in the semantic config, so
  // the assertion above is about scoping and not about a typo in the rule names.
  const semantic = printConfig(join(repoRoot, "eslint.semantic.config.js"));
  const semanticRules = Object.keys(semantic.rules as object).filter((r) =>
    r.startsWith("jev/"),
  );
  assert.deepEqual(semanticRules.sort(), [
    "jev/comment-matches-code",
    "jev/helpful-error-message",
    "jev/name-matches-body",
    "jev/too-large",
  ]);
});
