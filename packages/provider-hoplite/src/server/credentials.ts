import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { HopliteApiError, HopliteCredentials } from "../schemas.ts";
const credentialsJson = Schema.fromJsonString(HopliteCredentials);
const decodeCredentials = Schema.decodeEffect(credentialsJson);
const encodeCredentials = Schema.encodeEffect(credentialsJson);

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
});

export class HopliteCredentialStore extends Context.Service<
  HopliteCredentialStore,
  {
    readonly get: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<HopliteCredentials, HopliteApiError>;
    readonly set: (
      instanceId: ProviderInstanceId,
      value: HopliteCredentials,
    ) => Effect.Effect<void, HopliteApiError>;
    readonly remove: (instanceId: ProviderInstanceId) => Effect.Effect<void, HopliteApiError>;
    readonly authorization: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<{ readonly header: string; readonly value: string }, HopliteApiError>;
    readonly exchange: (
      form: Readonly<Record<string, string>>,
    ) => Effect.Effect<
      { readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number },
      HopliteApiError
    >;
  }
>()("@t3tools/provider-hoplite/server/credentials/HopliteCredentialStore") {}

const make = Effect.gen(function* () {
  const host = yield* ProviderHost.ProviderHost;
  const http = yield* HttpClient.HttpClient;
  const locks = new Map<ProviderInstanceId, Semaphore.Semaphore>();
  const lockFor = Effect.fnUntraced(function* (id: ProviderInstanceId) {
    let lock = locks.get(id);
    if (!lock) {
      lock = yield* Semaphore.make(1);
      locks.set(id, lock);
    }
    return lock;
  });
  const get = Effect.fn("HopliteCredentialStore.get")(function* (instanceId: ProviderInstanceId) {
    const store = yield* host.credentials("hoplite", instanceId);
    const bytes = yield* store.get.pipe(
      Effect.mapError(() => new HopliteApiError({ operation: "read credentials" })),
    );
    if (Option.isNone(bytes)) return yield* new HopliteApiError({ operation: "authenticate" });
    return yield* decodeCredentials(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => new HopliteApiError({ operation: "decode credentials" })),
    );
  });
  const write = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    value: HopliteCredentials,
  ) {
    const store = yield* host.credentials("hoplite", instanceId);
    const encoded = yield* encodeCredentials(value).pipe(
      Effect.mapError(() => new HopliteApiError({ operation: "encode credentials" })),
    );
    yield* store
      .set(new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(() => new HopliteApiError({ operation: "store credentials" })));
  });
  const exchange = Effect.fn("HopliteCredentialStore.exchange")(function* (
    form: Readonly<Record<string, string>>,
  ) {
    const request = HttpClientRequest.post("https://api.hoplite.sh/api/auth/oauth2/token").pipe(
      HttpClientRequest.bodyUrlParams(form),
    );
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => new HopliteApiError({ operation: "OAuth token exchange" })));
    if (response.status < 200 || response.status >= 300)
      return yield* new HopliteApiError({
        operation: "OAuth token exchange",
        status: response.status,
      });
    const token = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
      Effect.mapError(() => new HopliteApiError({ operation: "decode OAuth token" })),
    );
    if (token.token_type && token.token_type.toLowerCase() !== "bearer")
      return yield* new HopliteApiError({ operation: "unsupported OAuth token type" });
    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: (yield* Clock.currentTimeMillis) + Math.max(1, token.expires_in ?? 3600) * 1000,
    };
  });
  return HopliteCredentialStore.of({
    get,
    set: (instanceId, value) =>
      lockFor(instanceId).pipe(
        Effect.flatMap((lock) => write(instanceId, value).pipe(lock.withPermits(1))),
      ),
    remove: (instanceId) =>
      Effect.gen(function* () {
        const lock = yield* lockFor(instanceId);
        const store = yield* host.credentials("hoplite", instanceId);
        yield* store.remove.pipe(
          Effect.mapError(() => new HopliteApiError({ operation: "remove credentials" })),
          lock.withPermits(1),
        );
      }),
    authorization: (instanceId) =>
      Effect.gen(function* () {
        const lock = yield* lockFor(instanceId);
        return yield* Effect.gen(function* () {
          let credentials = yield* get(instanceId);
          if (credentials.apiKey) return { header: "X-Api-Key", value: credentials.apiKey };
          if (!credentials.accessToken)
            return yield* new HopliteApiError({ operation: "authenticate" });
          if ((credentials.expiresAt ?? 0) < (yield* Clock.currentTimeMillis) + 60_000) {
            if (!credentials.refreshToken || !credentials.clientId)
              return yield* new HopliteApiError({
                operation: "OAuth sign-in expired",
                status: 401,
              });
            const token = yield* exchange({
              grant_type: "refresh_token",
              refresh_token: credentials.refreshToken,
              client_id: credentials.clientId,
            });
            credentials = { ...credentials, ...token };
            yield* write(instanceId, credentials);
          }
          return { header: "Authorization", value: `Bearer ${credentials.accessToken}` };
        }).pipe(lock.withPermits(1));
      }),
    exchange,
  });
});

export const hopliteCredentialStoreLayer = Layer.effect(HopliteCredentialStore, make);
