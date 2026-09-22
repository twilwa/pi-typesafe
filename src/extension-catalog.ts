import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { record } from "./config.ts";
import type { WorkerManifest } from "./worker-manifest.ts";

const run = promisify(execFile);
const MAX_CATALOG_BYTES = 1024 * 1024;

export type CatalogRefusalReason =
  | "catalog-invalid"
  | "catalog-entry-missing"
  | "status-proposed"
  | "experimental-opt-in-required"
  | "unsupported-pi-version"
  | "prerequisite-unmet"
  | "artifact-path-missing"
  | "source-mismatch"
  | "hash-mismatch"
  | "entrypoint-unhashed"
  | "entrypoint-missing"
  | "load-failed";

export interface CatalogExtensionDecision {
  id: string;
  status: "implemented" | "experimental" | "proposed" | "unknown";
  outcome: "loaded" | "already-loaded" | "refused";
  reason?: CatalogRefusalReason;
}

export interface CatalogLoadReceipt {
  sha256: string;
  decisions: CatalogExtensionDecision[];
}

interface CatalogHash {
  artifact: string;
  sha256: string;
}

interface CatalogEntry {
  id: string;
  status: "implemented" | "experimental" | "proposed";
  source: {
    repository: string;
    commit: string;
    subpath: string;
    hashes: CatalogHash[];
  };
  compatibility: Array<{ piVersion: string; state: string }>;
  prerequisites: Array<{ id: string; state: string }>;
}

class Refusal extends Error {
  readonly reason: CatalogRefusalReason;

  constructor(reason: CatalogRefusalReason) {
    super(reason);
    this.reason = reason;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function catalogSha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function safeRelativePath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.split(/[\\/]/).includes("..")
  )
    throw new Refusal("catalog-invalid");
  return value;
}

function nonemptyString(value: unknown) {
  if (typeof value !== "string" || !value) throw new Refusal("catalog-invalid");
  return value;
}

function parseCatalog(raw: unknown): CatalogEntry[] {
  if (
    !record(raw) ||
    raw.schema_version !== "extension-catalog/v1" ||
    !Array.isArray(raw.extensions) ||
    !raw.extensions.length
  )
    throw new Refusal("catalog-invalid");
  const ids = new Set<string>();
  return raw.extensions.map((candidate) => {
    if (!record(candidate) || !record(candidate.source))
      throw new Refusal("catalog-invalid");
    const id = nonemptyString(candidate.id);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) || ids.has(id))
      throw new Refusal("catalog-invalid");
    ids.add(id);
    nonemptyString(candidate.display_name);
    const status = candidate.status;
    if (
      status !== "implemented" &&
      status !== "experimental" &&
      status !== "proposed"
    )
      throw new Refusal("catalog-invalid");
    const source = candidate.source;
    const repository = nonemptyString(source.repository);
    const commit = nonemptyString(source.commit);
    const subpath = safeRelativePath(source.subpath);
    if (
      !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(repository) ||
      !/^[0-9a-f]{40}$/.test(commit) ||
      !Array.isArray(source.hashes) ||
      source.hashes.length < 2
    )
      throw new Refusal("catalog-invalid");
    const artifacts = new Set<string>();
    const hashes = source.hashes.map((item) => {
      if (!record(item)) throw new Refusal("catalog-invalid");
      const artifact = safeRelativePath(item.artifact);
      const sha256 = nonemptyString(item.sha256);
      if (artifacts.has(artifact) || !/^[0-9a-f]{64}$/.test(sha256))
        throw new Refusal("catalog-invalid");
      artifacts.add(artifact);
      return { artifact, sha256 };
    });
    if (
      !Array.isArray(candidate.compatibility) ||
      !candidate.compatibility.length
    )
      throw new Refusal("catalog-invalid");
    const versions = new Set<string>();
    const compatibility = candidate.compatibility.map((item) => {
      if (!record(item)) throw new Refusal("catalog-invalid");
      const piVersion = nonemptyString(item.pi_version);
      const state = nonemptyString(item.state);
      if (
        !/^\d+\.\d+\.\d+$/.test(piVersion) ||
        versions.has(piVersion) ||
        !["compatible", "blocked", "incompatible", "unverified"].includes(
          state,
        ) ||
        !Array.isArray(item.evidence) ||
        !item.evidence.length
      )
        throw new Refusal("catalog-invalid");
      versions.add(piVersion);
      for (const evidence of item.evidence) {
        if (
          !record(evidence) ||
          !["repository-file", "firstmate-report"].includes(
            nonemptyString(evidence.kind),
          ) ||
          !/^[0-9a-f]{64}$/.test(nonemptyString(evidence.sha256))
        )
          throw new Refusal("catalog-invalid");
        safeRelativePath(evidence.locator);
        nonemptyString(evidence.revision);
      }
      return { piVersion, state };
    });
    if (!Array.isArray(candidate.prerequisites))
      throw new Refusal("catalog-invalid");
    const prerequisiteIds = new Set<string>();
    const prerequisites = candidate.prerequisites.map((item) => {
      if (!record(item)) throw new Refusal("catalog-invalid");
      const prerequisiteId = nonemptyString(item.id);
      const prerequisiteState = nonemptyString(item.state);
      if (
        !/^[a-z0-9][a-z0-9-]{0,127}$/.test(prerequisiteId) ||
        prerequisiteIds.has(prerequisiteId) ||
        !["satisfied", "open", "blocked"].includes(prerequisiteState)
      )
        throw new Refusal("catalog-invalid");
      prerequisiteIds.add(prerequisiteId);
      nonemptyString(item.description);
      return { id: prerequisiteId, state: prerequisiteState };
    });
    return {
      id,
      status,
      source: { repository, commit, subpath, hashes },
      compatibility,
      prerequisites,
    };
  });
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function sha256File(path: string) {
  const digest = createHash("sha256");
  await new Promise<void>((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", accept);
  });
  return digest.digest("hex");
}

function normalizeRepository(value: string) {
  return value.replace(/\.git$/, "").replace(/\/$/, "");
}

async function verifySource(root: string, entry: CatalogEntry) {
  let top: string;
  let commit: string;
  let remote: string;
  let dirty: string;
  try {
    [top, commit, remote, dirty] = await Promise.all([
      run("git", ["-C", root, "rev-parse", "--show-toplevel"]).then((r) =>
        r.stdout.trim(),
      ),
      run("git", ["-C", root, "rev-parse", "HEAD"]).then((r) =>
        r.stdout.trim(),
      ),
      run("git", ["-C", root, "remote", "get-url", "origin"]).then((r) =>
        r.stdout.trim(),
      ),
      run("git", [
        "-C",
        root,
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]).then((r) => r.stdout.trim()),
    ]);
  } catch {
    throw new Refusal("source-mismatch");
  }
  if (
    (await realpath(top)) !== root ||
    commit !== entry.source.commit ||
    normalizeRepository(remote) !==
      normalizeRepository(entry.source.repository) ||
    dirty
  )
    throw new Refusal("source-mismatch");
}

async function verifyHashes(root: string, entry: CatalogEntry) {
  const verified = new Set<string>();
  for (const expected of entry.source.hashes) {
    const path = resolve(root, expected.artifact);
    let resolved: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("not a regular file");
      resolved = await realpath(path);
    } catch {
      throw new Refusal("hash-mismatch");
    }
    if (
      !inside(root, resolved) ||
      (await sha256File(resolved)) !== expected.sha256
    )
      throw new Refusal("hash-mismatch");
    verified.add(resolved);
  }
  return verified;
}

async function entrypoints(
  root: string,
  entry: CatalogEntry,
  verified: Set<string>,
) {
  const sourcePath = resolve(root, entry.source.subpath);
  const sourceRealPath = await realpath(sourcePath).catch(() => {
    throw new Refusal("entrypoint-missing");
  });
  if (!inside(root, sourceRealPath)) throw new Refusal("entrypoint-missing");
  if ((await stat(sourceRealPath)).isFile()) {
    if (!verified.has(sourceRealPath)) throw new Refusal("entrypoint-unhashed");
    return [sourceRealPath];
  }
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    );
  } catch {
    throw new Refusal("entrypoint-missing");
  }
  const configured =
    record(packageValue) && record(packageValue.pi)
      ? packageValue.pi.extensions
      : undefined;
  if (!Array.isArray(configured)) throw new Refusal("entrypoint-missing");
  const paths: string[] = [];
  for (const item of configured) {
    if (typeof item !== "string") throw new Refusal("entrypoint-missing");
    const path = await realpath(resolve(root, item)).catch(() => {
      throw new Refusal("entrypoint-missing");
    });
    if (inside(sourceRealPath, path)) {
      if (!verified.has(path)) throw new Refusal("entrypoint-unhashed");
      paths.push(path);
    }
  }
  if (!paths.length) throw new Refusal("entrypoint-missing");
  return paths;
}

type Registration = () => void;

const registrationMethods = new Set([
  "on",
  "registerTool",
  "registerCommand",
  "registerShortcut",
  "registerFlag",
  "registerMessageRenderer",
  "registerMarkdownTransformer",
  "registerEntryRenderer",
  "registerProvider",
  "unregisterProvider",
]);

const readMethods = new Set([
  "getSessionName",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getThinkingLevel",
]);

function stagedApi(pi: ExtensionAPI, registrations: Registration[]) {
  const flags = new Map<string, boolean | string | undefined>();
  const events = {
    emit() {
      throw new Error("Event emission is unavailable during staged loading");
    },
    on(channel: string, handler: (data: unknown) => void) {
      let active = true;
      let unsubscribe: (() => void) | undefined;
      registrations.push(() => {
        if (active) unsubscribe = pi.events.on(channel, handler);
      });
      return () => {
        active = false;
        unsubscribe?.();
      };
    },
  };
  return new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "events") return events;
      if (property === "getFlag")
        return (name: string) =>
          flags.has(name) ? flags.get(name) : pi.getFlag(name);
      if (typeof property !== "string") return undefined;
      if (registrationMethods.has(property))
        return (...args: unknown[]) => {
          if (property === "registerFlag") {
            const [name, options] = args as [
              string,
              { type: "boolean" | "string"; default?: boolean | string },
            ];
            if (
              options.default !== undefined &&
              typeof options.default !== options.type
            )
              throw new Error(
                `Invalid default for flag ${JSON.stringify(name)}`,
              );
            flags.set(name, options.default);
          }
          if (
            property === "registerProvider" &&
            typeof args[0] === "string" &&
            !args[1]
          )
            throw new Error("Provider config is required");
          registrations.push(() => {
            Reflect.apply(
              pi[property as keyof ExtensionAPI] as (
                ...items: unknown[]
              ) => unknown,
              pi,
              args,
            );
          });
        };
      if (readMethods.has(property))
        return (...args: unknown[]) =>
          Reflect.apply(
            pi[property as keyof ExtensionAPI] as (
              ...items: unknown[]
            ) => unknown,
            pi,
            args,
          );
      return () => {
        throw new Error(`${property} is unavailable during staged loading`);
      };
    },
  });
}

async function defaultLoad(paths: string[], pi: ExtensionAPI) {
  const factories = await Promise.all(
    paths.map(async (path) => {
      const imported = (await import(pathToFileURL(path).href)) as {
        default?: unknown;
      };
      if (typeof imported.default !== "function")
        throw new Error("Missing extension factory");
      return imported.default as ExtensionFactory;
    }),
  );
  const registrations: Registration[] = [];
  const staged = stagedApi(pi, registrations);
  for (const factory of factories) await factory(staged);
  for (const register of registrations) register();
}

export async function loadCatalogExtensions(options: {
  manifest: WorkerManifest;
  manifestPath: string;
  selected: string[];
  pi: ExtensionAPI;
  loaded: Set<string>;
  load?: (paths: string[], pi: ExtensionAPI) => Promise<void>;
}): Promise<CatalogLoadReceipt | undefined> {
  const configured = options.manifest.extensionCatalog;
  if (!configured) return;
  const manifestDirectory = dirname(options.manifestPath);
  const catalogPath = isAbsolute(configured.path)
    ? configured.path
    : resolve(manifestDirectory, configured.path);
  let raw: unknown;
  let actualSha256 = "";
  let entries: CatalogEntry[];
  try {
    const bytes = await readFile(catalogPath);
    if (bytes.byteLength > MAX_CATALOG_BYTES)
      throw new Refusal("catalog-invalid");
    raw = JSON.parse(bytes.toString("utf8"));
    actualSha256 = catalogSha256(raw);
    if (actualSha256 !== configured.sha256)
      throw new Refusal("catalog-invalid");
    entries = parseCatalog(raw);
  } catch {
    return {
      sha256: actualSha256 || configured.sha256,
      decisions: options.selected.map((id) => ({
        id,
        status: "unknown",
        outcome: "refused",
        reason: "catalog-invalid",
      })),
    };
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const decisions: CatalogExtensionDecision[] = [];
  for (const id of options.selected) {
    const entry = byId.get(id);
    if (!entry) {
      decisions.push({
        id,
        status: "unknown",
        outcome: "refused",
        reason: "catalog-entry-missing",
      });
      continue;
    }
    let reason: CatalogRefusalReason | undefined;
    if (entry.status === "proposed") reason = "status-proposed";
    else if (
      entry.status === "experimental" &&
      !configured.experimentalOptIn.includes(id)
    )
      reason = "experimental-opt-in-required";
    else if (
      !entry.compatibility.some(
        (item) =>
          item.piVersion === options.manifest.runtime.version &&
          item.state === "compatible",
      )
    )
      reason = "unsupported-pi-version";
    else if (entry.prerequisites.some((item) => item.state !== "satisfied"))
      reason = "prerequisite-unmet";
    const configuredRoot = configured.artifacts[id];
    if (!reason && !configuredRoot) reason = "artifact-path-missing";
    if (reason) {
      decisions.push({ id, status: entry.status, outcome: "refused", reason });
      continue;
    }
    if (options.loaded.has(id)) {
      decisions.push({ id, status: entry.status, outcome: "already-loaded" });
      continue;
    }
    try {
      const rootPath = isAbsolute(configuredRoot!)
        ? configuredRoot!
        : resolve(manifestDirectory, configuredRoot!);
      const root = await realpath(rootPath).catch(() => {
        throw new Refusal("artifact-path-missing");
      });
      await verifySource(root, entry);
      const verified = await verifyHashes(root, entry);
      const paths = await entrypoints(root, entry, verified);
      await (options.load ?? defaultLoad)(paths, options.pi);
      options.loaded.add(id);
      decisions.push({ id, status: entry.status, outcome: "loaded" });
    } catch (error) {
      decisions.push({
        id,
        status: entry.status,
        outcome: "refused",
        reason: error instanceof Refusal ? error.reason : "load-failed",
      });
    }
  }
  return { sha256: actualSha256, decisions };
}
