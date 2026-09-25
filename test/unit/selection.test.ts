import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

function manifest(receipts = "state/task-1/receipts.jsonl") {
  const value = {
    schema_version: "fm-worker-config/v1",
    identity: {
      task_id: "task-1",
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
  options: {
    cwdRelative?: string;
    starts?: number;
    prepare?: (root: string) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(resolve(".selection-test-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  await options.prepare?.(root);
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
  } as unknown as ExtensionAPI;
  const cwd = options.cwdRelative ? resolve(root, options.cwdRelative) : root;
  if (options.cwdRelative) await mkdir(cwd, { recursive: true });
  const ctx = {
    cwd,
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
  for (let index = 0; index < (options.starts ?? 1); index++)
    await selector({ type: "session_start", reason: "startup" }, ctx);
  const receiptText = await readFile(
    resolve(root, manifestValue.receipts),
    "utf8",
  );
  const receipts = receiptText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SelectionReceipt);
  return {
    receipt: receipts.at(-1)!,
    receipts,
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

test("manifest validation accepts only bounded catalog artifacts and experimental opt-ins", () => {
  const value = manifest();
  Object.assign(value, {
    extension_catalog: {
      path: "catalog.json",
      sha256: "c".repeat(64),
      artifacts: { "extra-extension": "artifacts/extra-extension" },
      experimental_opt_in: ["extra-extension"],
    },
  });
  value.integrity.self_sha256 = manifestSha256(value);
  assert.deepEqual(parseWorkerManifest(value).extensionCatalog, {
    path: "catalog.json",
    sha256: "c".repeat(64),
    artifacts: { "extra-extension": "artifacts/extra-extension" },
    experimentalOptIn: ["extra-extension"],
  });

  const outsideBounds = structuredClone(value) as typeof value & {
    extension_catalog: { experimental_opt_in: string[] };
  };
  outsideBounds.extension_catalog.experimental_opt_in = ["unknown-extension"];
  outsideBounds.integrity.self_sha256 = manifestSha256(outsideBounds);
  assert.throws(
    () => parseWorkerManifest(outsideBounds),
    /catalog configuration exceeds worker bounds/,
  );
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

test("receipt paths resolve from the Git root when Pi starts in a subdirectory", async () => {
  const result = await fixture(
    {
      async select() {
        return proposals();
      },
    },
    manifest(),
    { cwdRelative: "packages/worker" },
  );
  assert.equal(result.receipts.length, 1);
});

test("receipt writing refuses a symlinked parent that leaves the Git root", async () => {
  const outside = await mkdtemp(resolve(".selection-outside-"));
  roots.push(outside);
  await assert.rejects(
    fixture(
      {
        async select() {
          return proposals();
        },
      },
      manifest(),
      {
        prepare: async (root) => {
          await symlink(outside, resolve(root, "state"), "dir");
        },
      },
    ),
  );
  await assert.rejects(access(resolve(outside, "task-1/receipts.jsonl")));
});

test("receipt writing refuses a symlinked receipt file", async () => {
  const outside = await mkdtemp(resolve(".selection-outside-"));
  roots.push(outside);
  const target = resolve(outside, "user-file");
  await writeFile(target, "preserve me\n");
  await assert.rejects(
    fixture(
      {
        async select() {
          return proposals();
        },
      },
      manifest(),
      {
        prepare: async (root) => {
          const directory = resolve(root, "state/task-1");
          await mkdir(directory, { recursive: true });
          await symlink(target, resolve(directory, "receipts.jsonl"));
        },
      },
    ),
  );
  assert.equal(await readFile(target, "utf8"), "preserve me\n");
});

test("max_calls is enforced across repeated session starts", async () => {
  const value = manifest();
  value.bounds.jev.max_calls = 1;
  value.integrity.self_sha256 = manifestSha256(value);
  let attempts = 0;
  const result = await fixture(
    {
      async select() {
        attempts++;
        return proposals();
      },
    },
    value,
    { starts: 2 },
  );
  assert.equal(attempts, 1);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[1]!.provider.outcome, "budget-refused");
});
