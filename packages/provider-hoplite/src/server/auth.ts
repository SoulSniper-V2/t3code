import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderCredentials } from "@t3tools/provider-core/server/ProviderHost";
import type { HopliteApiError } from "./api.ts";
import { signInWithHopliteCli } from "./login.ts";

export const HOPLITE_BROWSER_SIGN_IN = "hoplite-login";
export const HOPLITE_API_KEY_SIGN_IN = "api-key";

const METHODS: ReadonlyArray<ProviderAuthMethod> = [
  {
    id: HOPLITE_BROWSER_SIGN_IN,
    name: "Sign in with Hoplite",
    description: "Approve T3 Code in your browser.",
    type: "agent",
  },
  {
    id: HOPLITE_API_KEY_SIGN_IN,
    name: "Use an API key",
    description: "Paste a key from Hoplite Settings → Workspace → API keys.",
    type: "credentials",
  },
];

export interface HopliteKeyStore {
  readonly read: Effect.Effect<string | undefined>;
  readonly binding: ProviderCredentials["binding"];
}

export const makeHopliteKeyStore = (credentials: ProviderCredentials) => {
  const store: HopliteKeyStore = {
    binding: credentials.binding,
    read: credentials.get.pipe(
      Effect.map(
        Option.match({
          onNone: () => undefined,
          onSome: (bytes) => new TextDecoder().decode(bytes).trim() || undefined,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    ),
  };
  return {
    store,
    write: (apiKey: string) => credentials.set(new TextEncoder().encode(apiKey)),
    remove: credentials.remove,
  };
};

export const makeHopliteAuth = Effect.fn("makeHopliteAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentials: ProviderCredentials;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly verifyKey: (apiKey: string) => Effect.Effect<unknown, HopliteApiError>;
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const keys = makeHopliteKeyStore(options.credentials);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const verify = (apiKey: string) =>
    options
      .verifyKey(apiKey)
      .pipe(Effect.mapError((error) => failure("verify", error.detail, error)));
  const save = (apiKey: string) =>
    keys.write(apiKey).pipe(
      Effect.mapError((cause) =>
        failure("credentials", "Could not save the Hoplite key. Try again.", cause),
      ),
      Effect.andThen(options.onChanged),
    );

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: keys.store.binding,
    methods: Effect.succeed(METHODS),
    defaultMethodId: HOPLITE_BROWSER_SIGN_IN,
    authenticate: (methodId, context) =>
      methodId === HOPLITE_API_KEY_SIGN_IN
        ? Effect.gen(function* () {
            const accepted = yield* Deferred.make<string>();
            yield* context.setInteraction(
              {
                type: "credentials",
                id: HOPLITE_API_KEY_SIGN_IN,
                fields: [{ name: "apiKey", label: "Hoplite API key", secret: true }],
              },
              // Verifying while the form is still open lets a mistyped key be corrected in place.
              (response) => {
                if (response.type !== "credentials") return Effect.void;
                const apiKey = response.values.apiKey?.trim() ?? "";
                return apiKey.startsWith("hop_")
                  ? verify(apiKey).pipe(
                      Effect.andThen(Deferred.succeed(accepted, apiKey)),
                      Effect.asVoid,
                    )
                  : Effect.fail(failure("respond", "Hoplite API keys start with hop_."));
              },
            );
            const apiKey = yield* Deferred.await(accepted);
            yield* context.verifying;
            yield* save(apiKey);
          })
        : signInWithHopliteCli({
            instanceId: options.instanceId,
            binaryPath: options.binaryPath,
            environment: options.environment,
            onDeviceLogin: ({ url, userCode }) =>
              context.setInteraction({
                type: "deviceCode",
                id: HOPLITE_BROWSER_SIGN_IN,
                url,
                userCode,
              }),
            onVerifying: context.verifying,
          }).pipe(
            Effect.tap(verify),
            Effect.flatMap(save),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
    // T3 keeps its own copy of the key, so signing out here leaves the user's terminal CLI signed in.
    logout: keys.remove.pipe(
      Effect.mapError((cause) =>
        failure("logout", "Could not remove the Hoplite key. Try again.", cause),
      ),
      Effect.andThen(options.onChanged),
      Effect.as("Signed out of Hoplite."),
    ),
  });
  return { controller, keys: keys.store };
});
