import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpMethod } from "effect/http/HttpMethod";

import { HopliteApiError, HopliteErrorCode } from "./schemas.ts";
const isHopliteApiError = Schema.is(HopliteApiError);
const knownErrorBody = Schema.Struct({ error: HopliteErrorCode });
const decodeErrorBody = Schema.decodeEffect(Schema.fromJsonString(knownErrorBody));
export { HopliteApiError, HopliteCredentials } from "./schemas.ts";

export const HopliteThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
});
export type HopliteThread = typeof HopliteThread.Type;

export const HopliteMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  kind: Schema.Literals(["chat", "thinking", "tool", "status"]),
  content: Schema.String,
  createdAt: Schema.String,
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
});
export type HopliteMessage = typeof HopliteMessage.Type;

export const HopliteModelCatalog = Schema.Struct({
  runConfig: Schema.Struct({
    defaultModelId: Schema.String,
    defaultReasoning: Schema.String,
    defaultSpeed: Schema.String,
  }),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      provider: Schema.String,
      capabilities: Schema.optional(
        Schema.Struct({
          reasoningLevels: Schema.Array(Schema.String),
          supportsFast: Schema.Boolean,
          supportsImages: Schema.optional(Schema.Boolean),
          contextWindowTokens: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
});
export type HopliteModelCatalog = typeof HopliteModelCatalog.Type;

export const HopliteEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  cursor: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type HopliteEvent = typeof HopliteEvent.Type;

export interface HopliteRequestOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly query?: Readonly<Record<string, string>>;
}

export const makeHopliteApi = Effect.fn("makeHopliteApi")(function* (options: {
  readonly apiKey?: Effect.Effect<string, HopliteApiError>;
  readonly authorization?: Effect.Effect<
    { readonly header: string; readonly value: string },
    HopliteApiError
  >;
  readonly baseUrl?: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const execute = Effect.fnUntraced(function* (
    method: HttpMethod,
    path: string,
    input: HopliteRequestOptions = {},
    headers: Record<string, string> = {},
  ) {
    if (!path.startsWith("/api/") || path.includes(".."))
      return yield* new HopliteApiError({ operation: "invalid path" });
    const authorization = options.authorization
      ? yield* options.authorization
      : options.apiKey
        ? { header: "X-Api-Key", value: yield* options.apiKey }
        : yield* new HopliteApiError({ operation: "authenticate" });
    let request = HttpClientRequest.make(method)(
      `${options.baseUrl ?? "https://api.hoplite.sh"}${path}`,
    ).pipe(
      HttpClientRequest.setHeader(authorization.header, authorization.value),
      HttpClientRequest.setHeaders(headers),
    );
    if (input.query) request = HttpClientRequest.setUrlParams(request, input.query);
    if (input.idempotencyKey)
      request = HttpClientRequest.setHeader(request, "Idempotency-Key", input.idempotencyKey);
    if (input.body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
        Effect.mapError(() => new HopliteApiError({ operation: "encode request" })),
      );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new HopliteApiError({ operation: method })));
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = Number(response.headers["retry-after"]);
      let errorBytes = 0;
      const body = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          errorBytes += chunk.byteLength;
          return errorBytes <= 8192
            ? Effect.succeed(chunk)
            : Effect.fail(new HopliteApiError({ operation: "error response size limit" }));
        }),
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.flatMap(decodeErrorBody),
        Effect.timeout("2 seconds"),
        Effect.option,
      );
      return yield* new HopliteApiError({
        operation: method,
        status: response.status,
        ...(Option.isSome(body) ? { errorCode: body.value.error } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
      });
    }
    return response;
  });
  const request = <A, I>(
    method: HttpMethod,
    path: string,
    schema: Schema.Codec<A, I>,
    input?: HopliteRequestOptions,
  ) =>
    execute(method, path, input).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError((error) =>
        isHopliteApiError(error) ? error : new HopliteApiError({ operation: "decode response" }),
      ),
    );
  const events = (input: { readonly threadId: string; readonly cursor?: string }) =>
    Stream.unwrap(
      execute(
        "GET",
        "/api/events/stream",
        {
          query: { threadId: input.threadId },
        },
        {
          accept: "text/event-stream",
          ...(input.cursor ? { "Last-Event-ID": input.cursor } : {}),
        },
      ).pipe(
        Effect.map((response) =>
          response.stream.pipe(
            Stream.timeoutOrElse({
              duration: "45 seconds",
              orElse: () =>
                Stream.fail(new HopliteApiError({ operation: "event stream heartbeat timeout" })),
            }),
            Stream.decodeText,
            Stream.pipeThroughChannel(Sse.decode()),
            Stream.mapError(() => new HopliteApiError({ operation: "event stream" })),
          ),
        ),
      ),
    );
  return { request, events };
});
export type HopliteApi = Effect.Success<ReturnType<typeof makeHopliteApi>>;
export { HopliteCredentialStore, hopliteCredentialStoreLayer } from "./server/credentials.ts";
