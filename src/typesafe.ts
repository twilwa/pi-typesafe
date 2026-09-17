import {
  TypeSafeClient,
  type APIPromise,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";

export { choice, score, noul } from "@typesafe-ai/sdk";
export type {
  ChoiceQuestion,
  ChoiceResponse,
  NoulQuestion,
  NoulResponse,
  ScoreQuestion,
  ScoreResponse,
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeClientConfig,
} from "@typesafe-ai/sdk";

/** Thin SDK boundary; construction is explicit so importing needs no credentials. */
export function createTypeSafe(config: TypeSafeClientConfig = {}) {
  const client = new TypeSafeClient(config);
  return {
    systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
      options?: RequestOptions,
    ): APIPromise<SystemOneResult<Q>> {
      return client.systemOne(request, options);
    },
  };
}
