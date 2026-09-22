import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createStartupSelector,
  type SelectionProvider,
  type SelectionProviderResult,
  type SelectionReceipt,
} from "../../src/selection.ts";
import {
  manifestSha256,
  parseWorkerManifest,
  WORKER_MANIFEST_ENV,
} from "../../src/worker-manifest.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function manifest(receipts = "state/TES-160/receipts.jsonl") {
  const value = {
    schema_version: "fm-worker-config/v1",
    identity: {
      task_id: "TES-160",
      lane: "pi-typesafe",
      brief_sha256: "b".repeat(64),
    },
    runtime: {
      harness: "pi",
      version: "0.87.0",
      auth_mode: "subscription",
      backend: "tmux",
      permission_mode: "auto",
    },
    bounds: {
      owner: "firstmate",
      models_allowed: ["test/static", "test/selected"],
      effort_max: "high",
      tools_allowed: ["read", "write"],
      mcp_allowed: ["catalog"],
      skills_allowed: ["typesafe-ai", "extra-skill"],
      extensions_allowed: ["pi-typesafe", "extra-extension"],
      hooks_allowed: ["tool_call", "turn_end"],
      max_config_changes: 6,
      max_change_diff_lines: 400,
      jev: { max_calls: 5, max_tokens: 20_000, state_max_tokens: 24_000 },
    },
    selection: {
      owner: "worker",
      model: "test/static",
      effort: "medium",
      skills: ["typesafe-ai"],
      extensions: ["pi-typesafe"],
      hooks: ["tool_call"],
      mcp: [],
      tools_active: ["read", "write"],
      retrieval: { mode: "bm25", max_hits: 8 },
      context: { policy: "cached-prefix", compaction: "native" },
      sandbox: { kind: "worktree", template: null },
    },
    domains: {},
    rollback_target: {
      config_sha256: "1".repeat(64),
      worktree_base_commit: "a".repeat(40),
    },
    receipts,
    provenance: {
      source: "static-dispatch",
      reason_class: "startup",
      jev_request_sha256: null,
      supersedes: null,
    },
    integrity: {
      self_sha256: "0".repeat(64),
      validated_by: "harness_lab/worker_config.py",
    },
  };
  value.integrity.self_sha256 = manifestSha256(value);
  return value;
}

function proposals(
  overrides: Partial<SelectionProviderResult["decisions"]> = {},
): SelectionProviderResult {
  return {
    decisions: {
      model: { value: "test/selected", confidence: 0.95 },
      effort: { value: "high", confidence: 0.95 },
      skills: { value: ["extra-skill"], confidence: 0.95 },
      extensions: { value: [], confidence: 0.95 },
      hooks: { value: ["turn_end"], confidence: 0.95 },
      mcp: { value: ["catalog"], confidence: 0.95 },
      retrieval: { value: "none", confidence: 0.95 },
      sandbox: { value: "worktree", confidence: 0.95 },
      ...overrides,
    },
    metadata: {
      model: "faux-jev",
      requestId: "req-faux-1",
      requestSha256: "f".repeat(64),
      usage: { inputTokens: 120, outputTokens: 20 },
    },
  };
}

async function fixture(
  provider: SelectionProvider,
  manifestValue = manifest(),
) {
  const root = await mkdtemp(resolve(".selection-test-"));
  roots.push(root);
  const path = resolve(root, "worker.json");
  await writeFile(path, JSON.stringify(manifestValue));
  const models = ["static", "selected"].map((id) => ({
    provider: "test",
    id,
  }));
  const selectedModels: string[] = [];
  const efforts: string[] = [];
  const tools: string[][] = [];
  const captured: SelectionReceipt[] = [];
  const pi = {
    setActiveTools(value: string[]) {
      tools.push(value);
    },
    async setModel(value: { provider: string; id: string }) {
      selectedModels.push(`${value.provider}/${value.id}`);
      return true;
    },
    setThinkingLevel(value: string) {
      efforts.push(value);
    },
  } as Pick<ExtensionAPI, "setActiveTools" | "setModel" | "setThinkingLevel">;
  const ctx = {
    cwd: root,
    signal: undefined,
    scopedModels: [],
    modelRegistry: { getAvailable: () => models },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "user", content: "Implement the bounded selector." },
        },
      ],
    },
  } as unknown as ExtensionContext;
  const selector = createStartupSelector(pi, {
    env: { [WORKER_MANIFEST_ENV]: path },
    provider,
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    receipt: (value) => captured.push(value),
  });
  await selector({ type: "session_start", reason: "startup" }, ctx);
  const receiptText = await readFile(
    resolve(root, manifestValue.receipts),
    "utf8",
  );
  return {
    receipt: JSON.parse(receiptText.trim()) as SelectionReceipt,
    captured,
    selectedModels,
    efforts,
    tools,
  };
}

test("startup selection applies allowed model, effort, and static active tools", async () => {
  const seenBriefs: string[] = [];
  const result = await fixture({
    async select(input) {
      seenBriefs.push(input.state.brief);
      return proposals();
    },
  });
  assert.deepEqual(result.selectedModels, ["test/selected"]);
  assert.deepEqual(result.efforts, ["high"]);
  assert.deepEqual(result.tools, [["read", "write"]]);
  assert.deepEqual(result.receipt.decisions.skills!.value, [
    "typesafe-ai",
    "extra-skill",
  ]);
  assert.deepEqual(result.receipt.decisions.extensions!.value, ["pi-typesafe"]);
  assert.deepEqual(seenBriefs, ["Implement the bounded selector."]);
});

test("manifest validation refuses a static selection outside owner bounds", () => {
  const value = manifest();
  value.selection.model = "other/disallowed";
  value.integrity.self_sha256 = manifestSha256(value);
  assert.throws(() => parseWorkerManifest(value), /Static model exceeds/);
});

test("low-confidence decisions abstain to the manifest static profile", async () => {
  const result = await fixture({
    async select() {
      return proposals({ model: { value: "test/selected", confidence: 0.79 } });
    },
  });
  assert.deepEqual(result.selectedModels, ["test/static"]);
  assert.equal(result.receipt.decisions.model!.source, "static");
  assert.equal(result.receipt.decisions.model!.confidence, null);
  assert.ok(
    result.receipt.abstentions.some(
      (item) => item.axis === "model" && item.reason === "low-confidence",
    ),
  );
});

test("provider failure applies the complete static profile and records no error text", async () => {
  const result = await fixture({
    async select() {
      throw new Error("secret provider diagnostic");
    },
  });
  assert.deepEqual(result.selectedModels, ["test/static"]);
  assert.deepEqual(result.efforts, ["medium"]);
  assert.equal(result.receipt.provider.outcome, "failed");
  assert.equal(result.receipt.provider.attempted, true);
  assert.ok(
    result.receipt.abstentions.some(
      (item) => item.axis === "all" && item.reason === "provider-failure",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(result.receipt),
    /secret provider diagnostic/,
  );
});

test("a provider value outside manifest bounds is refused", async () => {
  const result = await fixture({
    async select() {
      return proposals({
        model: { value: "other/disallowed", confidence: 0.99 },
      });
    },
  });
  assert.deepEqual(result.selectedModels, ["test/static"]);
  assert.ok(
    result.receipt.abstentions.some(
      (item) => item.axis === "model" && item.reason === "outside-bounds",
    ),
  );
});

test("receipt exposes decisions and attempt metadata but no state or question text", async () => {
  const result = await fixture({
    async select() {
      return proposals();
    },
  });
  assert.equal(result.captured.length, 1);
  assert.deepEqual(Object.keys(result.receipt).sort(), [
    "abstentions",
    "decisions",
    "manifestSha256",
    "provider",
    "schemaVersion",
    "sessionReason",
    "taskId",
    "timestamp",
  ]);
  assert.match(result.receipt.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.receipt.provider.model, "faux-jev");
  assert.equal(result.receipt.provider.requestId, "req-faux-1");
  assert.equal(result.receipt.provider.requestSha256, "f".repeat(64));
  assert.deepEqual(result.receipt.provider.usage, {
    inputTokens: 120,
    outputTokens: 20,
  });
  const serialized = JSON.stringify(result.receipt);
  assert.doesNotMatch(serialized, /Implement the bounded selector/);
  assert.doesNotMatch(serialized, /question|state/i);
});
