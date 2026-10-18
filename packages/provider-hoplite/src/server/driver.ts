import { ProviderDriverKind, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { HopliteSettings } from "../settings.ts";
import { makeHopliteAdapterForInstance, type HopliteAdapterV2DriverEnv } from "./adapter.ts";
import { makeHopliteAuth } from "./auth.ts";
import { makeHopliteConnector } from "./connection.ts";
import { buildInitialHopliteSnapshot, makeHopliteStatusCheck } from "./status.ts";

const DRIVER_KIND = ProviderDriverKind.make("hoplite");
const decodeSettings = Schema.decodeSync(HopliteSettings);
// The CLI has no self-updater, so only an npm or Homebrew install it provably
// belongs to is updated in place.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@usehoplite/cli",
  nativeUpdate: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Hoplite runs coding threads only; it does not generate titles or commit messages.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type HopliteDriverEnv =
  | HopliteAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost
  | ProviderLatestVersions.ProviderLatestVersions;

export const HopliteDriver: ProviderDriver<HopliteSettings, HopliteDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hoplite",
    supportsMultipleInstances: true,
  },
  configSchema: HopliteSettings,
  defaultConfig: (): HopliteSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled } satisfies HopliteSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (draft: ServerProviderDraft): ServerProvider => ({
        ...draft,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const driverError = (detail: string) => (cause: unknown) =>
        new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });

      const connector = yield* makeHopliteConnector({
        instanceId,
        settings,
        environment: processEnv,
      });
      const auth = yield* makeHopliteAuth({
        instanceId,
        credentials: connector.credentials,
        binaryPath: settings.binaryPath || "hoplite",
        environment: processEnv,
        verifyKey: (apiKey) => connector.api(apiKey).pipe(Effect.flatMap((api) => api.verify)),
        onChanged: Effect.suspend(() => snapshot.refresh).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const orchestrationAdapter = yield* makeHopliteAdapterForInstance({
        instanceId,
        settings,
        connector,
        ...(auth.controller.withAccess ? { withAccess: auth.controller.withAccess } : {}),
      }).pipe(Effect.mapError(driverError("Failed to build Hoplite orchestration adapter.")));

      const status = yield* makeHopliteStatusCheck({
        settings,
        connector,
        cwd: host.paths.cwd,
        environment: processEnv,
      });
      const checkProvider = status.checkProvider.pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: settings.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HopliteSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (current) =>
          buildInitialHopliteSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings: current, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, maintenance, {
                enableProviderUpdateChecks: current.enableProviderUpdateChecks,
              }),
            ),
            Effect.flatMap(publishSnapshot),
            Effect.catchCause((cause) =>
              Effect.logWarning("Hoplite version advisory enrichment failed", {
                errorTag: causeErrorTag(cause),
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(Effect.mapError(driverError("Failed to build Hoplite snapshot.")));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth: auth.controller,
        snapshot,
        orchestrationAdapter,
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};
