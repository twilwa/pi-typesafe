import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  prepareLaneCatalog,
  type LaneArm,
} from "../../examples/lanes/prepare-catalog.ts";
import type { CatalogExtensionDecision } from "../../src/extension-catalog.ts";
import { EXTENSION_CATALOG_CONFIG_ENV } from "../../src/extension-catalog.ts";
import piTypeSafe from "../../src/extension.ts";
import { WORKER_MANIFEST_ENV } from "../../src/worker-manifest.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const examplesRoot = resolve(sourceRoot, "examples/lanes");
const packageEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const packageRoot = resolve(packageEntry, "../..");
async function loadPiAi() {
  const candidates = [
    resolve(packageRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    resolve(packageRoot, "../pi-ai/dist/index.js"),
  ];
  const entry = await Promise.any(
    candidates.map(async (candidate) => {
      await readFile(candidate);
      return candidate;
    }),
  );
  return import(pathToFileURL(entry).href) as Promise<{
    fauxAssistantMessage(content: unknown, options?: object): unknown;
    fauxProvider(options?: object): {
      provider: unknown;
      getModel(): unknown;
      setResponses(responses: unknown[]): void;
    };
  }>;
}

const implementedDecisions = [
  {
    id: "pi-typesafe",
    status: "implemented",
    outcome: "already-loaded",
  },
  { id: "lane-core", status: "implemented", outcome: "loaded" },
] satisfies CatalogExtensionDecision[];

test("every lane manifest boots and records catalog decisions", async () => {
  const piAi = await loadPiAi();
  const scenarios = [
    {
      manifest: "static.json",
      optIn: [] as string[],
      expected: implementedDecisions,
    },
    {
      manifest: "adaptive.json",
      optIn: [] as string[],
      expected: [
        ...implementedDecisions,
        {
          id: "sol-pi",
          status: "experimental",
          outcome: "refused",
          reason: "experimental-opt-in-required",
        },
      ] satisfies CatalogExtensionDecision[],
    },
    {
      manifest: "adaptive.json",
      optIn: ["sol-pi"],
      expected: [
        ...implementedDecisions,
        { id: "sol-pi", status: "experimental", outcome: "loaded" },
      ] satisfies CatalogExtensionDecision[],
    },
    {
      manifest: "smaller-model.json",
      optIn: [] as string[],
      expected: implementedDecisions,
    },
  ];

  for (const scenario of scenarios) {
    const root = await mkdtemp(resolve(sourceRoot, ".lane-manifest-"));
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      execFileSync("git", ["init", "-q", root]);
      const manifestPath = resolve(root, scenario.manifest);
      await writeFile(
        manifestPath,
        await readFile(resolve(examplesRoot, scenario.manifest)),
      );
      const arm = scenario.manifest.replace(".json", "") as LaneArm;
      const configPath = await prepareLaneCatalog({
        arm,
        output: root,
        experimentalOptIn: scenario.optIn,
      });
      process.env[WORKER_MANIFEST_ENV] = manifestPath;
      process.env[EXTENSION_CATALOG_CONFIG_ENV] = configPath;

      const faux = piAi.fauxProvider({
        api: "openai-responses",
        provider: "openai-codex",
        models: [
          { id: "gpt-5.6-sol", name: "SoL lane fixture" },
          { id: "gpt-5.6-luna", name: "Luna lane fixture" },
        ],
      });
      faux.setResponses([piAi.fauxAssistantMessage("lane reached idle")]);
      const modelRuntime = await ModelRuntime.create({
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(faux.provider as never);
      await modelRuntime.setRuntimeApiKey("openai-codex", "offline-test-key");
      const modelId =
        scenario.manifest === "smaller-model.json"
          ? "gpt-5.6-luna"
          : "gpt-5.6-sol";
      const model = modelRuntime.getModel("openai-codex", modelId);
      assert.ok(model);

      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir: resolve(root, ".pi-agent"),
        settingsManager,
        extensionFactories: [piTypeSafe],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: root,
        agentDir: resolve(root, ".pi-agent"),
        modelRuntime,
        model: model as never,
        scopedModels: [
          {
            model: modelRuntime.getModel(
              "openai-codex",
              "gpt-5.6-sol",
            )! as never,
          },
          {
            model: modelRuntime.getModel(
              "openai-codex",
              "gpt-5.6-luna",
            )! as never,
          },
        ],
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager,
      });
      session = created.session;
      await session.bindExtensions({ mode: "json" });
      await session.prompt("Reach the idle boundary without calling a tool.");
      await session.waitForIdle();
      assert.equal(session.isIdle, true);

      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        receipts: string;
      };
      const receipt = JSON.parse(
        (await readFile(resolve(root, manifest.receipts), "utf8")).trim(),
      ) as { extensionCatalog: { decisions: CatalogExtensionDecision[] } };
      assert.deepEqual(receipt.extensionCatalog.decisions, scenario.expected);
    } finally {
      session?.dispose();
      delete process.env[WORKER_MANIFEST_ENV];
      delete process.env[EXTENSION_CATALOG_CONFIG_ENV];
      await rm(root, { recursive: true, force: true });
    }
  }
});
