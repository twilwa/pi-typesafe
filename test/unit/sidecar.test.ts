import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import type {
  ToolCallEvent,
  WriteToolCallEvent,
  BashToolCallEvent,
  EditToolCallEvent,
  EditToolDetails,
  ToolResultEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { verdicts } from "../../src/verdict.ts";
import extension from "../../src/extension.ts";
import { guardChecks, criticChecks, checks } from "../../src/checks.ts";
import { readConfig } from "../../src/config.ts";
import type { JudgeContext } from "../../src/context.ts";
import { createSidecar, type SidecarOptions } from "../../src/sidecar.ts";
import type { Questions, SystemOneRequest } from "../../src/typesafe.ts";

// Keep fixtures inside this worktree; no real user data and no network.
const root = await mkdtemp(resolve(".jev-test-"));
execFileSync("git", ["init", "-q", root]);
after(() => rm(root, { recursive: true, force: true }));
const ctx: JudgeContext = {
  cwd: root,
  signal: undefined,
  sessionManager: {
    getBranch: () => [
      {
        type: "message",
        id: "u",
        parentId: null,
        timestamp: "",
        message: {
          role: "user",
          content: "Implement the answer function.",
          timestamp: 0,
        },
      },
    ],
  } as JudgeContext["sessionManager"],
};
const bash: BashToolCallEvent = {
  type: "tool_call",
  toolName: "bash",
  toolCallId: "b",
  input: { command: "rm -rf valuable-data" },
};
const write: WriteToolCallEvent = {
  type: "tool_call",
  toolName: "write",
  toolCallId: "w",
  input: { path: "answer.ts", content: "export const answer = () => 42;\n" },
};
const result: ToolResultEvent = {
  type: "tool_result",
  toolName: "write",
  toolCallId: "w",
  input: write.input,
  content: [
    { type: "text", text: "Successfully wrote file" },
    { type: "image", data: "AA==", mimeType: "image/png" },
  ],
  isError: false,
  details: undefined,
};

type AnswerOverrides = Record<string, Record<string, unknown> | undefined>;
function response(questions: Questions, overrides: AnswerOverrides = {}) {
  return {
    model: "test-jev",
    usage: { input_tokens: 10, output_tokens: 20 },
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        {
          ...(q.type === "choice"
            ? {
                type: "choice",
                choice: "false",
                confidence: 0.99,
                probabilities: { true: 0.001, false: 0.999 },
              }
            : {
                type: "score",
                score: 2,
                confidence: 0.99,
                probabilities: { "0": 0, "1": 0, "2": 1 },
                legend: Object.fromEntries(
                  (q.type === "score" ? q.criteria : []).map((text, i) => [
                    i,
                    text,
                  ]),
                ),
              }),
          ...overrides[id],
        },
      ]),
    ),
  };
}
const hazard = (confidence: number) => ({
  choice: "true",
  confidence,
  probabilities: { true: 0.999, false: 0.001 },
});
const low = {
  score: 0.1,
  confidence: 0.9,
  probabilities: { "0": 0.9, "1": 0.1, "2": 0 },
};
function mocked(overrides: AnswerOverrides = {}, config = {}) {
  const requests: SystemOneRequest[] = [];
  const sidecar = createSidecar({
    env: {
      TYPESAFE_API_KEY: "mock-key",
      PI_JEV_CONFIG: JSON.stringify({ mode: "blocking", ...config }),
    },
    fetch: async (_url, init) => {
      const request: SystemOneRequest = JSON.parse(String(init?.body));
      requests.push(request);
      return Response.json(response(request.questions, overrides));
    },
  });
  return { sidecar, requests };
}
async function prepare(
  sidecar: ReturnType<typeof createSidecar>,
  event: ToolCallEvent = write,
) {
  await writeFile(
    resolve(root, "answer.ts"),
    "export const answer = () => 0;\n",
  );
  assert.equal(await sidecar.toolCall(event, ctx), undefined);
  await writeFile(
    resolve(root, "answer.ts"),
    "export const answer = () => 42;\n",
  );
}

test("hazard above or exactly at its confidence threshold blocks without terminating or mutating input", async () => {
  for (const confidence of [0.95, 0.99]) {
    const { sidecar, requests } = mocked({ destructive: hazard(confidence) });
    const original: ToolCallEvent = structuredClone(bash);
    const verdict = await sidecar.toolCall(bash, ctx);
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /Destructive operation/);
    assert.equal(verdict?.terminate, undefined);
    assert.deepEqual(bash, original);
    assert.equal(requests.length, 1);
  }
});

test("hazard below threshold allows even with high true probability", async () => {
  const { sidecar } = mocked({ destructive: hazard(0.949) });
  assert.equal(await sidecar.toolCall(bash, ctx), undefined);
});

test("one named Choice batch per preflight; model, task, repository and inputs are sent", async () => {
  const { sidecar, requests } = mocked({}, { model: "chosen-model" });
  await sidecar.toolCall(bash, ctx);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0]?.questions,
    Object.fromEntries(
      Object.entries(guardChecks).map(([id, check]) => [id, check.question]),
    ),
  );
  assert.equal(requests[0]?.model, "chosen-model");
  assert.deepEqual(requests[0]?.state, {
    repository: root,
    cwd: root,
    task: "Implement the answer function.",
    tool: "bash",
    input: bash.input,
  });
});

test("low rubric score appends fixed critique and preserves middleware content and other fields", async () => {
  const { sidecar, requests } = mocked({ implementation: low });
  await prepare(sidecar);
  const original = structuredClone(result);
  const patch = await sidecar.toolResult(result, ctx);
  assert.deepEqual(Object.keys(patch ?? {}), ["content"]);
  assert.deepEqual(
    patch?.content.slice(0, result.content.length),
    result.content,
  );
  const critique = patch?.content.at(-1);
  assert.equal(critique?.type, "text");
  if (critique?.type === "text")
    assert.match(critique.text, /implementation.*0.10\/2.*TODO/);
  assert.deepEqual(result, original);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1]?.questions,
    Object.fromEntries(
      Object.entries(criticChecks).map(([id, check]) => [id, check.question]),
    ),
  );
  const state = requests[1]?.state as Record<string, { text: string }>;
  assert.match(state.before!.text, /=> 0/);
  assert.match(state.after!.text, /=> 42/);
});

test("high score, boundary score, or low confidence passes the result through untouched", async () => {
  for (const overrides of [
    {},
    { implementation: { ...low, confidence: 0.79 } },
    {
      implementation: {
        ...low,
        score: 1,
        probabilities: { "0": 0, "1": 1, "2": 0 },
      },
    },
  ]) {
    const { sidecar } = mocked(overrides);
    await prepare(sidecar);
    assert.equal(await sidecar.toolResult(result, ctx), undefined);
  }
});

test("individual check enablement and thresholds apply to both batches", async () => {
  const { sidecar, requests } = mocked(
    { destructive: hazard(0.99), implementation: low },
    {
      checks: {
        destructive: { enabled: false },
        implementation: { confidence: 0.99 },
      },
    },
  );
  await prepare(sidecar);
  assert.equal(await sidecar.toolResult(result, ctx), undefined);
  assert.equal(requests[0]?.questions.destructive, undefined);
  const disabled = Object.fromEntries(
    Object.keys(checks).map((id) => [id, { enabled: false }]),
  );
  const off = mocked({}, { checks: disabled });
  assert.equal(await off.sidecar.toolCall(bash, ctx), undefined);
  assert.equal(off.requests.length, 0);
});

test("no key, empty key, whitespace key, and invalid configuration are quiet no-ops", async () => {
  for (const env of [
    {},
    { TYPESAFE_API_KEY: "" },
    { TYPESAFE_API_KEY: "  " },
    { TYPESAFE_API_KEY: "mock", PI_JEV_CONFIG: "{" },
  ]) {
    let calls = 0;
    const sidecar = createSidecar({
      env,
      fetch: async () => {
        calls++;
        throw new Error("must not fetch");
      },
    });
    const original: ToolCallEvent = structuredClone(bash);
    assert.equal(await sidecar.toolCall(bash, ctx), undefined);
    assert.equal(await sidecar.toolResult(result, ctx), undefined);
    assert.equal(calls, 0);
    assert.deepEqual(bash, original);
  }
});

test("transport exceptions, HTTP failures and malformed responses fail open without retries", async () => {
  const transports: NonNullable<SidecarOptions["fetch"]>[] = [
    async () => {
      throw new Error("transport failure with sensitive text");
    },
    ...[401, 429, 500, 529].map(
      (status) => async () => Response.json({ error: "failed" }, { status }),
    ),
    async () => new Response("not json"),
    async () => Response.json({ answers: {} }),
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        response(request.questions, {
          destructive: hazard(0.99),
          credentials: { confidence: "malformed" },
          implementation: { confidence: "malformed" },
        }),
      );
    },
  ];
  for (const fetch of transports) {
    let calls = 0;
    const logs: string[] = [];
    const sidecar = createSidecar({
      env: { TYPESAFE_API_KEY: "mock" },
      debug: (message) => logs.push(message),
      fetch: async (...args) => {
        calls++;
        return fetch(...args);
      },
    });
    await prepare(sidecar);
    assert.equal(await sidecar.toolResult(result, ctx), undefined);
    assert.equal(calls, 2);
    assert.equal(logs.length, 2);
    assert.ok(logs.every((line) => !line.includes("sensitive")));
  }
});

test("deadline returns even when transport ignores abort; parent cancellation also releases handler", async () => {
  for (const useParent of [false, true]) {
    let transportSignal: AbortSignal | null | undefined;
    const parent = new AbortController();
    const sidecar = createSidecar({
      env: {
        TYPESAFE_API_KEY: "mock",
        PI_JEV_CONFIG: JSON.stringify({ timeoutMs: useParent ? 500 : 40 }),
      },
      fetch: async (_url, init) => {
        transportSignal = init?.signal;
        if (useParent) setTimeout(() => parent.abort(), 10);
        return new Promise(() => {});
      },
    });
    const start = performance.now();
    assert.equal(
      await sidecar.toolCall(bash, { ...ctx, signal: parent.signal }),
      undefined,
    );
    assert.ok(performance.now() - start < 400);
    assert.equal(transportSignal?.aborted, true);
  }
});

test("unrelated tools, failed results, absent snapshots and cancelled calls do not fetch", async () => {
  const { sidecar, requests } = mocked();
  assert.equal(
    await sidecar.toolCall(
      { ...bash, toolName: "read", input: { path: "answer.ts" } },
      ctx,
    ),
    undefined,
  );
  assert.equal(await sidecar.toolResult(result, ctx), undefined);
  await prepare(sidecar);
  assert.equal(
    await sidecar.toolResult({ ...result, isError: true }, ctx),
    undefined,
  );
  assert.equal(
    await sidecar.toolCall(bash, { ...ctx, signal: AbortSignal.abort() }),
    undefined,
  );
  assert.equal(requests.length, 1);
});

test("oversized input and context failure fail open even if logging throws", async () => {
  const { sidecar, requests } = mocked();
  assert.equal(
    await sidecar.toolCall(
      { ...bash, input: { command: "x".repeat(17000) } },
      ctx,
    ),
    undefined,
  );
  assert.equal(
    await sidecar.toolCall(bash, { ...ctx, cwd: resolve(root, "missing") }),
    undefined,
  );
  assert.equal(requests.length, 0);
  const brokenLogger = createSidecar({
    env: {},
    debug: () => {
      throw new Error("logger");
    },
  });
  assert.equal(await brokenLogger.toolCall(bash, ctx), undefined);
});

test("edit critique includes Pi's diff; snapshots correlate parallel calls and clear on reset", async () => {
  const { sidecar, requests } = mocked({ style: low });
  const edit: EditToolCallEvent = {
    type: "tool_call",
    toolName: "edit",
    toolCallId: "e",
    input: { path: "answer.ts", edits: [{ oldText: "0", newText: "42" }] },
  };
  await prepare(sidecar, edit);
  const edited: ToolResultEvent = {
    ...result,
    toolName: "edit",
    toolCallId: "e",
    input: edit.input,
    details: {
      diff: "- 0\n+ 42",
      patch: "@@ -1 +1 @@\n- 0\n+ 42",
      firstChangedLine: 1,
    } satisfies EditToolDetails,
  };
  const patch = await sidecar.toolResult(edited, ctx);
  assert.ok(patch);
  assert.equal(
    (requests[1]?.state as Record<string, unknown>).diff,
    "- 0\n+ 42",
  );
  await prepare(sidecar);
  sidecar.reset();
  assert.equal(await sidecar.toolResult(result, ctx), undefined);
});

test("uses actual git root from a subdirectory and never reads symlink targets outside it", async () => {
  await mkdir(resolve(root, "sub"), { recursive: true });
  await symlink(resolve("package.json"), resolve(root, "external.json"));
  const { sidecar, requests } = mocked();
  await sidecar.toolCall(
    { ...write, input: { path: "../external.json", content: "{}" } },
    { ...ctx, cwd: resolve(root, "sub") },
  );
  const state = requests[0]?.state as Record<string, unknown>;
  assert.equal(state.repository, root);
  assert.equal((state.before as Record<string, unknown>).text, null);
});

test("configuration rejects unknown checks, invalid types, and out-of-range thresholds", () => {
  for (const config of [
    { checks: { typo: {} } },
    { timeoutMs: 0 },
    { timeoutMs: 5001 },
    { model: "" },
    { checks: { style: { confidence: 1.1 } } },
    { checks: { style: { minScore: 3 } } },
    { checks: { destructive: { minScore: 1 } } },
    { checks: { style: { enabled: "false" } } },
  ])
    assert.throws(() =>
      readConfig({
        PI_JEV_CONFIG: JSON.stringify({ mode: "blocking", ...config }),
      }),
    );
});

test("default Pi factory registers both handlers and session cleanup", () => {
  const registered: string[] = [];
  extension({
    on: (name: string) => {
      registered.push(name);
    },
  } as unknown as ExtensionAPI);
  assert.deepEqual(registered, [
    "tool_call",
    "tool_result",
    "session_start",
    "session_shutdown",
  ]);
});

test("shadow is the default: records returned model and verdicts but leaves both hooks untouched", async () => {
  const audits: unknown[] = [];
  const sidecar = createSidecar({
    env: { TYPESAFE_API_KEY: "mock" },
    record: (entry) => audits.push(entry),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        response(request.questions, {
          destructive: hazard(0.99),
          implementation: low,
        }),
        { headers: { "x-typesafe-request-id": "r-1" } },
      );
    },
  });
  await prepare(sidecar);
  assert.equal(await sidecar.toolResult(result, ctx), undefined);
  assert.equal(audits.length, 2);
  const audit = audits[0] as Record<string, unknown>;
  assert.equal(audit.model, "test-jev");
  assert.equal(audit.mode, "shadow");
  assert.equal(audit.requestId, "r-1");
  assert.match(String(audit.stateHash), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(audits),
    /mock-key|answer\.ts|export const|Implement the answer/,
  );
});

test("advisory guard never blocks and adds its warning only to the matching tool result", async () => {
  const { sidecar, requests } = mocked(
    { destructive: hazard(0.99) },
    { mode: "advisory" },
  );
  assert.equal(await sidecar.toolCall(bash, ctx), undefined);
  const bashResult: ToolResultEvent = {
    ...result,
    toolName: "bash",
    toolCallId: "b",
    input: bash.input,
    details: undefined,
  };
  assert.equal(
    await sidecar.toolResult({ ...bashResult, toolCallId: "other" }, ctx),
    undefined,
  );
  const patch = await sidecar.toolResult(bashResult, ctx);
  assert.deepEqual(Object.keys(patch ?? {}), ["content"]);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    patch?.content.slice(0, result.content.length),
    result.content,
  );
  assert.match(JSON.stringify(patch?.content.at(-1)), /destructive/);
  assert.equal(await sidecar.toolResult(bashResult, ctx), undefined);
});

test("shutdown cancels in-flight transport and audit failure cannot block a tool", async () => {
  let reached: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const sidecar = createSidecar({
    env: { TYPESAFE_API_KEY: "mock" },
    fetch: async () => {
      reached();
      return new Promise(() => {});
    },
  });
  const waiting = sidecar.toolCall(bash, ctx);
  await started;
  sidecar.reset();
  assert.equal(await waiting, undefined);
  const brokenAudit = createSidecar({
    env: { TYPESAFE_API_KEY: "mock", PI_JEV_CONFIG: '{"mode":"blocking"}' },
    record: () => {
      throw new Error("audit failed");
    },
    fetch: async (_url, init) =>
      Response.json(
        response(JSON.parse(String(init?.body)).questions, {
          destructive: hazard(0.99),
        }),
      ),
  });
  assert.equal(await brokenAudit.toolCall(bash, ctx), undefined);
});

test("invalid choice/score fields anywhere in a batch suppress every verdict", async () => {
  const malformed: AnswerOverrides[] = [
    { destructive: { type: "noul", noul: 1 } },
    { destructive: { choice: "undeclared" } },
    { destructive: { confidence: null } },
    { destructive: { confidence: -0.1 } },
    { destructive: { probabilities: { true: 1 } } },
    { destructive: { probabilities: { true: 2, false: -1 } } },
    { destructive: { probabilities: { true: 0.1, false: 0.1 } } },
    { implementation: { score: 3 } },
    { implementation: { score: 0, probabilities: { "0": 0, "1": 0, "2": 1 } } },
    {
      implementation: { legend: { "0": "wrong", "1": "wrong", "2": "wrong" } },
    },
  ];
  for (const overrides of malformed) {
    const { sidecar } = mocked(overrides);
    await prepare(sidecar);
    assert.equal(await sidecar.toolResult(result, ctx), undefined);
  }
});

test("Pi 0.85.1 loads the declared TypeScript entry through its real extension loader", async () => {
  const loaded = await discoverAndLoadExtensions(
    [resolve("src/extension.ts")],
    root,
    resolve(root, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0]?.handlers.get("tool_call")?.length, 1);
  assert.equal(loaded.extensions[0]?.handlers.get("tool_result")?.length, 1);
});

test("accepts independently rounded live Score fields without weakening malformed-response checks", async () => {
  const questions = Object.fromEntries(
    Object.entries(criticChecks).map(([id, check]) => [id, check.question]),
  );
  assert.doesNotThrow(() =>
    verdicts(
      response(questions, { implementation: { score: 1.99 } }),
      questions,
    ),
  );
  const { sidecar, requests } = mocked({
    implementation: { score: 1.99 },
    style: { score: 1.97, probabilities: { "0": 0.01, "1": 0.01, "2": 0.99 } },
  });
  await prepare(sidecar);
  assert.equal(await sidecar.toolResult(result, ctx), undefined);
  assert.equal(requests.length, 2);
  // A low rounded score must still reach policy evaluation, not be silently skipped.
  const roundedLow = mocked({ implementation: { ...low, score: 0.11 } });
  await prepare(roundedLow.sidecar);
  assert.ok(await roundedLow.sidecar.toolResult(result, ctx));
});

test("null configuration fields disable judging instead of silently selecting defaults", () => {
  for (const config of [
    { mode: null },
    { checks: null },
    { checks: { style: null } },
    { checks: { style: { confidence: null } } },
    { checks: { style: { minScore: null } } },
  ])
    assert.throws(() => readConfig({ PI_JEV_CONFIG: JSON.stringify(config) }));
});

test("new files beneath external directory symlinks report the resolved external target", async () => {
  await symlink(resolve("src"), resolve(root, "external-dir"));
  const { sidecar, requests } = mocked();
  await sidecar.toolCall(
    {
      ...write,
      input: { path: "external-dir/new/sub/file.ts", content: "// new" },
    },
    ctx,
  );
  const state = requests[0]?.state as Record<string, Record<string, unknown>>;
  assert.equal(state.before?.status, "outside repository; not read");
  assert.equal(state.before?.resolvedPath, resolve("src/new/sub/file.ts"));
});

test("reverse-order parallel results retain each tool call's own before/after context", async () => {
  const { sidecar, requests } = mocked();
  const events: WriteToolCallEvent[] = ["one", "two"].map((name) => ({
    type: "tool_call",
    toolName: "write",
    toolCallId: name,
    input: { path: `${name}.ts`, content: `// ${name} after` },
  }));
  for (const event of events)
    await writeFile(
      resolve(root, String(event.input.path)),
      `// ${event.toolCallId} before`,
    );
  await Promise.all(events.map((event) => sidecar.toolCall(event, ctx)));
  for (const event of events)
    await writeFile(
      resolve(root, String(event.input.path)),
      String(event.input.content),
    );
  for (const event of events.toReversed())
    await sidecar.toolResult(
      { ...result, toolCallId: event.toolCallId, input: event.input },
      ctx,
    );
  const states = requests
    .slice(2)
    .map((request) => request.state as Record<string, { text: string }>);
  assert.equal(states[0]?.before?.text, "// two before");
  assert.equal(states[0]?.after?.text, "// two after");
  assert.equal(states[1]?.before?.text, "// one before");
  assert.equal(states[1]?.after?.text, "// one after");
});
