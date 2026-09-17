import { checks, type CheckId } from "./checks.ts";

export interface CheckConfig {
  enabled: boolean;
  confidence: number;
  minScore?: number;
}
export type Mode = "shadow" | "advisory" | "blocking";

export interface SidecarConfig {
  mode: Mode;
  model: string;
  timeoutMs: number;
  checks: Record<CheckId, CheckConfig>;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function inRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Invalid configuration disables judging, rather than guessing at a policy. */
export function readConfig(env: NodeJS.ProcessEnv): SidecarConfig {
  const raw: unknown = JSON.parse(env.PI_JEV_CONFIG || "{}");
  if (
    !record(raw) ||
    Object.keys(raw).some(
      (key) => !["mode", "model", "timeoutMs", "checks"].includes(key),
    )
  )
    throw new Error("Invalid sidecar configuration");
  const mode = raw.mode === undefined ? "advisory" : raw.mode;
  if (mode !== "shadow" && mode !== "advisory" && mode !== "blocking")
    throw new Error("Invalid mode");
  const model =
    raw.model === undefined
      ? (env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest")
      : raw.model;
  const timeoutMs = raw.timeoutMs === undefined ? 750 : raw.timeoutMs;
  if (
    typeof model !== "string" ||
    !model.trim() ||
    !inRange(timeoutMs, 1, 5000)
  )
    throw new Error("Invalid model or timeout");
  const overrides = raw.checks === undefined ? {} : raw.checks;
  if (
    !record(overrides) ||
    Object.keys(overrides).some((id) => !Object.hasOwn(checks, id))
  )
    throw new Error("Unknown check");
  const configured = Object.fromEntries(
    Object.entries(checks).map(([id, defaults]) => {
      const override = overrides[id] === undefined ? {} : overrides[id];
      if (
        !record(override) ||
        Object.keys(override).some(
          (key) =>
            ![
              "enabled",
              "confidence",
              ...("minScore" in defaults ? ["minScore"] : []),
            ].includes(key),
        )
      )
        throw new Error("Invalid check configuration");
      const enabled = override.enabled === undefined ? true : override.enabled;
      const confidence =
        override.confidence === undefined
          ? defaults.confidence
          : override.confidence;
      const minScore =
        "minScore" in defaults
          ? override.minScore === undefined
            ? defaults.minScore
            : override.minScore
          : undefined;
      if (
        typeof enabled !== "boolean" ||
        !inRange(confidence, 0, 1) ||
        (minScore !== undefined && !inRange(minScore, 0, 2))
      )
        throw new Error("Invalid threshold");
      return [
        id,
        {
          enabled,
          confidence,
          ...(minScore === undefined ? {} : { minScore }),
        },
      ];
    }),
  ) as Record<CheckId, CheckConfig>;
  return { mode, model, timeoutMs, checks: configured };
}
