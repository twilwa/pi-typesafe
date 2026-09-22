import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piTypeSafe from "../../src/extension.ts";
import {
  manifestSha256,
  WORKER_MANIFEST_ENV,
} from "../../src/worker-manifest.ts";

const packageEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const packageRoot = resolve(packageEntry, "../..");
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
) as { version: string };

async function loadPiAi() {
  const candidates = [
    resolve(packageRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    resolve(packageRoot, "../pi-ai/dist/index.js"),
  ];
  const entry = await Promise.any(
    candidates.map(async (candidate) => {
      await access(candidate);
      return candidate;
    }),
  );
  return import(pathToFileURL(entry).href) as Promise<{
    fauxAssistantMessage(content: unknown, options?: object): unknown;
    fauxProvider(options?: object): {
      provider: unknown;
      getModel(): unknown;
      setResponses(responses: unknown[]): void;
      state: { callCount: number };
    };
    fauxToolCall(name: string, arguments_: object): unknown;
  }>;
}

async function withinLifecycleDeadline<T>(work: () => Promise<T>) {
  const timeoutMs = 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Pi ${packageJson.version} lifecycle did not settle within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function workerManifest(receipts: string) {
  const value = {
    schema_version: "fm-worker-config/v1",
    identity: {
      task_id: "lifecycle-matrix",
      lane: "pi-typesafe",
      brief_sha256: "b".repeat(64),
    },
    runtime: {
      harness: "pi",
      version: packageJson.version,
      auth_mode: "test",
      backend: "node-test",
      permission_mode: "auto",
    },
    bounds: {
      owner: "firstmate",
      models_allowed: ["lifecycle/lifecycle-1"],
      effort_max: "medium",
      tools_allowed: ["lifecycle_probe"],
      mcp_allowed: [],
      skills_allowed: [],
      extensions_allowed: ["pi-typesafe"],
      hooks_allowed: ["tool_call", "tool_result", "session_start"],
      max_config_changes: 0,
      max_change_diff_lines: 0,
      jev: { max_calls: 0, max_tokens: 0, state_max_tokens: 0 },
    },
    selection: {
      owner: "worker",
      model: "lifecycle/lifecycle-1",
      effort: "medium",
      skills: [],
      extensions: ["pi-typesafe"],
      hooks: ["tool_call", "tool_result", "session_start"],
      mcp: [],
      tools_active: ["lifecycle_probe"],
      retrieval: { mode: "none", max_hits: 0 },
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
      source: "lifecycle-test",
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

test("real AgentSession completes pi-typesafe hooks and returns idle", async () => {
  assert.match(packageJson.version, /^(0\.85\.1|0\.87\.0)$/);
  const sourceRoot = resolve(
    dirname(new URL(import.meta.url).pathname),
    "../..",
  );
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const scratch = await mkdtemp(resolve(root, ".pi-lifecycle-"));
  const manifestPath = resolve(scratch, "worker.json");
  const receiptsPath = resolve(scratch, "receipts.jsonl");
  const previousManifest = process.env[WORKER_MANIFEST_ENV];
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await writeFile(
      manifestPath,
      JSON.stringify(workerManifest(relative(root, receiptsPath))),
    );
    process.env[WORKER_MANIFEST_ENV] = manifestPath;

    const piAi = await loadPiAi();
    const faux = piAi.fauxProvider({
      api: "lifecycle",
      provider: "lifecycle",
      models: [{ id: "lifecycle-1", name: "Lifecycle test model" }],
    });
    faux.setResponses([
      piAi.fauxAssistantMessage(piAi.fauxToolCall("lifecycle_probe", {}), {
        stopReason: "toolUse",
      }),
      piAi.fauxAssistantMessage("initial turn complete"),
      piAi.fauxAssistantMessage("deferred continuation complete"),
    ]);

    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider as never);
    await modelRuntime.setRuntimeApiKey("lifecycle", "offline-test-key");
    const model = modelRuntime.getModel("lifecycle", "lifecycle-1");
    assert.ok(model);

    let toolExecutions = 0;
    const probeTool = {
      name: "lifecycle_probe",
      label: "Lifecycle probe",
      description: "Exercise pi-typesafe's tool call and tool result hooks.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "probe complete" }] };
      },
    } as unknown as ToolDefinition;

    const settledIdleStates: boolean[] = [];
    let continuationSent = false;
    const lifecycleObserver = (pi: ExtensionAPI) => {
      pi.on("agent_settled", async (_event, ctx) => {
        if (continuationSent) return;
        continuationSent = true;
        pi.sendMessage(
          {
            customType: "lifecycle-continuation",
            content: "Continue once after the first settled boundary.",
            display: false,
          },
          { triggerTurn: true },
        );
        settledIdleStates.push(ctx.isIdle());
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      });
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: scratch,
      settingsManager,
      extensionFactories: [piTypeSafe, lifecycleObserver],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: root,
      agentDir: scratch,
      modelRuntime,
      model: model as never,
      scopedModels: [{ model: model as never }],
      customTools: [probeTool],
      tools: [probeTool.name],
      resourceLoader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager,
    });
    session = created.session;
    await session.bindExtensions({ mode: "json" });

    const receipt = JSON.parse(
      (await readFile(receiptsPath, "utf8")).trim(),
    ) as {
      provider: { outcome: string };
      decisions: { model: { application: string } };
    };
    assert.equal(receipt.provider.outcome, "unavailable");
    assert.equal(receipt.decisions.model.application, "runtime");
    assert.deepEqual(session.getActiveToolNames(), [probeTool.name]);

    await withinLifecycleDeadline(async () => {
      await session!.prompt("Exercise the lifecycle hooks.");
      await session!.waitForIdle();
    });

    assert.equal(toolExecutions, 1);
    assert.equal(faux.state.callCount, 3);
    assert.equal(continuationSent, true);
    assert.equal(session.isIdle, true);
    assert.deepEqual(
      settledIdleStates,
      [packageJson.version === "0.87.0"],
      "0.85.1 starts the continuation during agent_settled; 0.87.0 defers it",
    );
  } finally {
    session?.dispose();
    if (previousManifest === undefined) delete process.env[WORKER_MANIFEST_ENV];
    else process.env[WORKER_MANIFEST_ENV] = previousManifest;
    await rm(scratch, { recursive: true, force: true });
  }
});
