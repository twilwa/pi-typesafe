import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCatalogExtensions } from "../../src/extension-catalog.ts";
import type { WorkerManifest } from "../../src/worker-manifest.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function hash(value: string | object) {
  const body = typeof value === "string" ? value : canonical(value);
  return createHash("sha256").update(body).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(resolve(".catalog-test-"));
  roots.push(root);
  const artifact = resolve(root, "artifact");
  await mkdir(artifact);
  const files = {
    "implemented.mjs": "export default function implemented() {}\n",
    "experimental.mjs": "export default function experimental() {}\n",
    "proposed.mjs": "export default function proposed() {}\n",
    "multi-one.mjs":
      "export default function multiOne(pi) { pi.on('turn_start', () => {}); }\n",
    "multi-two.mjs":
      "export default function multiTwo(pi) { pi.on('turn_end', () => {}); throw new Error('later factory failure'); }\n",
    "package.json": JSON.stringify({
      type: "module",
      pi: { extensions: ["./multi-one.mjs", "./multi-two.mjs"] },
    }),
    "README.md": "fixture stand-in; not SoL-Pi\n",
    LICENSE: "fixture license\n",
  };
  await Promise.all(
    Object.entries(files).map(([path, body]) =>
      writeFile(resolve(artifact, path), body),
    ),
  );
  execFileSync("git", ["init", "-q", artifact]);
  execFileSync("git", ["-C", artifact, "config", "user.name", "Catalog Test"]);
  execFileSync("git", [
    "-C",
    artifact,
    "config",
    "user.email",
    "catalog@example.invalid",
  ]);
  execFileSync("git", [
    "-C",
    artifact,
    "remote",
    "add",
    "origin",
    "https://github.com/example/fixture.git",
  ]);
  execFileSync("git", ["-C", artifact, "add", "."]);
  execFileSync("git", ["-C", artifact, "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", artifact, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const entry = (
    id: string,
    status: "implemented" | "experimental" | "proposed",
    subpath: string,
    versions: string[],
  ) => ({
    id,
    display_name: id,
    status,
    source: {
      repository: "https://github.com/example/fixture.git",
      commit,
      subpath,
      hashes: [
        {
          artifact: subpath,
          sha256: hash(files[subpath as keyof typeof files]),
        },
        { artifact: "README.md", sha256: hash(files["README.md"]) },
      ],
    },
    compatibility: versions.map((version) => ({
      pi_version: version,
      state: "compatible",
      note: "fixture evidence",
      evidence: [
        {
          kind: "repository-file",
          locator: "README.md",
          revision: commit,
          sha256: hash(files["README.md"]),
        },
      ],
    })),
    prerequisites: [] as Array<{
      id: string;
      description: string;
      state: string;
    }>,
  });
  const catalog = {
    schema_version: "extension-catalog/v1",
    extensions: [
      entry("implemented-fixture", "implemented", "implemented.mjs", [
        "0.85.1",
        "0.87.0",
      ]),
      entry("sol-pi-shaped-fixture", "experimental", "experimental.mjs", [
        "0.85.1",
      ]),
      entry("proposed-fixture", "proposed", "proposed.mjs", [
        "0.85.1",
        "0.87.0",
      ]),
    ],
  };
  const catalogPath = resolve(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  return { root, artifact, catalog, catalogPath };
}

function manifest(catalog: object, version = "0.85.1"): WorkerManifest {
  const ids = [
    "implemented-fixture",
    "sol-pi-shaped-fixture",
    "proposed-fixture",
  ];
  return {
    identity: {
      taskId: "catalog-test",
      lane: "pi-typesafe",
      briefSha256: "b".repeat(64),
    },
    runtime: { version },
    bounds: {
      modelsAllowed: ["test/model"],
      effortMax: "medium",
      toolsAllowed: [],
      mcpAllowed: [],
      skillsAllowed: [],
      extensionsAllowed: ids,
      hooksAllowed: [],
      jev: { maxCalls: 0, maxTokens: 0, stateMaxTokens: 0 },
    },
    selection: {
      model: "test/model",
      effort: "medium",
      skills: [],
      extensions: ids,
      hooks: [],
      mcp: [],
      toolsActive: [],
      retrieval: { mode: "none", maxHits: 0 },
      context: { policy: "cached-prefix", compaction: "native" },
      sandbox: { kind: "worktree", template: null },
    },
    extensionCatalog: {
      path: "catalog.json",
      sha256: hash(catalog),
      artifacts: Object.fromEntries(ids.map((id) => [id, "artifact"])),
      experimentalOptIn: ["sol-pi-shaped-fixture"],
    },
    receipts: "receipts.jsonl",
    sha256: "a".repeat(64),
  };
}

async function load(
  configured: WorkerManifest,
  root: string,
  selected = configured.selection.extensions,
) {
  const loadedPaths: string[] = [];
  const receipt = await loadCatalogExtensions({
    manifest: configured,
    manifestPath: resolve(root, "worker.json"),
    selected,
    pi: {} as ExtensionAPI,
    loaded: new Set(),
    load: async (paths) => {
      loadedPaths.push(...paths);
    },
  });
  return { receipt: receipt!, loadedPaths };
}

test("catalog loads eligible implemented and opted-in experimental entries and records every decision", async () => {
  const value = await fixture();
  const result = await load(manifest(value.catalog), value.root);
  assert.deepEqual(
    result.receipt.decisions.map(({ id, outcome, reason }) => ({
      id,
      outcome,
      reason,
    })),
    [
      { id: "implemented-fixture", outcome: "loaded", reason: undefined },
      { id: "sol-pi-shaped-fixture", outcome: "loaded", reason: undefined },
      { id: "proposed-fixture", outcome: "refused", reason: "status-proposed" },
    ],
  );
  assert.deepEqual(
    result.loadedPaths.map((path) => path.split("/").at(-1)),
    ["implemented.mjs", "experimental.mjs"],
  );
});

test("catalog refuses an experimental entry without explicit opt-in", async () => {
  const value = await fixture();
  const configured = manifest(value.catalog);
  configured.extensionCatalog!.experimentalOptIn = [];
  const result = await load(configured, value.root, ["sol-pi-shaped-fixture"]);
  assert.equal(
    result.receipt.decisions[0]!.reason,
    "experimental-opt-in-required",
  );
  assert.deepEqual(result.loadedPaths, []);
});

test("catalog refuses the 0.85.1-only experimental entry on Pi 0.87.0", async () => {
  const value = await fixture();
  const configured = manifest(value.catalog, "0.87.0");
  const result = await load(configured, value.root, ["sol-pi-shaped-fixture"]);
  assert.equal(result.receipt.decisions[0]!.reason, "unsupported-pi-version");
});

test("catalog refuses a pinned artifact hash mismatch", async () => {
  const value = await fixture();
  const catalog = structuredClone(value.catalog);
  catalog.extensions[0]!.source.hashes[0]!.sha256 = "0".repeat(64);
  await writeFile(value.catalogPath, JSON.stringify(catalog));
  const result = await load(manifest(catalog), value.root, [
    "implemented-fixture",
  ]);
  assert.equal(result.receipt.decisions[0]!.reason, "hash-mismatch");
  assert.deepEqual(result.loadedPaths, []);
});

test("catalog refuses a source entry point omitted from the pinned hashes", async () => {
  const value = await fixture();
  const catalog = structuredClone(value.catalog);
  catalog.extensions[0]!.source.hashes = [
    {
      artifact: "README.md",
      sha256: hash("fixture stand-in; not SoL-Pi\n"),
    },
    { artifact: "LICENSE", sha256: hash("fixture license\n") },
  ];
  await writeFile(value.catalogPath, JSON.stringify(catalog));
  const result = await load(manifest(catalog), value.root, [
    "implemented-fixture",
  ]);
  assert.equal(result.receipt.decisions[0]!.reason, "entrypoint-unhashed");
  assert.deepEqual(result.loadedPaths, []);
});

test("catalog refuses a package when any imported entry point is unhashed", async () => {
  const value = await fixture();
  const catalog = structuredClone(value.catalog);
  catalog.extensions[0]!.source.subpath = ".";
  catalog.extensions[0]!.source.hashes = [
    {
      artifact: "multi-one.mjs",
      sha256: hash(
        "export default function multiOne(pi) { pi.on('turn_start', () => {}); }\n",
      ),
    },
    {
      artifact: "package.json",
      sha256: hash(
        JSON.stringify({
          type: "module",
          pi: { extensions: ["./multi-one.mjs", "./multi-two.mjs"] },
        }),
      ),
    },
  ];
  await writeFile(value.catalogPath, JSON.stringify(catalog));
  const result = await load(manifest(catalog), value.root, [
    "implemented-fixture",
  ]);
  assert.equal(result.receipt.decisions[0]!.reason, "entrypoint-unhashed");
  assert.deepEqual(result.loadedPaths, []);
});

test("a later factory failure commits none of a multi-entry extension's handlers", async () => {
  const value = await fixture();
  const catalog = structuredClone(value.catalog);
  catalog.extensions[0]!.source.subpath = ".";
  catalog.extensions[0]!.source.hashes = [
    {
      artifact: "multi-one.mjs",
      sha256: hash(
        "export default function multiOne(pi) { pi.on('turn_start', () => {}); }\n",
      ),
    },
    {
      artifact: "multi-two.mjs",
      sha256: hash(
        "export default function multiTwo(pi) { pi.on('turn_end', () => {}); throw new Error('later factory failure'); }\n",
      ),
    },
    {
      artifact: "package.json",
      sha256: hash(
        JSON.stringify({
          type: "module",
          pi: { extensions: ["./multi-one.mjs", "./multi-two.mjs"] },
        }),
      ),
    },
  ];
  await writeFile(value.catalogPath, JSON.stringify(catalog));
  const registeredEvents: string[] = [];
  const configured = manifest(catalog);
  const receipt = await loadCatalogExtensions({
    manifest: configured,
    manifestPath: resolve(value.root, "worker.json"),
    selected: ["implemented-fixture"],
    pi: {
      on(event: string) {
        registeredEvents.push(event);
      },
      events: { emit() {}, on: () => () => {} },
    } as unknown as ExtensionAPI,
    loaded: new Set(),
  });
  assert.equal(receipt!.decisions[0]!.reason, "load-failed");
  assert.deepEqual(registeredEvents, []);
});

test("catalog refuses entries with unmet prerequisites", async () => {
  const value = await fixture();
  const catalog = structuredClone(value.catalog);
  catalog.extensions[0]!.prerequisites = [
    {
      id: "local-evaluation",
      description: "Run a local evaluation",
      state: "open",
    },
  ];
  await writeFile(value.catalogPath, JSON.stringify(catalog));
  const result = await load(manifest(catalog), value.root, [
    "implemented-fixture",
  ]);
  assert.equal(result.receipt.decisions[0]!.reason, "prerequisite-unmet");
});
