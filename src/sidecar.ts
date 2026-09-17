import { createHash } from "node:crypto";
import { debuglog } from "node:util";
import {
  isToolCallEventType,
  isEditToolResult,
  isWriteToolResult,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry } from "./audit.ts";
import { guardChecks, criticChecks, type CheckId } from "./checks.ts";
import { readConfig } from "./config.ts";
import {
  boundedJson,
  fileContext,
  repository,
  task,
  MAX_INPUT_BYTES,
  type JudgeContext,
} from "./context.ts";
import {
  createTypeSafe,
  type Questions,
  type SystemOneRequest,
  type TypeSafeClientConfig,
} from "./typesafe.ts";
import { verdicts } from "./verdict.ts";

export interface SidecarOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: TypeSafeClientConfig["fetch"];
  debug?: (message: string) => void;
  record?: (entry: AuditEntry) => void;
}

type Snapshot = {
  repository: string;
  task: string;
  before: Awaited<ReturnType<typeof fileContext>>;
  path: string;
  cwd: string;
};

export function createSidecar(options: SidecarOptions = {}) {
  const env = options.env ?? process.env;
  const snapshots = new Map<string, Snapshot>();
  const advisories = new Map<string, string[]>();
  const active = new Set<AbortController>();
  const log = (message: string) => {
    try {
      (options.debug ?? debuglog("pi-jev"))(message);
    } catch {
      /* Logging must also fail open. */
    }
  };
  let config: ReturnType<typeof readConfig> | undefined;
  let client: ReturnType<typeof createTypeSafe> | undefined;
  try {
    config = readConfig(env);
    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (apiKey)
      client = createTypeSafe({
        apiKey,
        baseURL: env.TYPESAFE_BASE_URL,
        defaultModel: config.model,
        fetch: options.fetch,
        timeout: config.timeoutMs,
        retry: { maxRetries: 0 },
        // SDK debug logging includes request bodies. Only our fixed debug messages are safe.
        logLevel: "off",
      });
    else log("Judge disabled: no API key");
  } catch {
    log("Judge disabled: configuration error");
  }

  async function safely<T>(
    ctx: JudgeContext,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (!client || !config || ctx.signal?.aborted) return undefined;
    const controller = new AbortController();
    active.add(controller);
    const started = performance.now();
    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Judge cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), config.timeoutMs);
      });
      const result = await Promise.race([deadline, work(signal)]);
      signal.throwIfAborted();
      if (performance.now() - started >= config.timeoutMs)
        throw new Error("Judge deadline");
      return result;
    } catch {
      log("Judge skipped: error, cancellation, or budget exceeded");
      return undefined;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      controller.abort();
      active.delete(controller);
    }
  }

  function questionsFor(
    definitions: typeof guardChecks | typeof criticChecks,
  ): Questions {
    return Object.fromEntries(
      Object.entries(definitions)
        .filter(([id]) => config?.checks[id as CheckId].enabled)
        .map(([id, check]) => [id, check.question]),
    );
  }

  async function judge(
    state: unknown,
    questions: Questions,
    signal: AbortSignal,
    phase: AuditEntry["phase"],
    toolCallId: string,
  ) {
    const started = performance.now();
    // Round-trip a bounded copy: do not expose Pi's mutable input to SDK middleware.
    const boundedState: SystemOneRequest["state"] = JSON.parse(
      boundedJson(state),
    );
    signal.throwIfAborted();
    const response = await client!
      .systemOne(
        { state: boundedState, questions, model: config!.model },
        {
          signal,
          timeout: config!.timeoutMs,
          retry: { maxRetries: 0 },
        },
      )
      .withResponse();
    signal.throwIfAborted();
    const result = response.data;
    const answers = verdicts(result, questions);
    options.record?.({
      policyVersion: 1,
      phase,
      toolCallId,
      mode: config!.mode,
      model: result.model,
      requestId: response.requestId,
      latencyMs: Math.round(performance.now() - started),
      stateHash: createHash("sha256")
        .update(boundedJson(boundedState))
        .digest("hex"),
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
      },
      answers,
      thresholds: Object.fromEntries(
        Object.keys(questions).map((id) => [id, config!.checks[id as CheckId]]),
      ),
    });
    return answers;
  }

  async function toolCall(
    event: ToolCallEvent,
    ctx: JudgeContext,
  ): Promise<ToolCallEventResult | undefined> {
    return safely(ctx, async (signal) => {
      if (
        !isToolCallEventType("bash", event) &&
        !isToolCallEventType("edit", event) &&
        !isToolCallEventType("write", event)
      )
        return;
      const questions = questionsFor(guardChecks);
      const needsSnapshot =
        event.toolName !== "bash" &&
        Object.keys(questionsFor(criticChecks)).length > 0;
      if (!needsSnapshot && Object.keys(questions).length === 0) return;
      boundedJson(event.input, MAX_INPUT_BYTES);
      const root = await repository(ctx.cwd, signal);
      const statedTask = task(ctx);
      let before: Snapshot["before"] | undefined;
      if (event.toolName !== "bash") {
        before = await fileContext(ctx.cwd, root, event.input.path);
        signal.throwIfAborted();
        if (needsSnapshot) {
          // Bounded memory even if another extension blocks and no result follows.
          if (snapshots.size >= 128)
            snapshots.delete(snapshots.keys().next().value!);
          snapshots.set(event.toolCallId, {
            repository: root,
            task: statedTask,
            before,
            path: event.input.path,
            cwd: ctx.cwd,
          });
        }
      }
      if (Object.keys(questions).length === 0) return;
      const answers = await judge(
        {
          repository: root,
          cwd: ctx.cwd,
          task: statedTask,
          tool: event.toolName,
          input: event.input,
          before,
        },
        questions,
        signal,
        "guard",
        event.toolCallId,
      );
      const hazards = Object.entries(guardChecks).filter(([id]) => {
        const answer = answers[id];
        return (
          answer?.choice === "true" &&
          answer.confidence >= config!.checks[id as CheckId].confidence
        );
      });
      if (hazards.length > 0 && config!.mode === "advisory") {
        if (advisories.size >= 128)
          advisories.delete(advisories.keys().next().value!);
        advisories.set(
          event.toolCallId,
          hazards.map(([id, check]) => `- ${id}: ${check.feedback}`),
        );
      }
      if (hazards.length > 0 && config!.mode === "blocking") {
        snapshots.delete(event.toolCallId);
        return {
          block: true,
          reason: `Jev pre-flight: ${hazards.map(([, check]) => check.feedback).join(" ")}`,
        };
      }
    });
  }

  async function toolResult(
    event: ToolResultEvent,
    ctx: JudgeContext,
  ): Promise<Pick<ToolResultEvent, "content"> | undefined> {
    const snapshot = snapshots.get(event.toolCallId);
    snapshots.delete(event.toolCallId);
    const pending = advisories.get(event.toolCallId) ?? [];
    advisories.delete(event.toolCallId);
    return safely(ctx, async (signal) => {
      const feedback = [...pending];
      const questions = questionsFor(criticChecks);
      if (
        (isEditToolResult(event) || isWriteToolResult(event)) &&
        !event.isError &&
        Object.keys(questions).length > 0 &&
        snapshot &&
        snapshot.path === event.input.path &&
        snapshot.cwd === ctx.cwd
      ) {
        boundedJson(event.input, MAX_INPUT_BYTES);
        const after = await fileContext(
          ctx.cwd,
          snapshot.repository,
          snapshot.path,
        );
        const answers = await judge(
          {
            repository: snapshot.repository,
            cwd: ctx.cwd,
            task: snapshot.task,
            tool: event.toolName,
            input: event.input,
            before: snapshot.before,
            after,
            diff: isEditToolResult(event) ? event.details?.diff : undefined,
          },
          questions,
          signal,
          "critic",
          event.toolCallId,
        );
        for (const [id, check] of Object.entries(criticChecks)) {
          const answer = answers[id];
          const policy = config!.checks[id as CheckId];
          if (
            answer?.score !== undefined &&
            answer.confidence >= policy.confidence &&
            answer.score < policy.minScore!
          )
            feedback.push(
              `- ${id} (${answer.score.toFixed(2)}/2, confidence ${answer.confidence.toFixed(2)}): ${check.feedback}`,
            );
        }
      }
      if (config!.mode === "shadow" || feedback.length === 0) return;
      return {
        content: [
          ...event.content,
          {
            type: "text",
            text: `[Jev critique — advisory; review before the next step]\n${feedback.join("\n")}`,
          },
        ],
      };
    });
  }

  return {
    toolCall,
    toolResult,
    reset: () => {
      for (const controller of active) controller.abort();
      active.clear();
      snapshots.clear();
      advisories.clear();
    },
  };
}
