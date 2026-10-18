import { type ProviderOptionDescriptor, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { HopliteSettings } from "../settings.ts";
import { hopliteAcpEnvironment, type HopliteConnector } from "./connection.ts";

const HOPLITE_PRESENTATION = {
  displayName: "Hoplite",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportedRuntimeModes: ["approval-required"],
} as const;

const DOCUMENTATION_URL = "https://hoplite.sh/docs/cli";
const CATALOG_TTL_MS = 15 * 60_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

function selectOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  id: string,
): SelectConfigOption | undefined {
  return configOptions.find(
    (option): option is SelectConfigOption => option.type === "select" && option.id === id,
  );
}

function choices(option: SelectConfigOption) {
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

const CHOICE_LABELS: Record<string, string> = { xhigh: "Extra high" };
const choiceLabel = (value: string) =>
  CHOICE_LABELS[value] ?? `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

function selectDescriptor(
  option: SelectConfigOption,
  label: string,
  defaultValue: unknown,
): ProviderOptionDescriptor {
  return {
    id: option.id,
    label,
    type: "select",
    options: choices(option).map((choice) => ({
      id: choice.value,
      label: choiceLabel(choice.value),
      ...(choice.value === defaultValue ? { isDefault: true } : {}),
    })),
    ...(typeof defaultValue === "string" ? { currentValue: defaultValue } : {}),
  };
}

const VENDOR_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["claude-", "Anthropic"],
  ["gpt-", "OpenAI"],
  ["grok-", "xAI"],
  ["google/", "Google"],
  ["moonshotai/", "Moonshot AI"],
  ["z-ai/", "Z.ai"],
  ["mistralai/", "Mistral"],
  ["deepseek/", "DeepSeek"],
];

/**
 * Hoplite's ACP session advertises the models the workspace's plan offers, the
 * reasoning levels and whether a model has a fast tier, under the option IDs
 * the shared ACP adapter writes back unchanged.
 */
export function hopliteModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const model = selectOption(configOptions, "model");
  if (!model) return [];
  const reasoning = selectOption(configOptions, "reasoning");
  const speed = selectOption(configOptions, "speed");
  const reasoningMeta = reasoning?._meta?.hoplite as { defaultValue?: unknown } | undefined;
  const reasoningDescriptor = reasoning
    ? selectDescriptor(
        reasoning,
        "Reasoning",
        reasoningMeta?.defaultValue ?? reasoning.currentValue,
      )
    : undefined;
  const speedDescriptor = speed ? selectDescriptor(speed, "Speed", "standard") : undefined;
  return choices(model).map((choice) => {
    const supportsFast =
      (choice._meta?.hoplite as { supportsFast?: unknown } | undefined)?.supportsFast === true;
    const descriptors = [
      ...(reasoningDescriptor ? [reasoningDescriptor] : []),
      ...(supportsFast && speedDescriptor ? [speedDescriptor] : []),
    ];
    const vendor = VENDOR_PREFIXES.find(([prefix]) => choice.value.startsWith(prefix))?.[1];
    return {
      slug: choice.value,
      name: choice.name,
      ...(vendor ? { subProvider: vendor } : {}),
      isCustom: false,
      ...(choice.value === model.currentValue ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors: descriptors }),
    };
  });
}

const probeVersion = (settings: HopliteSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "hoplite";
    const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
    return result.code === 0 ? parseGenericCliVersion(result.stdout) : null;
  }).pipe(Effect.timeout("5 seconds"));

/**
 * `session/new` only allocates an ID; Hoplite creates the thread on the first
 * prompt, so this reads the catalog without leaving anything behind.
 */
const probeCatalog = (input: {
  readonly settings: HopliteSettings;
  readonly connector: HopliteConnector;
  readonly apiKey: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: input.settings.binaryPath || "hoplite",
          args: ["acp"],
          cwd: input.cwd,
          env: hopliteAcpEnvironment({
            apiBaseUrl: input.connector.apiBaseUrl,
            apiKey: input.apiKey,
            projectId: input.projectId,
            environment: input.environment,
          }),
        },
        cwd: input.cwd,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "hoplite-login",
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(Crypto.Crypto, crypto),
          ),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    const started = yield* runtime.start();
    return hopliteModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []);
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"));

export const buildInitialHopliteSnapshot = (settings: HopliteSettings) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return withSetup(
      buildServerProvider({
        presentation: HOPLITE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? "Checking the Hoplite CLI…"
            : "Hoplite is disabled in T3 Code settings.",
        },
      }),
      false,
    );
  });

function withSetup(draft: ServerProviderDraft, installed: boolean): ServerProviderDraft {
  return {
    ...draft,
    // Hoplite turns run on Hoplite credits; T3's titles and commit messages stay on local providers.
    supportsTextGeneration: false,
    setup: { canAuthenticate: installed, canInstall: false, documentationUrl: DOCUMENTATION_URL },
  };
}

export const makeHopliteStatusCheck = Effect.fn("makeHopliteStatusCheck")(function* (input: {
  readonly settings: HopliteSettings;
  readonly connector: HopliteConnector;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { settings, connector } = input;
  const catalogCache = yield* Ref.make<
    | {
        readonly apiKey: string;
        readonly at: number;
        readonly models: ReadonlyArray<ServerProviderModel>;
      }
    | undefined
  >(undefined);

  const readCatalog = Effect.fnUntraced(function* (apiKey: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(catalogCache);
    if (cached?.apiKey === apiKey && now - cached.at < CATALOG_TTL_MS) return cached.models;
    const projects = yield* connector.listProjects(apiKey);
    const project =
      projects.find((candidate) => candidate.id === settings.projectId.trim()) ?? projects[0];
    if (!project) return [];
    const models = yield* probeCatalog({
      settings,
      connector,
      apiKey,
      projectId: project.id,
      cwd: input.cwd,
      environment: input.environment,
    });
    if (models.length > 0) yield* Ref.set(catalogCache, { apiKey, at: now, models });
    return models;
  });

  const checkProvider = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const snapshot = (
      installed: boolean,
      probe: Omit<ProviderProbeResult, "installed">,
      models: ReadonlyArray<ServerProviderModel> = [],
    ) =>
      withSetup(
        buildServerProvider({
          presentation: HOPLITE_PRESENTATION,
          enabled: settings.enabled,
          checkedAt,
          models: providerModelsFromSettings(models, settings.customModels, EMPTY_CAPABILITIES),
          probe: { ...probe, installed },
        }),
        installed,
      );

    if (!settings.enabled) {
      return snapshot(false, {
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hoplite is disabled in T3 Code settings.",
      });
    }
    if ((yield* HostProcess.Platform) === "win32") {
      return snapshot(false, {
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hoplite's agent runs on macOS and Linux.",
      });
    }

    const version = yield* probeVersion(settings, input.environment).pipe(Effect.result);
    if (version._tag === "Failure" || version.success === null) {
      const missing = version._tag === "Failure" && isCommandMissingCause(version.failure);
      return snapshot(false, {
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Install the Hoplite CLI with `npm i -g @usehoplite/cli`, then refresh."
          : "Could not run the Hoplite CLI. Check its path in provider settings.",
      });
    }

    const apiKey = yield* connector.keys.read;
    if (!apiKey) {
      return snapshot(true, {
        version: version.success,
        status: "warning",
        auth: { status: "unauthenticated", canLogout: false },
        message: "Sign in with Hoplite or add an API key to start cloud threads.",
      });
    }

    const api = yield* connector.api(apiKey);
    const verified = yield* api.verify.pipe(Effect.result);
    if (verified._tag === "Failure") {
      return snapshot(true, {
        version: version.success,
        status: "warning",
        auth: {
          status: verified.failure.reason === "rejected" ? "unauthenticated" : "unknown",
          canLogout: true,
        },
        message: verified.failure.detail,
      });
    }

    const plan = yield* api.readPlan.pipe(Effect.option);
    const catalog = yield* readCatalog(apiKey).pipe(Effect.result);
    const models = catalog._tag === "Success" ? catalog.success : [];
    return snapshot(
      true,
      {
        version: version.success,
        status: catalog._tag === "Success" ? "ready" : "warning",
        auth: {
          status: "authenticated",
          canLogout: true,
          workspaceId: verified.success.orgId,
          ...(plan._tag === "Some" ? { label: `${choiceLabel(plan.value)} plan` } : {}),
        },
        ...(catalog._tag === "Failure"
          ? {
              message: "Signed in, but Hoplite's model list could not be loaded. Refresh to retry.",
            }
          : models.length === 0
            ? {
                message:
                  "Create a Hoplite project for a GitHub repository at app.hoplite.sh to start threads.",
              }
            : {}),
      },
      models,
    );
  });
  return { checkProvider };
});
