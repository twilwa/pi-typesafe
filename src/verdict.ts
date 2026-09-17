import { inRange, record } from "./config.ts";
import type { Questions } from "./typesafe.ts";

export interface Verdict {
  confidence: number;
  probabilities: Record<string, number>;
  choice?: string;
  score?: number;
}

/** The SDK's types are compile-time only. Validate the entire batch before acting. */
export function verdicts(
  response: unknown,
  questions: Questions,
): Record<string, Verdict> {
  if (
    !record(response) ||
    typeof response.model !== "string" ||
    !response.model.trim() ||
    !record(response.answers) ||
    !record(response.usage) ||
    !inRange(response.usage.input_tokens, 0, Number.MAX_SAFE_INTEGER) ||
    !inRange(response.usage.output_tokens, 0, Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Malformed response");
  const result: Record<string, Verdict> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (
      !record(answer) ||
      answer.type !== question.type ||
      !inRange(answer.confidence, 0, 1) ||
      !record(answer.probabilities)
    )
      throw new Error("Malformed answer");
    const keys =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.type === "score"
          ? question.criteria.map((_, i) => String(i))
          : [];
    const probabilities = answer.probabilities;
    if (
      keys.length === 0 ||
      Object.keys(probabilities).length !== keys.length ||
      keys.some((key) => !inRange(probabilities[key], 0, 1))
    )
      throw new Error("Malformed probabilities");
    const values = keys.map((key) => probabilities[key] as number);
    // Live jev-1.13.0 rounds each probability and score independently to
    // two decimals. Account for that rounding, not arbitrary inconsistency.
    const rounding = 0.005;
    const epsilon = 1e-9;
    if (
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) >
      keys.length * rounding + epsilon
    )
      throw new Error("Invalid distribution");
    if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !keys.includes(answer.choice) ||
        (probabilities[answer.choice] as number) < Math.max(...values)
      )
        throw new Error("Invalid choice");
      result[id] = {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
          keys.map((key, i) => [key, values[i]!]),
        ),
      };
    } else if (question.type === "score") {
      const legend = answer.legend;
      if (
        !record(legend) ||
        Object.keys(legend).length !== keys.length ||
        keys.some((key, i) => legend[key] !== question.criteria[i]) ||
        !inRange(answer.score, 0, keys.length - 1)
      )
        throw new Error("Invalid score");
      const expected = values.reduce((sum, value, i) => sum + value * i, 0);
      const scoreTolerance =
        rounding * (1 + (keys.length * (keys.length - 1)) / 2);
      if (Math.abs(expected - answer.score) > scoreTolerance + epsilon)
        throw new Error("Inconsistent score");
      result[id] = {
        score: answer.score,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
          keys.map((key, i) => [key, values[i]!]),
        ),
      };
    }
  }
  return result;
}
