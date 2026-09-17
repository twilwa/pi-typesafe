import type { Mode, CheckConfig } from "./config.ts";
import type { CheckId } from "./checks.ts";
import type { Verdict } from "./verdict.ts";

/** Session metadata only: never source, command, prompt, key, or response bodies. */
export interface AuditEntry {
  policyVersion: 1;
  phase: "guard" | "critic";
  toolCallId: string;
  mode: Mode;
  model: string;
  requestId?: string;
  latencyMs: number;
  stateHash: string;
  usage: { input_tokens: number; output_tokens: number };
  answers: Record<string, Verdict>;
  thresholds: Partial<Record<CheckId, CheckConfig>>;
}
