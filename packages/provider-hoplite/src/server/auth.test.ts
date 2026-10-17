import { describe, expect, it } from "@effect/vitest";
import { sha256 } from "@noble/hashes/sha2";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HopliteCredentialStore, hopliteCredentialStoreLayer } from "./credentials.ts";
import { makeHopliteAuth } from "./auth.ts";
import { instanceId, makeHost, requestText, response } from "./testkit.ts";

const fixture = () => {
  const host = makeHost();
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let entropy = 0;
  const crypto = Crypto.make({
    randomBytes: (size) => Uint8Array.from({ length: size }, () => ++entropy % 256),
    digest: (_algorithm, bytes) => Effect.succeed(sha256(bytes)),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      if (request.url.endsWith("/oauth2/register"))
        return response(request, { client_id: "t3-public-client" }, 201);
      if (request.url.endsWith("/oauth2/token"))
        return response(request, {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      if (request.url.endsWith("/projects")) return response(request, { projects: [] });
      throw new Error("Unexpected auth test endpoint");
    }),
  );
  const base = Layer.mergeAll(
    Layer.succeed(ProviderHost.ProviderHost, host),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(Crypto.Crypto, crypto),
  );
  return { host, requests, layer: hopliteCredentialStoreLayer.pipe(Layer.provideMerge(base)) };
};

describe("secure Hoplite authentication", () => {
  it.effect(
    "stores a submitted API key only in host credentials and hides the flow from another client",
    () => {
      const f = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const credentials = yield* f.host.credentials("hoplite", instanceId);
          const auth = yield* makeHopliteAuth({ instanceId, credentials, refresh: Effect.void });
          yield* auth.start("owner", Effect.void, "api-key");
          const waiting = yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "waiting"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          const foreign = yield* auth
            .subscribe("other")
            .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(foreign.interaction).toBeNull();
          expect(foreign.flowId).toBeNull();
          const wrongOwner = yield* auth.respond!("other", {
            instanceId,
            flowId: waiting.flowId!,
            interactionId: waiting.interaction!.id,
            response: { type: "credentials", values: { apiKey: "hop_test_secret" } },
          }).pipe(Effect.result);
          expect(wrongOwner._tag).toBe("Failure");
          yield* auth.respond!("owner", {
            instanceId,
            flowId: waiting.flowId!,
            interactionId: waiting.interaction!.id,
            response: { type: "credentials", values: { apiKey: "hop_test_secret" } },
          });
          yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "succeeded"),
            Stream.runHead,
          );
          const store = yield* HopliteCredentialStore;
          expect(yield* store.get(instanceId)).toEqual({ apiKey: "hop_test_secret" });
          expect(f.requests[0]?.headers["x-api-key"]).toBe("hop_test_secret");
          expect(waiting).not.toHaveProperty("apiKey");
          yield* auth.logout(Effect.void);
          expect((yield* store.get(instanceId).pipe(Effect.result))._tag).toBe("Failure");
        }),
      ).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "registers its own public client, rejects mismatched callback state and exchanges a valid code with PKCE",
    () => {
      const f = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const credentials = yield* f.host.credentials("hoplite", instanceId);
          const auth = yield* makeHopliteAuth({ instanceId, credentials, refresh: Effect.void });
          yield* auth.start("owner", Effect.void, "oauth");
          const waiting = yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "waiting"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          const authorize = new URL(waiting.authorizationUrl!);
          const callback = new URL(authorize.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            code: "authorization-code",
            state: "wrong",
            iss: "https://api.hoplite.sh/api/auth",
          }).toString();
          expect(
            (yield* auth
              .complete("owner", { flowId: waiting.flowId!, callbackUrl: callback.toString() })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            f.requests.filter((request) => request.url.endsWith("/oauth2/token")),
          ).toHaveLength(0);
          callback.searchParams.set("state", authorize.searchParams.get("state")!);
          yield* auth.complete("owner", {
            flowId: waiting.flowId!,
            callbackUrl: callback.toString(),
          });
          yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "succeeded"),
            Stream.runHead,
          );
          const registration = JSON.parse(
            requestText(f.requests.find((request) => request.url.endsWith("/oauth2/register"))!),
          );
          expect(registration).toMatchObject({
            token_endpoint_auth_method: "none",
            client_name: "T3 Code",
          });
          expect(registration.redirect_uris).toEqual([authorize.searchParams.get("redirect_uri")]);
          const exchange = new URLSearchParams(
            requestText(f.requests.find((request) => request.url.endsWith("/oauth2/token"))!),
          );
          expect(exchange.get("client_id")).toBe("t3-public-client");
          expect(exchange.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
          expect(
            Base64Url.encode(sha256(new TextEncoder().encode(exchange.get("code_verifier")!))),
          ).toBe(authorize.searchParams.get("code_challenge"));
          const store = yield* HopliteCredentialStore;
          expect((yield* store.authorization(instanceId)).header).toBe("Authorization");
          expect((yield* store.get(instanceId)).apiKey).toBeUndefined();
        }),
      ).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("refreshes once for concurrent callers and preserves an omitted refresh token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = makeHost();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshes = 0;
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            refreshes++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            const form = new URLSearchParams(requestText(request));
            expect(form.get("grant_type")).toBe("refresh_token");
            expect(form.get("refresh_token")).toBe("old-refresh");
            return response(request, { access_token: "new-access", expires_in: 3600 });
          }),
        );
        const program = Effect.gen(function* () {
          const store = yield* HopliteCredentialStore;
          yield* store.set(instanceId, {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            clientId: "client-1",
            expiresAt: (yield* Clock.currentTimeMillis) - 1,
          });
          const callers = yield* Effect.all(
            [store.authorization(instanceId), store.authorization(instanceId)],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(callers)).toEqual([
            { header: "Authorization", value: "Bearer new-access" },
            { header: "Authorization", value: "Bearer new-access" },
          ]);
          expect(refreshes).toBe(1);
          expect((yield* store.get(instanceId)).refreshToken).toBe("old-refresh");
        });
        yield* program.pipe(
          Effect.provide(
            hopliteCredentialStoreLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ProviderHost.ProviderHost, host),
                  Layer.succeed(HttpClient.HttpClient, http),
                ),
              ),
            ),
          ),
        );
      }),
    ),
  );
});
