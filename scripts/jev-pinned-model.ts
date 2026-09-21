/**
 * The Jev model id pinned by `eslint.semantic.config.js`.
 *
 * Read from the config rather than restated, so the benchmark in
 * `scripts/jev-bench.ts` always measures the model the lint actually uses. A
 * benchmark of some other model is not evidence about the configured one.
 */
// The config is plain JS with no declarations; its shape is checked below.
// @ts-expect-error -- untyped ESLint flat config
import semanticConfig from "../eslint.semantic.config.js";

interface MaybeJevEntry {
  settings?: { jev?: { model?: unknown } };
}

export function pinnedModel(): string {
  const entries: MaybeJevEntry[] = Array.isArray(semanticConfig)
    ? (semanticConfig as MaybeJevEntry[])
    : [];
  for (const entry of entries) {
    const model = entry?.settings?.jev?.model;
    if (typeof model === "string" && model) return model;
  }
  throw new Error(
    "eslint.semantic.config.js does not pin settings.jev.model; refusing to " +
      "benchmark an unknown model.",
  );
}
