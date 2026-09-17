import assert from "node:assert/strict";
import { test } from "node:test";
import { createTypeSafe, noul } from "../../src/typesafe.ts";

const hasKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());

test(
  "live System One smoke test",
  {
    skip: hasKey ? false : "TYPESAFE_API_KEY is absent",
    timeout: 20000,
  },
  async () => {
    const client = createTypeSafe({ timeout: 15000, retry: { maxRetries: 0 } });
    const result = await client.systemOne({
      state: "The test fixture contains the word apple.",
      questions: { present: noul("Does the state contain the word apple?") },
    });
    assert.equal(result.answers.present.type, "noul");
    assert.ok(
      result.answers.present.noul >= 0 && result.answers.present.noul <= 1,
    );
    assert.equal(typeof result.model, "string");
    assert.ok(result.usage.input_tokens >= 0);
  },
);
