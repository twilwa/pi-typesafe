import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { debuglog } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { configuredBaseURL, inRange, record } from "./config.ts";
import { repositoryContext, task } from "./context.ts";
import {
  loadCatalogExtensions,
  type CatalogLoadReceipt,
} from "./extension-catalog.ts";
import {
  choice,
  createTypeSafe,
  type Questions,
  type SystemOneRequest,
  type TypeSafeClientConfig,
} from "./typesafe.ts";
import { verdicts } from "./verdict.ts";
import {
  effortLevels,
  parseWorkerManifest,
  WORKER_MANIFEST_ENV,
  type WorkerEffort,
  type WorkerManifest,
  type WorkerSelection,
} from "./worker-manifest.ts";

const CONFIDENCE_FLOOR = 0.8;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 5000;
const axes = [
  "model",
  "effort",
  "skills",
  "extensions",
  "hooks",
  "mcp",
  "retrieval",
  "sandbox",
] as const;
export type SelectionAxis = (typeof axes)[number];

export interface SelectionProposal {
  value: string | string[];
  confidence: number;
}

export interface SelectionProviderResult {
  decisions: Partial<Record<SelectionAxis, SelectionProposal>>;
  metadata: {
    model: string;
    requestId?: string;
    requestSha256?: string;
    usage: { inputTokens: number; outputTokens: number };
  };
}

export interface SelectionProviderInput {
  state: {
    brief: string;
    task: { id: string; lane: string };
    staticProfile: WorkerSelection;
  };
  allowed: {
    models: string[];
    efforts: WorkerEffort[];
    skills: string[];
    extensions: string[];
    hooks: string[];
    mcp: string[];
    retrieval: ["bm25", "none"];
    sandbox: string[];
  };
}

export interface SelectionProvider {
  select(
    input: SelectionProviderInput,
    signal?: AbortSignal,
  ): Promise<SelectionProviderResult>;
}

function criteria(values: readonly string[]) {
  return Object.fromEntries(values.map((value) => [value, null]));
}

/** Production adapter; tests inject their faux provider at the boundary above. */
export function createTypeSafeSelectionProvider(options: {
  apiKey: string;
  baseURL?: string;
  model: string;
  fetch?: TypeSafeClientConfig["fetch"];
}): SelectionProvider {
  const client = createTypeSafe({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultModel: options.model,
    fetch: options.fetch,
    timeout: PROVIDER_TIMEOUT_MS,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  return {
    async select(input, signal) {
      const questions: Questions = {
        model: choice(
          "Which allowed model best fits this task?",
          criteria(input.allowed.models),
        ),
        effort: choice(
          "Which allowed reasoning effort best fits this task?",
          criteria(input.allowed.efforts),
        ),
        retrieval: choice(
          "Does this task need bounded external-evidence retrieval?",
          criteria(input.allowed.retrieval),
        ),
        sandbox: choice(
          "Which allowed sandbox fits the tools this task needs?",
          criteria(input.allowed.sandbox),
        ),
      };
      const collections = ["skills", "extensions", "hooks", "mcp"] as const;
      for (const axis of collections)
        input.allowed[axis].forEach((value, index) => {
          questions[`${axis}_${index}`] = choice(
            `Should the worker enable ${JSON.stringify(value)} for the ${axis} axis on this task?`,
            {
              yes: "Enable this candidate.",
              no: "Do not enable this candidate.",
            },
          );
        });
      const request: SystemOneRequest = {
        state: JSON.parse(JSON.stringify(input.state)),
        questions,
        model: options.model,
      };
      const response = await client
        .systemOne(request, {
          signal,
          timeout: PROVIDER_TIMEOUT_MS,
          retry: { maxRetries: 0 },
        })
        .withResponse();
      const answers = verdicts(response.data, questions);
      const decisions: Partial<Record<SelectionAxis, SelectionProposal>> = {};
      for (const axis of ["model", "effort", "retrieval", "sandbox"] as const) {
        const answer = answers[axis]!;
        decisions[axis] = {
          value: answer.choice!,
          confidence: answer.confidence,
        };
      }
      for (const axis of collections) {
        const values: string[] = [];
        let confidence = 1;
        input.allowed[axis].forEach((value, index) => {
          const answer = answers[`${axis}_${index}`]!;
          confidence = Math.min(confidence, answer.confidence);
          if (answer.choice === "yes") values.push(value);
        });
        decisions[axis] = { value: values, confidence };
      }
      return {
        decisions,
        metadata: {
          model: response.data.model,
          requestId: response.requestId,
          requestSha256: hash(request),
          usage: {
            inputTokens: response.data.usage.input_tokens,
            outputTokens: response.data.usage.output_tokens,
          },
        },
      };
    },
  };
}

type Abstention = { axis: SelectionAxis | "all"; reason: string };
type ReceiptDecision = {
  value: string | string[] | Record<string, unknown>;
  confidence: number | null;
  source: "provider" | "static";
  application: "runtime" | "bounded-decision" | "failed";
};

export interface SelectionReceipt {
  schemaVersion: "pi-typesafe-selection-receipt/v1";
  timestamp: string;
  taskId: string;
  sessionReason: SessionStartEvent["reason"];
  manifestSha256: string;
  decisions: Record<string, ReceiptDecision>;
  abstentions: Abstention[];
  provider: {
    attempted: boolean;
    outcome:
      | "selected"
      | "unavailable"
      | "budget-refused"
      | "budget-exceeded"
      | "failed";
    requestSha256: string;
    latencyMs: number;
    model?: string;
    requestId?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
  extensionCatalog?: CatalogLoadReceipt;
}

export interface StartupSelectorOptions {
  env?: NodeJS.ProcessEnv;
  provider?: SelectionProvider;
  fetch?: TypeSafeClientConfig["fetch"];
  now?: () => Date;
  debug?: (message: string) => void;
  receipt?: (receipt: SelectionReceipt) => void;
  loadExtension?: (paths: string[], pi: ExtensionAPI) => Promise<void>;
}

function defaultProvider(
  env: NodeJS.ProcessEnv,
  fetch?: TypeSafeClientConfig["fetch"],
) {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return;
  return createTypeSafeSelectionProvider({
    apiKey,
    baseURL: configuredBaseURL(env),
    model: env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
    fetch,
  });
}

function providerInput(
  manifest: WorkerManifest,
  brief: string,
): SelectionProviderInput {
  const maxEffortIndex = effortLevels.indexOf(manifest.bounds.effortMax);
  return {
    state: {
      brief,
      task: { id: manifest.identity.taskId, lane: manifest.identity.lane },
      staticProfile: manifest.selection,
    },
    allowed: {
      models: manifest.bounds.modelsAllowed,
      efforts: effortLevels.slice(0, maxEffortIndex + 1),
      skills: manifest.bounds.skillsAllowed,
      extensions: manifest.bounds.extensionsAllowed,
      hooks: manifest.bounds.hooksAllowed,
      mcp: manifest.bounds.mcpAllowed,
      retrieval: ["bm25", "none"],
      sandbox:
        manifest.selection.sandbox.kind === "template"
          ? ["worktree", `template:${manifest.selection.sandbox.template}`]
          : ["worktree"],
    },
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validProviderResult(value: unknown): value is SelectionProviderResult {
  if (!record(value) || !record(value.decisions) || !record(value.metadata))
    return false;
  const metadata = value.metadata;
  if (
    typeof metadata.model !== "string" ||
    !metadata.model ||
    metadata.model.length > 256 ||
    (metadata.requestId !== undefined &&
      (typeof metadata.requestId !== "string" ||
        metadata.requestId.length > 256)) ||
    (metadata.requestSha256 !== undefined &&
      (typeof metadata.requestSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(metadata.requestSha256))) ||
    !record(metadata.usage) ||
    !Number.isSafeInteger(metadata.usage.inputTokens) ||
    (metadata.usage.inputTokens as number) < 0 ||
    !Number.isSafeInteger(metadata.usage.outputTokens) ||
    (metadata.usage.outputTokens as number) < 0
  )
    return false;
  return Object.values(value.decisions).every(
    (decision) =>
      record(decision) &&
      (typeof decision.value === "string" ||
        (Array.isArray(decision.value) &&
          decision.value.every((item) => typeof item === "string"))) &&
      typeof decision.confidence === "number",
  );
}

async function boundedProviderCall(
  provider: SelectionProvider,
  input: SelectionProviderInput,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Selection provider deadline"));
      }, PROVIDER_TIMEOUT_MS);
    });
    return await Promise.race([provider.select(input, signal), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function staticValues(manifest: WorkerManifest) {
  return {
    model: manifest.selection.model,
    effort: manifest.selection.effort,
    skills: manifest.selection.skills,
    extensions: manifest.selection.extensions,
    hooks: manifest.selection.hooks,
    mcp: manifest.selection.mcp,
    retrieval: manifest.selection.retrieval.mode,
    sandbox:
      manifest.selection.sandbox.kind === "template"
        ? `template:${manifest.selection.sandbox.template}`
        : "worktree",
  } satisfies Record<SelectionAxis, string | string[]>;
}

function resolveDecisions(
  manifest: WorkerManifest,
  result: SelectionProviderResult | undefined,
  providerFallback: string | undefined,
) {
  const fallback = staticValues(manifest);
  const allowed = providerInput(manifest, "").allowed;
  const values: Record<SelectionAxis, string | string[]> = { ...fallback };
  const receipts: Record<string, ReceiptDecision> = {};
  const abstentions: Abstention[] = [];
  if (providerFallback)
    abstentions.push({ axis: "all", reason: providerFallback });
  for (const axis of axes) {
    const proposed = result?.decisions[axis];
    let accepted = false;
    let reason: string | undefined;
    if (!providerFallback) {
      if (!proposed) reason = "missing-decision";
      else if (!inRange(proposed.confidence, 0, 1))
        reason = "malformed-confidence";
      else if (proposed.confidence < CONFIDENCE_FLOOR)
        reason = "low-confidence";
      else if (
        axis === "skills" ||
        axis === "extensions" ||
        axis === "hooks" ||
        axis === "mcp"
      ) {
        const candidates = proposed.value;
        if (
          !Array.isArray(candidates) ||
          candidates.some((candidate) => !allowed[axis].includes(candidate))
        )
          reason = "outside-bounds";
        else {
          values[axis] =
            axis === "skills"
              ? [...new Set([...fallback.skills, ...candidates])]
              : candidates;
          accepted = true;
        }
      } else if (
        typeof proposed.value !== "string" ||
        !(
          axis === "model"
            ? allowed.models
            : axis === "effort"
              ? allowed.efforts
              : allowed[axis]
        ).includes(proposed.value as never)
      )
        reason = "outside-bounds";
      else {
        values[axis] = proposed.value;
        accepted = true;
      }
    }
    if (
      axis === "extensions" &&
      manifest.bounds.toolsAllowed.includes("write")
    ) {
      if (
        manifest.bounds.extensionsAllowed.includes("pi-typesafe") &&
        !values.extensions.includes("pi-typesafe")
      )
        values.extensions = [...values.extensions, "pi-typesafe"];
    }
    if (reason) abstentions.push({ axis, reason });
    receipts[axis] = {
      value: values[axis],
      confidence: accepted ? proposed!.confidence : null,
      source: accepted ? "provider" : "static",
      application: "bounded-decision",
    };
  }
  receipts.tools = {
    value: manifest.selection.toolsActive,
    confidence: null,
    source: "static",
    application: "bounded-decision",
  };
  receipts.context = {
    value: manifest.selection.context,
    confidence: null,
    source: "static",
    application: "bounded-decision",
  };
  return { values, receipts, abstentions };
}

function modelReference(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`;
}

async function applyRuntime(
  pi: Pick<ExtensionAPI, "setActiveTools" | "setModel" | "setThinkingLevel">,
  ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
  manifest: WorkerManifest,
  resolved: ReturnType<typeof resolveDecisions>,
) {
  try {
    pi.setActiveTools(manifest.selection.toolsActive);
    resolved.receipts.tools!.application = "runtime";
  } catch {
    resolved.receipts.tools!.application = "failed";
  }

  const available =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((item) => item.model)
      : ctx.modelRegistry.getAvailable();
  let wantedModel = resolved.values.model as string;
  const applyModel = async (reference: string) => {
    const model = available.find((item) => modelReference(item) === reference);
    if (!model) return false;
    try {
      return await pi.setModel(model);
    } catch {
      return false;
    }
  };
  if (!available.some((item) => modelReference(item) === wantedModel)) {
    resolved.abstentions.push({ axis: "model", reason: "model-unavailable" });
    wantedModel = manifest.selection.model;
    resolved.values.model = wantedModel;
    Object.assign(resolved.receipts.model!, {
      value: wantedModel,
      confidence: null,
      source: "static",
    });
  }
  let modelApplied = await applyModel(wantedModel);
  if (!modelApplied && wantedModel !== manifest.selection.model) {
    resolved.abstentions.push({
      axis: "model",
      reason: "model-application-failed",
    });
    wantedModel = manifest.selection.model;
    resolved.values.model = wantedModel;
    Object.assign(resolved.receipts.model!, {
      value: wantedModel,
      confidence: null,
      source: "static",
    });
    modelApplied = await applyModel(wantedModel);
  }
  if (!modelApplied) {
    resolved.abstentions.push({
      axis: "model",
      reason: "static-model-application-failed",
    });
  }
  resolved.receipts.model!.application = modelApplied ? "runtime" : "failed";

  const supportedEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
  const applyEffort = (value: WorkerEffort) => {
    if (!supportedEfforts.includes(value as (typeof supportedEfforts)[number]))
      return false;
    try {
      pi.setThinkingLevel(
        value as Parameters<ExtensionAPI["setThinkingLevel"]>[0],
      );
      return true;
    } catch {
      return false;
    }
  };
  let wantedEffort = resolved.values.effort as WorkerEffort;
  if (
    !supportedEfforts.includes(
      wantedEffort as (typeof supportedEfforts)[number],
    )
  ) {
    resolved.abstentions.push({ axis: "effort", reason: "effort-unavailable" });
    wantedEffort = manifest.selection.effort;
    resolved.values.effort = wantedEffort;
    Object.assign(resolved.receipts.effort!, {
      value: wantedEffort,
      confidence: null,
      source: "static",
    });
  }
  let effortApplied = applyEffort(wantedEffort);
  if (!effortApplied && wantedEffort !== manifest.selection.effort) {
    resolved.abstentions.push({
      axis: "effort",
      reason: "effort-application-failed",
    });
    wantedEffort = manifest.selection.effort;
    resolved.values.effort = wantedEffort;
    Object.assign(resolved.receipts.effort!, {
      value: wantedEffort,
      confidence: null,
      source: "static",
    });
    effortApplied = applyEffort(wantedEffort);
  }
  if (!effortApplied)
    resolved.abstentions.push({
      axis: "effort",
      reason: "static-effort-application-failed",
    });
  resolved.receipts.effort!.application = effortApplied ? "runtime" : "failed";
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errno(error: unknown, code: string) {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

async function ensureDirectoryWithoutSymlinks(root: string, directory: string) {
  const rel = relative(root, directory);
  if (!inside(root, directory))
    throw new Error("Receipt path leaves repository");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!errno(mkdirError, "EEXIST")) throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Receipt parent must be a real directory");
  }
  const resolved = await realpath(current);
  if (!inside(root, resolved))
    throw new Error("Receipt parent leaves repository");
  return resolved;
}

async function prepareReceiptPath(root: string, receiptPath: string) {
  const path = resolve(root, receiptPath);
  if (!inside(root, path)) throw new Error("Receipt path leaves repository");
  const directory = await ensureDirectoryWithoutSymlinks(root, dirname(path));
  const prepared = resolve(directory, basename(path));
  try {
    const info = await lstat(prepared);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Receipt must be a regular file");
    const resolved = await realpath(prepared);
    if (!inside(root, resolved))
      throw new Error("Receipt file leaves repository");
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
  return prepared;
}

async function writeReceipt(path: string, receipt: SelectionReceipt) {
  const handle = await open(
    path,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/** Build the startup hook separately so provider behavior stays injectable and offline-testable. */
export function createStartupSelector(
  pi: ExtensionAPI,
  options: StartupSelectorOptions = {},
) {
  const env = options.env ?? process.env;
  const log = (message: string) => {
    try {
      (options.debug ?? debuglog("pi-selection"))(message);
    } catch {
      /* Diagnostics must not disrupt session startup. */
    }
  };
  let provider = options.provider;
  const providerCalls = new Map<string, number>();
  const loadedExtensions = new Set(["pi-typesafe"]);
  if (!provider)
    try {
      provider = defaultProvider(env, options.fetch);
    } catch {
      log("Selection provider disabled: configuration error");
    }

  return async function sessionStart(
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) {
    const configuredPath = env[WORKER_MANIFEST_ENV]?.trim();
    if (!configuredPath) return;
    try {
      const path = isAbsolute(configuredPath)
        ? configuredPath
        : resolve(ctx.cwd, configuredPath);
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_MANIFEST_BYTES)
        throw new Error("Worker manifest exceeds local budget");
      const manifest = parseWorkerManifest(JSON.parse(bytes.toString("utf8")));
      const discoveryController = new AbortController();
      const repository = await repositoryContext(
        ctx.cwd,
        ctx.signal ?? discoveryController.signal,
      );
      const receiptPath = await prepareReceiptPath(
        repository.root,
        manifest.receipts,
      );
      const input = providerInput(manifest, task(ctx));
      const selectionInputSha256 = hash(input);
      const estimatedTokens = Math.ceil(
        Buffer.byteLength(JSON.stringify(input)) / 4,
      );
      const started = performance.now();
      let result: SelectionProviderResult | undefined;
      let outcome: SelectionReceipt["provider"]["outcome"] = "unavailable";
      let fallback: string | undefined = "provider-unavailable";
      const callsUsed = providerCalls.get(manifest.identity.taskId) ?? 0;
      if (
        provider &&
        callsUsed < manifest.bounds.jev.maxCalls &&
        manifest.bounds.jev.maxTokens > 0 &&
        estimatedTokens <= manifest.bounds.jev.maxTokens &&
        estimatedTokens <= manifest.bounds.jev.stateMaxTokens
      ) {
        providerCalls.set(manifest.identity.taskId, callsUsed + 1);
        try {
          const candidate = await boundedProviderCall(
            provider,
            input,
            ctx.signal,
          );
          if (!validProviderResult(candidate))
            throw new Error("Malformed selection provider result");
          result = candidate;
          const used =
            candidate.metadata.usage.inputTokens +
            candidate.metadata.usage.outputTokens;
          if (used > manifest.bounds.jev.maxTokens) {
            outcome = "budget-exceeded";
            fallback = "budget-exceeded";
          } else {
            outcome = "selected";
            fallback = undefined;
          }
        } catch {
          outcome = "failed";
          fallback = "provider-failure";
        }
      } else if (provider) {
        outcome = "budget-refused";
        fallback =
          callsUsed >= manifest.bounds.jev.maxCalls
            ? "max-calls-exhausted"
            : "budget-refused";
      }
      const resolved = resolveDecisions(manifest, result, fallback);
      await applyRuntime(pi, ctx, manifest, resolved);
      const extensionCatalog = await loadCatalogExtensions({
        manifest,
        manifestPath: path,
        selected: resolved.values.extensions as string[],
        pi,
        loaded: loadedExtensions,
        load: options.loadExtension,
      });
      const receipt: SelectionReceipt = {
        schemaVersion: "pi-typesafe-selection-receipt/v1",
        timestamp: (options.now ?? (() => new Date()))().toISOString(),
        taskId: manifest.identity.taskId,
        sessionReason: event.reason,
        manifestSha256: manifest.sha256,
        decisions: resolved.receipts,
        abstentions: resolved.abstentions,
        provider: {
          attempted:
            outcome === "selected" ||
            outcome === "budget-exceeded" ||
            outcome === "failed",
          outcome,
          requestSha256: result?.metadata.requestSha256 ?? selectionInputSha256,
          latencyMs: Math.round(performance.now() - started),
          ...(result
            ? {
                model: result.metadata.model,
                requestId: result.metadata.requestId,
                usage: result.metadata.usage,
              }
            : {}),
        },
        ...(extensionCatalog ? { extensionCatalog } : {}),
      };
      await writeReceipt(receiptPath, receipt);
      options.receipt?.(receipt);
    } catch {
      log(
        "Selection skipped: invalid manifest, unavailable context, or local error",
      );
    }
  };
}
