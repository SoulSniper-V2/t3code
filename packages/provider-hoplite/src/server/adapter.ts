import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { HopliteSettings } from "../settings.ts";
import {
  hopliteAcpEnvironment,
  makeHopliteConnector,
  type HopliteConnector,
} from "./connection.ts";

export const HOPLITE_PROVIDER = ProviderDriverKind.make("hoplite");
export const HOPLITE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HOPLITE_PROVIDER);
const DEFAULT_HOPLITE_SETTINGS = Schema.decodeSync(HopliteSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Hoplite runs every turn in its own cloud workspace, so T3 cannot roll that
 * workspace back, and a fresh ACP session would start a new Hoplite thread.
 * Client MCP servers are dropped by the CLI; agents use the project's own.
 */
export const HopliteProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface InsufficientCreditsData {
  readonly code: "insufficient_credits";
  readonly billingUrl?: string;
}

function insufficientCredits(data: unknown): InsufficientCreditsData | undefined {
  return typeof data === "object" &&
    data !== null &&
    "code" in data &&
    data.code === "insufficient_credits"
    ? (data as InsufficientCreditsData)
    : undefined;
}

export interface HopliteAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HopliteSettings;
  readonly connector: HopliteConnector;
  /** Ties each session to the instance's sign-in so signing out stops it. */
  readonly withAccess?: ProviderAuthController["withAccess"];
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

export function makeHopliteAcpAdapterFlavor(options: HopliteAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: HOPLITE_PROVIDER,
    runtimeHarness: "Hoplite",
    capabilities: HopliteProviderCapabilitiesV2,
    supportsCompaction: true,
    // Hoplite applies its project's tool policy in the cloud and only asks about
    // what that policy holds for a person, so every request reaches the user.
    permissionDisposition: () => "ask",
    makeRuntime: ({
      runtimePolicy: _runtimePolicy,
      mcpServers: _mcpServers,
      acpMcpServers: _acpMcpServers,
      ...input
    }) => {
      const start = Effect.gen(function* () {
        const connection = yield* options.connector.connect(input.cwd);
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...input,
            spawn: {
              command: options.settings.binaryPath || "hoplite",
              args: ["acp"],
              cwd: input.cwd,
              env: hopliteAcpEnvironment(connection),
            },
            // With a key in the environment the CLI answers this itself instead of opening a browser.
            authMethodId: "hoplite-login",
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      });
      return options.withAccess === undefined
        ? start
        : options.withAccess(start).pipe(
            Effect.catchTags({
              ProviderSetupError: (error) =>
                Effect.fail(
                  new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: error.detail }),
                ),
            }),
          );
    },
    promptFailure: (cause) => {
      if (!isAcpRequestError(cause)) return makeProviderFailure({ cause, class: "provider_error" });
      const credits = insufficientCredits(cause.data);
      return makeProviderFailure({
        cause,
        code: String(cause.code),
        ...(credits
          ? {
              class: "usage_limit",
              message: `Your Hoplite workspace is out of credits. Add credits at ${credits.billingUrl ?? "https://app.hoplite.sh/settings/workspace/billing"}.`,
            }
          : { class: "provider_error", message: cause.errorMessage }),
      });
    },
  };
}

export const makeHopliteAdapterV2 = (options: HopliteAdapterV2Options) =>
  makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHopliteAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });

export type HopliteAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/** Builds the adapter around an instance's connector, shared with its driver's auth and status. */
export const makeHopliteAdapterForInstance = Effect.fn("makeHopliteAdapterForInstance")(
  function* (input: {
    readonly instanceId: HopliteAdapterV2Options["instanceId"];
    readonly settings: HopliteSettings;
    readonly connector: HopliteConnector;
    readonly withAccess?: ProviderAuthController["withAccess"];
  }) {
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeHopliteAdapterV2({
      ...input,
      selfInvocation: yield* resolveSelfInvocation(),
      continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: HOPLITE_PROVIDER,
          threadId,
        }),
    });
  },
);

export const HopliteAdapterV2Driver: ProviderAdapterDriver<
  HopliteSettings,
  HopliteAdapterV2DriverEnv
> = {
  driverKind: HOPLITE_PROVIDER,
  configSchema: HopliteSettings,
  defaultConfig: (): HopliteSettings => DEFAULT_HOPLITE_SETTINGS,
  create: Effect.fn("HopliteAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HopliteSettings>) {
      const settings = { ...input.config, enabled: input.enabled };
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        yield* HostProcess.Environment,
      );
      const connector = yield* makeHopliteConnector({
        instanceId: input.instanceId,
        settings,
        environment,
      });
      return yield* makeHopliteAdapterForInstance({
        instanceId: input.instanceId,
        settings,
        connector,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HOPLITE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Hoplite ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
