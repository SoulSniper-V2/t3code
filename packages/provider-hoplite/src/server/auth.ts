import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderCredentials } from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeHopliteApi } from "../api.ts";
import { HopliteCredentialStore } from "./credentials.ts";

const ISSUER = "https://api.hoplite.sh/api/auth";
const SCOPES =
  "openid profile email offline_access api:read api:write project:read thread:create thread:read thread:update";

export function validOAuthCallback(callback: URL, redirectUri: string, state: string): boolean {
  const redirect = new URL(redirectUri);
  return (
    callback.origin === redirect.origin &&
    callback.pathname === redirect.pathname &&
    callback.username === "" &&
    callback.password === "" &&
    callback.hash === "" &&
    callback.searchParams.getAll("state").length === 1 &&
    callback.searchParams.get("state") === state &&
    callback.searchParams.getAll("iss").length === 1 &&
    callback.searchParams.get("iss") === ISSUER &&
    callback.searchParams.getAll("code").length === 1 &&
    !callback.searchParams.has("error")
  );
}

export const makeHopliteAuth = Effect.fn("makeHopliteAuth")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly credentials: ProviderCredentials;
  readonly refresh: Effect.Effect<unknown>;
}) {
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const store = yield* HopliteCredentialStore;
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation, detail });
  const controller = yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    credentialBinding: input.credentials.binding,
    defaultMethodId: "api-key",
    methods: Effect.succeed([
      {
        id: "api-key",
        name: "Hoplite API key",
        type: "credentials" as const,
        description: "Use an organization API key or service credential.",
      },
      {
        id: "oauth",
        name: "Sign in with Hoplite",
        type: "agent" as const,
        description:
          "Authorize T3 Code in Hoplite, then paste the final localhost callback URL here.",
      },
    ]),
    authenticate: (method, context) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<Effect.Effect<void>, ProviderSetupError>();
        if (method === "api-key") {
          yield* context.setInteraction(
            {
              type: "credentials",
              id: context.flowId,
              fields: [{ name: "apiKey", label: "Hoplite API key", secret: true }],
            },
            (response) =>
              Effect.gen(function* () {
                if (response.type !== "credentials")
                  return yield* error("respond", "Enter a Hoplite API key.");
                const apiKey = response.values.apiKey?.trim();
                if (!apiKey || !/^hop_[A-Za-z0-9_-]+$/.test(apiKey))
                  return yield* error("respond", "Enter a Hoplite API key beginning with hop_.");
                const candidate = yield* makeHopliteApi({ apiKey: Effect.succeed(apiKey) }).pipe(
                  Effect.provideService(HttpClient.HttpClient, http),
                );
                yield* candidate
                  .request(
                    "GET",
                    "/api/projects",
                    Schema.Struct({ projects: Schema.Array(Schema.Unknown) }),
                  )
                  .pipe(
                    Effect.mapError(() =>
                      error(
                        "verify",
                        "Hoplite rejected the key or project:read permission is missing.",
                      ),
                    ),
                  );
                yield* store
                  .set(input.instanceId, { apiKey })
                  .pipe(
                    Effect.mapError(() =>
                      error("store", "Could not securely store the Hoplite API key."),
                    ),
                  );
                yield* input.refresh;
                const responseFiber = yield* Effect.fiber;
                yield* Deferred.succeed(done, Fiber.await(responseFiber).pipe(Effect.asVoid));
              }),
          );
        } else {
          const current = yield* store.get(input.instanceId).pipe(Effect.orElseSucceed(() => ({})));
          let clientId = "clientId" in current ? current.clientId : undefined;
          const redirectUri =
            ("redirectUri" in current ? current.redirectUri : undefined) ??
            "http://127.0.0.1:54329/oauth/hoplite/callback";
          if (!clientId) {
            const request = yield* HttpClientRequest.bodyJson(
              HttpClientRequest.post(`${ISSUER}/oauth2/register`),
              {
                client_name: "T3 Code",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
              },
            ).pipe(
              Effect.mapError(() => error("register", "Could not register T3 Code with Hoplite.")),
            );
            const response = yield* http.execute(request).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(Schema.Struct({ client_id: Schema.String })),
              ),
              Effect.mapError(() =>
                error("register", "Hoplite could not register this T3 Code client."),
              ),
            );
            clientId = response.client_id;
            yield* store
              .set(input.instanceId, { ...current, clientId, redirectUri })
              .pipe(
                Effect.mapError(() =>
                  error("register", "Could not securely store the OAuth client registration."),
                ),
              );
          }
          const verifier = Base64Url.encode(
            yield* crypto
              .randomBytes(64)
              .pipe(
                Effect.mapError(() =>
                  error("start", "Could not generate a secure sign-in request."),
                ),
              ),
          );
          const state = Base64Url.encode(
            yield* crypto
              .randomBytes(32)
              .pipe(
                Effect.mapError(() =>
                  error("start", "Could not generate a secure sign-in request."),
                ),
              ),
          );
          const challenge = Base64Url.encode(
            yield* crypto
              .digest("SHA-256", new TextEncoder().encode(verifier))
              .pipe(
                Effect.mapError(() => error("start", "Could not generate the PKCE challenge.")),
              ),
          );
          const authorization = new URL(`${ISSUER}/oauth2/authorize`);
          authorization.search = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: SCOPES,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            prompt: "consent",
          }).toString();
          const registeredClientId = clientId;
          let used = false;
          yield* context.setInteraction(
            {
              type: "browser",
              id: context.flowId,
              url: authorization.toString(),
              requiresConsent: false,
              acceptsCallback: true,
            },
            undefined,
            (callbackUrl) =>
              Effect.gen(function* () {
                if (used || (yield* Clock.currentTimeMillis) >= context.expiresAt)
                  return yield* error("callback", "This Hoplite sign-in has expired. Start again.");
                const callback = yield* Effect.try({
                  try: () => new URL(callbackUrl),
                  catch: () => error("callback", "Paste the complete Hoplite callback URL."),
                });
                if (!validOAuthCallback(callback, redirectUri, state))
                  return yield* error(
                    "callback",
                    "Hoplite callback state, issuer or redirect did not match the active sign-in.",
                  );
                used = true;
                const tokens = yield* store
                  .exchange({
                    grant_type: "authorization_code",
                    code: callback.searchParams.get("code")!,
                    redirect_uri: redirectUri,
                    client_id: registeredClientId,
                    code_verifier: verifier,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      error("exchange", "Hoplite could not complete sign-in. Start again."),
                    ),
                  );
                yield* store
                  .set(input.instanceId, { ...tokens, clientId: registeredClientId, redirectUri })
                  .pipe(
                    Effect.mapError(() =>
                      error("store", "Could not securely store the Hoplite sign-in."),
                    ),
                  );
                yield* input.refresh;
                yield* Deferred.succeed(done, Effect.void);
              }),
          );
        }
        yield* yield* Deferred.await(done);
      }),
    logout: store.remove(input.instanceId).pipe(
      Effect.mapError(() => error("logout", "Could not remove the Hoplite sign-in.")),
      Effect.tap(() => input.refresh),
    ),
  });
  return controller;
});
