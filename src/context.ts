import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_STATE_BYTES = 48_000;
export const MAX_INPUT_BYTES = 16_000;
const MAX_FILE_BYTES = 12_000;
const MAX_GIT_OUTPUT_BYTES = 4096;
const GIT_TERMINATION_GRACE_MS = 40;
export type JudgeContext = Pick<
  ExtensionContext,
  "cwd" | "signal" | "sessionManager"
>;

export interface RepositoryContext {
  root: string;
  metadataPaths: string[];
}

export function boundedJson(value: unknown, max = MAX_STATE_BYTES): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > max)
    throw new Error("Context exceeds local budget");
  return json;
}

function runGitDiscovery(cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let terminating = false;

    const terminate = () => {
      if (terminating || child.exitCode !== null || child.signalCode !== null)
        return;
      terminating = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* The close/error path below remains authoritative. */
      }
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Uninterruptible kernel I/O cannot be force-reaped here. */
          }
        }
      }, GIT_TERMINATION_GRACE_MS);
    };
    const onAbort = () => terminate();

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        failure = new Error("Git discovery output exceeds local budget");
        terminate();
      } else stdout.push(chunk);
    });
    // Drain stderr without retaining repository-specific diagnostics.
    child.stderr.resume();
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(escalation);
      signal.removeEventListener("abort", onAbort);
      // Waiting for close is the post-cancellation exit/reaping check.
      if (signal.aborted)
        reject(new DOMException("Git discovery cancelled", "AbortError"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Git repository discovery failed"));
      else resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
    if (signal.aborted) onAbort();
  });
}

async function canonicalOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function repositoryContext(
  cwd: string,
  signal: AbortSignal,
): Promise<RepositoryContext> {
  const lines = (await runGitDiscovery(cwd, signal)).trim().split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => !line))
    throw new Error("Unexpected Git repository discovery result");
  const root = await realpath(lines[0]!);
  const marker = resolve(root, ".git");
  const metadataPaths = await Promise.all([
    canonicalOrSelf(marker),
    canonicalOrSelf(lines[1]!),
    canonicalOrSelf(lines[2]!),
  ]);
  signal.throwIfAborted();
  return { root, metadataPaths: [...new Set([marker, ...metadataPaths])] };
}

/** Backward-compatible root-only discovery for direct callers. */
export async function repository(
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return (await repositoryContext(cwd, signal)).root;
}

export function task(ctx: JudgeContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (Buffer.byteLength(text) > 8000)
      throw new Error("Task exceeds local budget");
    return text;
  }
  return "No user task available; do not infer an unstated task.";
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function insideOrEqual(root: string, path: string): boolean {
  return path === root || inside(root, path);
}

function isRepositoryMetadata(path: string, metadataPaths: readonly string[]) {
  return metadataPaths.some((metadata) => insideOrEqual(metadata, path));
}

/** Resolve symlinks even when their final target does not yet exist. */
async function resolveMissingPath(absolutePath: string): Promise<string> {
  let current = parse(absolutePath).root;
  let pending = absolutePath.slice(current.length).split(sep);
  let steps = 0;
  while (pending.length > 0) {
    // Local work budget, not a claim about platform symlink limits.
    if (++steps > 256) throw new Error("Path resolution exceeds local budget");
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, part);
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = candidate;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(candidate);
      const targetRoot = parse(target).root;
      if (targetRoot) current = targetRoot;
      // Relative targets start at the link's actual parent. Resolve target
      // components before later '..' components, as the filesystem does.
      pending = [...target.slice(targetRoot.length).split(sep), ...pending];
    } else {
      current = candidate;
    }
  }
  return current;
}

/** No recursive scans; only a small regular target file inside the repository. */
export async function fileContext(
  cwd: string,
  root: string,
  path: string,
  metadataPaths: readonly string[] = [],
) {
  let normalized = path
    .replace(/^@/, "")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized === "~" || normalized.startsWith("~/"))
    normalized = homedir() + normalized.slice(1);
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  const absolutePath = resolve(cwd, normalized);
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const resolvedPath = await resolveMissingPath(absolutePath);
      return {
        absolutePath,
        resolvedPath,
        status: isRepositoryMetadata(resolvedPath, metadataPaths)
          ? "repository metadata; not read"
          : inside(root, resolvedPath)
            ? "absent"
            : "outside repository; not read",
        text: null,
      };
    }
    throw error;
  }
  if (!inside(root, resolvedPath))
    return {
      absolutePath,
      resolvedPath,
      status: "outside repository; not read",
      text: null,
    };
  if (isRepositoryMetadata(resolvedPath, metadataPaths))
    return {
      absolutePath,
      resolvedPath,
      status: "repository metadata; not read",
      text: null,
    };
  const file = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("File exceeds local budget or is not regular");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES || buffer.subarray(0, bytesRead).includes(0))
      throw new Error("Oversized or binary file");
    return {
      absolutePath,
      resolvedPath,
      status: "present",
      text: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await file.close();
  }
}
