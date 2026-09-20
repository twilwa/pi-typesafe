import {
  TypeSafeClient,
  type APIPromise,
  type Fetch,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";

export const MAX_RESPONSE_BYTES = 64 * 1024;

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

function cappedFetch(fetch: Fetch): Fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared)) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("TypeSafe response exceeds local budget");
      }
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let received = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          received += chunk.value.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            controller.error(
              new Error("TypeSafe response exceeds local budget"),
            );
            void reader.cancel().catch(() => {});
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Thin SDK boundary; construction is explicit so importing needs no credentials. */
export function createTypeSafe(config: TypeSafeClientConfig = {}) {
  const fetch: Fetch =
    config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client = new TypeSafeClient({ ...config, fetch: cappedFetch(fetch) });
  return {
    systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
      options?: RequestOptions,
    ): APIPromise<SystemOneResult<Q>> {
      return client.systemOne(request, options);
    },
  };
}
