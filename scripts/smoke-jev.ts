import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AuditEntry } from "../src/audit.ts";
import { createSidecar } from "../src/sidecar.ts";

if (!process.env.TYPESAFE_API_KEY?.trim())
  throw new Error("Set TYPESAFE_API_KEY for the optional live smoke test.");
const cwd = await mkdtemp(resolve(".jev-smoke-"));
const audits: AuditEntry[] = [];
const timings: { phase: string; ms: number }[] = [];
const skipped: string[] = [];
const sidecar = createSidecar({
  env: { ...process.env, PI_JEV_CONFIG: '{"mode":"shadow"}' },
  record: (entry) => audits.push(entry),
  debug: (message) => skipped.push(message),
});
try {
  execFileSync("git", ["init", "-q", cwd]);
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({
    role: "user",
    content: "Implement answer() to return 42.",
    timestamp: Date.now(),
  });
  const ctx = { cwd, sessionManager, signal: undefined };
  for (let i = 0; i < 3; i++) {
    await writeFile(
      resolve(cwd, "answer.ts"),
      "export function answer() { return 0; }\n",
    );
    const input = {
      path: "answer.ts",
      content: "export function answer() { return 42; }\n",
    };
    const toolCallId = `smoke-${i}`;
    let started = performance.now();
    assert.equal(
      await sidecar.toolCall(
        { type: "tool_call", toolName: "write", toolCallId, input },
        ctx,
      ),
      undefined,
    );
    timings.push({
      phase: "guard",
      ms: Math.round(performance.now() - started),
    });
    await writeFile(resolve(cwd, "answer.ts"), input.content);
    started = performance.now();
    assert.equal(
      await sidecar.toolResult(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId,
          input,
          content: [{ type: "text", text: "Successfully wrote answer.ts" }],
          details: undefined,
          isError: false,
        },
        ctx,
      ),
      undefined,
    );
    timings.push({
      phase: "critic",
      ms: Math.round(performance.now() - started),
    });
  }
  // Print metadata only. The fixture is synthetic and contains no project source.
  console.log(
    JSON.stringify(
      {
        timings,
        skipped,
        assessments: audits.map(
          ({ phase, model, latencyMs, usage, answers }) => ({
            phase,
            model,
            latencyMs,
            usage,
            answers,
          }),
        ),
      },
      null,
      2,
    ),
  );
  assert.equal(
    audits.length,
    6,
    "All six real batches must validate within the default budget",
  );
} finally {
  sidecar.reset();
  await rm(cwd, { recursive: true, force: true });
}
