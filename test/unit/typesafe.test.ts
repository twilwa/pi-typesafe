import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticationError, TypeSafeError } from "@typesafe-ai/sdk";
import {
  choice,
  score,
  noul,
  createTypeSafe,
  type SystemOneResult,
} from "../../src/typesafe.ts";

const questions = {
  color: choice("Color?", { red: null, blue: null }),
  amount: score("Amount?", ["none", "some", "all"]),
  present: noul("Present?"),
};
const result: SystemOneResult<typeof questions> = {
  model: "test-model",
  answers: {
    color: {
      type: "choice",
      choice: "red",
      confidence: 0.8,
      probabilities: { red: 0.9, blue: 0.1 },
    },
    amount: {
      type: "score",
      score: 1.2,
      confidence: 0.7,
      legend: { "0": "none", "1": "some", "2": "all" },
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
    },
    present: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 10, output_tokens: 3 },
};

test("serializes mixed primitives and preserves typed answers and response metadata", async () => {
  let calls = 0;
  const client = createTypeSafe({
    apiKey: "unit-test-key",
    baseURL: "https://typesafe.invalid",
    retry: { maxRetries: 0 },
    defaultModel: "default-model",
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://typesafe.invalid/v1/systemone");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer unit-test-key");
      assert.equal(headers.get("x-test"), "forwarded");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        state: { value: "red" },
        questions: {
          color: {
            type: "choice",
            instructions: "Color?",
            criteria: { red: null, blue: null },
          },
          amount: {
            type: "score",
            instructions: "Amount?",
            criteria: ["none", "some", "all"],
          },
          present: { type: "noul", instructions: "Present?" },
        },
        model: "test-model",
      });
      return Response.json(result, {
        headers: { "x-typesafe-request-id": "test-request" },
      });
    },
  });
  const response = await client
    .systemOne(
      { state: { value: "red" }, questions, model: "test-model" },
      { headers: { "x-test": "forwarded" }, timeout: 1000 },
    )
    .withResponse();
  assert.deepEqual(response.data, result);
  assert.equal(response.requestId, "test-request");
  assert.equal(calls, 1);
  const label: "red" | "blue" = response.data.answers.color.choice;
  assert.equal(label, "red");
  // @ts-expect-error The wrapper must preserve the SDK's literal choice keys.
  const invalidLabel: "green" = response.data.answers.color.choice;
  void invalidLabel;
  // @ts-expect-error Noul has a probability, not a separate confidence field.
  void response.data.answers.present.confidence;
});

test("uses configured default model for a single primitive", async () => {
  const client = createTypeSafe({
    apiKey: "unit-test-key",
    defaultModel: "configured-model",
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, "configured-model");
      return Response.json({
        model: "configured-model",
        answers: { yes: { type: "noul", noul: 0.5 } },
        usage: result.usage,
      });
    },
  });
  const response = await client.systemOne({
    state: null,
    questions: { yes: noul() },
  });
  assert.equal(response.answers.yes.noul, 0.5);
});

test("preserves SDK HTTP errors and per-call retry configuration", async () => {
  let calls = 0;
  const client = createTypeSafe({
    apiKey: "unit-test-key",
    logLevel: "off",
    fetch: async () => {
      calls++;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    },
  });
  await assert.rejects(
    client.systemOne({ state: null, questions }, { retry: { maxRetries: 0 } }),
    AuthenticationError,
  );
  assert.equal(calls, 1);
});

test("validates credentials only when explicitly creating a client", () => {
  const previous = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => createTypeSafe(), TypeSafeError);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
