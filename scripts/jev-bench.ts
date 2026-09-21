/**
 * Replay the seeded `name-matches-body` benchmark against the live Jev model.
 *
 * Ten labelled cases, one System One request each, so a run costs exactly ten
 * API calls. It reports accuracy at the configured threshold and prints the
 * resolved model id, which is the id pinned in `eslint.semantic.config.js`.
 *
 * Usage: set -a; . ~/.config/typesafe/env; set +a; node scripts/jev-bench.ts
 */
import { readFileSync } from "node:fs";
import { TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";

const LABELS = "test/fixtures/jev-lint/name-matches-body.jsonl";
const THRESHOLD = 0.8;
const MODEL = process.env.JEV_MODEL ?? "jev-latest";

interface Label {
  id: string;
  expected: boolean;
  note: string;
  unit: {
    name: string;
    signature: string;
    body: string;
    throws: { id: string; message: string; line: number }[];
  };
}

/**
 * The `name-matches-body` question set, copied verbatim from the plugin's
 * `src/questions/specs.ts` so the benchmark measures the shipped wording.
 */
const questions = {
  main: {
    type: "noul",
    instructions:
      "Does `function.name` promise a different action, object, or result than `function.body` performs?",
    criteria: {
      true: "The name describes an action or result the body does not perform, or the body's main effect is something the name hides. Examples: the name says get and the body deletes; the name says validate and the body saves; the name says fetchUser and the body returns orders.",
      false:
        "The name is a fair label for the body's main effect, even if it leaves out details such as helpers, logging, caching, or error handling. Examples: getUser that reads from a cache then the database; saveOrder that also validates before saving.",
    },
  },
} as const;

function stateFor(label: Label) {
  const fn: Record<string, JsonValue> = {
    name: label.unit.name,
    signature: label.unit.signature,
    body: label.unit.body,
  };
  if (label.unit.throws.length) {
    fn.throws = Object.fromEntries(
      label.unit.throws.map((t) => [
        t.id,
        { message: t.message, line: `L${String(t.line).padStart(3, "0")}` },
      ]),
    );
  }
  return { function: fn };
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "TYPESAFE_API_KEY is not set. The benchmark needs a key; it is not run in CI.",
  );
  process.exit(2);
}

const labels: Label[] = readFileSync(LABELS, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Label);

const client = new TypeSafeClient({
  apiKey,
  defaultModel: MODEL,
  logLevel: "off",
});

let calls = 0;
let correct = 0;
let resolvedModel = MODEL;
let inputTokens = 0;
const rows: string[] = [];
const started = Date.now();

for (const label of labels) {
  const t0 = Date.now();
  const out = await client.systemOne({
    state: stateFor(label),
    questions,
    model: MODEL,
  });
  calls++;
  const ms = Date.now() - t0;
  resolvedModel = out.model ?? resolvedModel;
  inputTokens += out.usage?.input_tokens ?? 0;
  const p = out.answers.main.noul as number;
  const flagged = p >= THRESHOLD;
  const ok = flagged === label.expected;
  if (ok) correct++;
  rows.push(
    `| ${label.id} | \`${label.unit.name}\` | ${label.note} | ${label.expected} | ${p.toFixed(2)} | ${flagged} | ${ok ? "PASS" : "**FAIL**"} | ${ms} |`,
  );
}

console.log(`model: ${resolvedModel}`);
console.log(`threshold: ${THRESHOLD}`);
console.log(`api calls: ${calls}`);
console.log(`input tokens: ${inputTokens}`);
console.log(`wall clock: ${Date.now() - started} ms`);
console.log(`accuracy: ${correct}/${labels.length}`);
console.log("");
console.log("| case | name | note | expected | P | flagged | result | ms |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);
