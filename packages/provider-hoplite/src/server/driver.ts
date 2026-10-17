import { ProviderDriverKind, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpClient from "effect/http/HttpClient";
import { HopliteCredentialStore, HopliteModelCatalog, makeHopliteApi } from "../api.ts";
import { HopliteSettings } from "../settings.ts";
import { makeHopliteAdapter } from "./adapter.ts";
import { makeHopliteAuth } from "./auth.ts";
import { hopliteModels } from "./models.ts";

const driverKind = ProviderDriverKind.make("hoplite");
const decodeSettings = Schema.decodeSync(HopliteSettings);
export type HopliteDriverEnv =
  | ProviderHost.ProviderHost
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Crypto.Crypto
  | HopliteCredentialStore;

export const HopliteDriver: ProviderDriver<HopliteSettings, HopliteDriverEnv> = {
  driverKind,
  metadata: { displayName: "Hoplite", supportsMultipleInstances: true },
  configSchema: HopliteSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const credentials = yield* host.credentials("hoplite", instanceId);
      const credentialStore = yield* HopliteCredentialStore;
      const api = yield* makeHopliteApi({
        authorization: credentialStore.authorization(instanceId),
      });
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const initial: ServerProvider = {
        instanceId,
        driver: driverKind,
        displayName: displayName ?? "Hoplite",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled,
        installed: true,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        models: [],
        slashCommands: [],
        skills: [],
        showInteractionModeToggle: false,
        supportedRuntimeModes: ["full-access"],
        supportsConversationRollback: false,
        supportsTextGeneration: false,
        workspaceLocation: "managed",
        setup: {
          canAuthenticate: true,
          canInstall: false,
          documentationUrl: "https://hoplite.sh/docs/api/authentication",
        },
        nativeSessions: { canList: false, canLoad: true, canResume: true, canDelete: false },
        message: enabled
          ? "Connect a Hoplite API key. Threads run in cloud workspaces, not the local project directory."
          : "Hoplite is disabled.",
      };
      const state = yield* SubscriptionRef.make(initial);
      const refresh = Effect.gen(function* () {
        if (!enabled) return initial;
        const result = yield* api
          .request("GET", "/api/model-providers", HopliteModelCatalog)
          .pipe(Effect.result);
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const next: ServerProvider =
          result._tag === "Success"
            ? {
                ...initial,
                checkedAt,
                status: config.projectId.trim() ? "ready" : "warning",
                auth: { status: "authenticated" },
                models: hopliteModels(result.success),
                message: config.projectId.trim()
                  ? "Hoplite cloud workspace connected. Local files, terminals and checkpoints are not shared with Hoplite."
                  : "Choose a Hoplite project ID in provider settings for new threads.",
              }
            : {
                ...initial,
                checkedAt,
                status: "error",
                auth: {
                  status:
                    result.failure.status === 401 || result.failure.operation === "authenticate"
                      ? "unauthenticated"
                      : "unknown",
                },
                message:
                  result.failure.status === 403
                    ? "The Hoplite key needs modelKey:read permission to discover its authorized models."
                    : result.failure.message,
              };
        yield* SubscriptionRef.set(state, next);
        return next;
      });
      const auth = yield* makeHopliteAuth({ instanceId, credentials, refresh });
      const orchestrationAdapter = yield* makeHopliteAdapter({ instanceId, settings: config, api });
      const unavailable = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              "Hoplite has no public stateless text-generation endpoint. Choose another provider for local Git and title generation.",
          }),
        );
      yield* refresh;
      return {
        instanceId,
        driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          getSnapshot: SubscriptionRef.get(state),
          refresh,
          streamChanges: SubscriptionRef.changes(state),
          resolveMaintenance: () =>
            Effect.succeed({ provider: driverKind, packageName: null, update: null }),
          applyUsageLimits: () => Effect.void,
        },
        refreshModels: () => refresh.pipe(Effect.asVoid),
        orchestrationAdapter,
        auth,
        textGeneration: {
          generateThreadTitle: () => unavailable("thread title"),
          generateBranchName: () => unavailable("branch name"),
          generateCommitMessage: () => unavailable("commit message"),
          generatePrContent: () => unavailable("pull request"),
          generateReviewGuide: () => unavailable("review guide"),
        },
      };
    }),
};
