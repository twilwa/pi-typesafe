import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { record } from "./config.ts";

export const WORKER_MANIFEST_ENV = "PI_WORKER_MANIFEST";
export const effortLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type WorkerEffort = (typeof effortLevels)[number];

export interface WorkerSelection {
  model: string;
  effort: WorkerEffort;
  skills: string[];
  extensions: string[];
  hooks: string[];
  mcp: string[];
  toolsActive: string[];
  retrieval: { mode: "bm25" | "none"; maxHits: number };
  context: {
    policy: "cached-prefix" | "rebuild";
    compaction: "native" | "plan-boundary";
  };
  sandbox: { kind: "worktree" | "template"; template: string | null };
}

export interface WorkerManifest {
  identity: { taskId: string; lane: string; briefSha256: string };
  bounds: {
    modelsAllowed: string[];
    effortMax: WorkerEffort;
    toolsAllowed: string[];
    mcpAllowed: string[];
    skillsAllowed: string[];
    extensionsAllowed: string[];
    hooksAllowed: string[];
    jev: { maxCalls: number; maxTokens: number; stateMaxTokens: number };
  };
  selection: WorkerSelection;
  receipts: string;
  sha256: string;
}

function field(parent: Record<string, unknown>, name: string) {
  const value = parent[name];
  if (!record(value)) throw new Error(`Invalid worker manifest field: ${name}`);
  return value;
}

function stringField(parent: Record<string, unknown>, name: string) {
  const value = parent[name];
  if (typeof value !== "string" || !value)
    throw new Error(`Invalid worker manifest field: ${name}`);
  return value;
}

function integerField(parent: Record<string, unknown>, name: string) {
  const value = parent[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid worker manifest field: ${name}`);
  return value as number;
}

function stringSet(parent: Record<string, unknown>, name: string) {
  const value = parent[name];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Invalid worker manifest field: ${name}`);
  return value as string[];
}

function effort(value: unknown): WorkerEffort {
  if (!effortLevels.includes(value as WorkerEffort))
    throw new Error("Invalid worker effort");
  return value as WorkerEffort;
}

function subset(selected: string[], allowed: string[], name: string) {
  if (selected.some((value) => !allowed.includes(value)))
    throw new Error(`Worker selection exceeds ${name}`);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/** Match harness-lab's canonical digest, excluding the circular self-hash. */
export function manifestSha256(raw: Record<string, unknown>) {
  const copy = structuredClone(raw);
  if (record(copy.integrity)) delete copy.integrity.self_sha256;
  return createHash("sha256").update(canonical(copy)).digest("hex");
}

/** Validate the closed-schema fields consumed by startup selection. */
export function parseWorkerManifest(raw: unknown): WorkerManifest {
  if (!record(raw) || raw.schema_version !== "fm-worker-config/v1")
    throw new Error("Invalid worker manifest schema");
  const identity = field(raw, "identity");
  const runtime = field(raw, "runtime");
  const bounds = field(raw, "bounds");
  const selected = field(raw, "selection");
  const jev = field(bounds, "jev");
  const retrieval = field(selected, "retrieval");
  const context = field(selected, "context");
  const sandbox = field(selected, "sandbox");
  const integrity = field(raw, "integrity");
  if (
    runtime.harness !== "pi" ||
    bounds.owner !== "firstmate" ||
    selected.owner !== "worker" ||
    integrity.validated_by !== "harness_lab/worker_config.py"
  )
    throw new Error("Invalid worker manifest authority");

  const modelsAllowed = stringSet(bounds, "models_allowed");
  if (modelsAllowed.length === 0)
    throw new Error("Worker manifest needs an allowed model");
  const toolsAllowed = stringSet(bounds, "tools_allowed");
  const mcpAllowed = stringSet(bounds, "mcp_allowed");
  const skillsAllowed = stringSet(bounds, "skills_allowed");
  const extensionsAllowed = stringSet(bounds, "extensions_allowed");
  const hooksAllowed = stringSet(bounds, "hooks_allowed");
  const selectedModel = stringField(selected, "model");
  const selectedEffort = effort(selected.effort);
  const selectedTools = stringSet(selected, "tools_active");
  const selectedMcp = stringSet(selected, "mcp");
  const selectedSkills = stringSet(selected, "skills");
  const selectedExtensions = stringSet(selected, "extensions");
  const selectedHooks = stringSet(selected, "hooks");
  const effortMax = effort(bounds.effort_max);
  if (!modelsAllowed.includes(selectedModel))
    throw new Error("Static model exceeds worker bounds");
  if (effortLevels.indexOf(selectedEffort) > effortLevels.indexOf(effortMax))
    throw new Error("Static effort exceeds worker bounds");
  subset(selectedTools, toolsAllowed, "tool bounds");
  subset(selectedMcp, mcpAllowed, "MCP bounds");
  subset(selectedSkills, skillsAllowed, "skill bounds");
  subset(selectedExtensions, extensionsAllowed, "extension bounds");
  subset(selectedHooks, hooksAllowed, "hook bounds");

  const retrievalMode = retrieval.mode;
  if (retrievalMode !== "bm25" && retrievalMode !== "none")
    throw new Error("Invalid retrieval mode");
  const contextPolicy = context.policy;
  const compaction = context.compaction;
  if (
    (contextPolicy !== "cached-prefix" && contextPolicy !== "rebuild") ||
    (compaction !== "native" && compaction !== "plan-boundary")
  )
    throw new Error("Invalid context policy");
  const sandboxKind = sandbox.kind;
  const sandboxTemplate = sandbox.template;
  if (
    (sandboxKind !== "worktree" && sandboxKind !== "template") ||
    (sandboxTemplate !== null &&
      (typeof sandboxTemplate !== "string" || !sandboxTemplate)) ||
    (sandboxKind === "worktree" && sandboxTemplate !== null) ||
    (sandboxKind === "template" && sandboxTemplate === null)
  )
    throw new Error("Invalid sandbox selection");

  const receipts = stringField(raw, "receipts");
  const receiptPath = posix.normalize(receipts);
  if (
    !/^[A-Za-z0-9._/-]+\.jsonl$/.test(receipts) ||
    isAbsolute(receipts) ||
    receiptPath !== receipts ||
    receipts.startsWith("./") ||
    receiptPath.split("/").includes("..") ||
    !receipts.endsWith(".jsonl")
  )
    throw new Error("Unsafe receipt path");
  const statedSha256 = stringField(integrity, "self_sha256");
  const sha256 = manifestSha256(raw);
  if (!/^[0-9a-f]{64}$/.test(statedSha256) || statedSha256 !== sha256)
    throw new Error("Invalid worker manifest self hash");

  const taskId = stringField(identity, "task_id");
  const lane = stringField(identity, "lane");
  const briefSha256 = stringField(identity, "brief_sha256");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(lane) ||
    !/^[0-9a-f]{64}$/.test(briefSha256)
  )
    throw new Error("Invalid worker identity");

  return {
    identity: { taskId, lane, briefSha256 },
    bounds: {
      modelsAllowed,
      effortMax,
      toolsAllowed,
      mcpAllowed,
      skillsAllowed,
      extensionsAllowed,
      hooksAllowed,
      jev: {
        maxCalls: integerField(jev, "max_calls"),
        maxTokens: integerField(jev, "max_tokens"),
        stateMaxTokens: integerField(jev, "state_max_tokens"),
      },
    },
    selection: {
      model: selectedModel,
      effort: selectedEffort,
      skills: selectedSkills,
      extensions: selectedExtensions,
      hooks: selectedHooks,
      mcp: selectedMcp,
      toolsActive: selectedTools,
      retrieval: {
        mode: retrievalMode,
        maxHits: integerField(retrieval, "max_hits"),
      },
      context: { policy: contextPolicy, compaction },
      sandbox: { kind: sandboxKind, template: sandboxTemplate },
    },
    receipts,
    sha256,
  };
}
