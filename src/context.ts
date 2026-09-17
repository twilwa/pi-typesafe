import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
export const MAX_STATE_BYTES = 48_000;
export const MAX_INPUT_BYTES = 16_000;
const MAX_FILE_BYTES = 12_000;
export type JudgeContext = Pick<
  ExtensionContext,
  "cwd" | "signal" | "sessionManager"
>;

export function boundedJson(value: unknown, max = MAX_STATE_BYTES): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > max)
    throw new Error("Context exceeds local budget");
  return json;
}

export async function repository(
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    maxBuffer: 4096,
  });
  return realpath(result.stdout.trim());
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

/** No recursive scans; only a small regular target file inside the repository. */
export async function fileContext(cwd: string, root: string, path: string) {
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
      // A new file can still escape through an existing parent symlink.
      let ancestor = dirname(absolutePath);
      const suffix = [basename(absolutePath)];
      while (true) {
        try {
          const resolvedPath = resolve(await realpath(ancestor), ...suffix);
          return {
            absolutePath,
            resolvedPath,
            status: inside(root, resolvedPath)
              ? "absent"
              : "outside repository; not read",
            text: null,
          };
        } catch (ancestorError) {
          if (
            (ancestorError as NodeJS.ErrnoException).code !== "ENOENT" ||
            dirname(ancestor) === ancestor
          )
            throw ancestorError;
          suffix.unshift(basename(ancestor));
          ancestor = dirname(ancestor);
        }
      }
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
