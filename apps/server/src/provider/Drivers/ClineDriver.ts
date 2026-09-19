/**
 * ClineDriver — `ProviderDriver` for the Cline CLI.
 *
 * Cline runs as one `--json` subprocess per turn. Headless `--id` resume
 * forces interactive mode (requires a TTY), so every turn starts a fresh
 * Cline session: no shadow homes, no installer maintenance (the CLI
 * self-updates), and no static catalog — the snapshot advertises whatever
 * `cline history --json` has seen the local install run.
 *
 * @module provider/Drivers/ClineDriver
 */
import { ClineSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClineTextGeneration } from "../../textGeneration/ClineTextGeneration.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeClineSnapshotShape } from "../ClineProvider.ts";
import { makeClineAdapter } from "../Layers/ClineAdapter.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("cline");
const decodeClineSettings = Schema.decodeSync(ClineSettings);

export type ClineDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export const ClineDriver: ProviderDriver<ClineSettings, ClineDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cline",
    // One shared ~/.cline home: no per-account shadow homes in v1.
    supportsMultipleInstances: false,
  },
  configSchema: ClineSettings,
  defaultConfig: (): ClineSettings => decodeClineSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig: ClineSettings = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      };
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const snapshot = yield* makeClineSnapshotShape({
        config: effectiveConfig,
        env: processEnv,
        homeDir: NodeOS.homedir(),
        stamp,
        displayName: "Cline",
        driverKind: DRIVER_KIND,
      });
      const adapter = yield* makeClineAdapter(effectiveConfig, {
        driverKind: DRIVER_KIND,
        instanceId,
        environment: processEnv,
      });
      const textGeneration = makeClineTextGeneration(effectiveConfig);

      // Probe the CLI once at startup so the UI settles on real status fast.
      yield* Effect.forkScoped(snapshot.refresh.pipe(Effect.ignoreCause({ log: true })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
