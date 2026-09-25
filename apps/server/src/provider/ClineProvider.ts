// @effect-diagnostics nodeBuiltinImport:off - resolveClineDataDir joins a
// pure path outside the Effect Path service so it stays unit-testable.
/**
 * ClineProvider — status probes and the per-instance snapshot holder for the
 * Cline driver.
 * Three cheap local probes, no auth side effects:
 * - `cline --version` proves the binary answers (installed + version).
 * - `providers.json` under the Cline data dir reports the last-used provider,
 *   configured model, and whether any credential marker (`tokenSource`,
 *   `apiKey`) is stored. Keys themselves never leave the parser.
 * - `cline history --json --limit 50` supplements the currently configured
 *   model, since Cline has no model-catalog command.
 *
 * @module provider/ClineProvider
 */
import type {
  ClineSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { CLINE_HISTORY_ARGS, CLINE_VERSION_ARGS } from "./clineLaunchArgs.ts";
import {
  isUnresolvedClineModel,
  parseClineHistoryModels,
  type ClineConfiguredModel,
} from "./clineModels.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import {
  buildServerProvider,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const UNKNOWN_AUTH: ServerProviderAuth = { status: "unknown" };

const checkedAtEffect = Effect.map(DateTime.now, DateTime.formatIso);

/** `cline --version` prints a bare semver (`3.0.62`). */
export function parseClineVersion(output: string): string | null {
  const match = output.trim().match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

/**
 * Resolve Cline's data directory using the same precedence as its CLI:
 * `CLINE_DATA_DIR`, then `CLINE_DIR/data`, then `HOME/.cline/data`.
 */
export function resolveClineDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env["CLINE_DATA_DIR"]?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const configuredClineDir = env["CLINE_DIR"]?.trim();
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim() || homeDir;
  return NodePath.join(
    configuredClineDir && configuredClineDir.length > 0
      ? configuredClineDir
      : NodePath.join(home, ".cline"),
    "data",
  );
}

export interface ClineCredentialSummary {
  readonly authenticated: boolean;
  readonly providerId: string | null;
}

export interface ClineProviderSettingsSummary extends ClineCredentialSummary {
  readonly configuredModel: ClineConfiguredModel | null;
}

function hasCredentialMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const tokenSource = record["tokenSource"];
  if (typeof tokenSource === "string" && tokenSource.trim().length > 0) return true;
  const settings = record["settings"];
  if (typeof settings !== "object" || settings === null) return false;
  const settingsRecord = settings as Record<string, unknown>;
  return (
    (typeof settingsRecord["apiKey"] === "string" &&
      (settingsRecord["apiKey"] as string).trim().length > 0) ||
    (typeof settingsRecord["auth"] === "string" &&
      (settingsRecord["auth"] as string).trim().length > 0)
  );
}

/**
 * Read-only credential summary from the CLI's own `providers.json`. Never
 * throws: a missing or unparsable file simply reports unauthenticated.
 */
export function readClineProviderSettingsSummary(
  providersJson: string,
): ClineProviderSettingsSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(providersJson);
  } catch {
    return { authenticated: false, providerId: null, configuredModel: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { authenticated: false, providerId: null, configuredModel: null };
  }
  const root = parsed as Record<string, unknown>;
  const providers = root["providers"];
  if (typeof providers !== "object" || providers === null) {
    return { authenticated: false, providerId: null, configuredModel: null };
  }
  const lastUsed =
    typeof root["lastUsedProvider"] === "string" ? (root["lastUsedProvider"] as string) : null;
  const entries = providers as Record<string, unknown>;
  const lastUsedEntry = lastUsed === null ? undefined : entries[lastUsed];
  const lastUsedSettings =
    typeof lastUsedEntry === "object" && lastUsedEntry !== null
      ? (lastUsedEntry as Record<string, unknown>)["settings"]
      : undefined;
  const modelValue =
    typeof lastUsedSettings === "object" && lastUsedSettings !== null
      ? ((lastUsedSettings as Record<string, unknown>)["model"] ??
        (lastUsedSettings as Record<string, unknown>)["modelId"])
      : undefined;
  const configuredModel =
    lastUsed !== null &&
    typeof modelValue === "string" &&
    modelValue.trim().length > 0 &&
    !isUnresolvedClineModel(modelValue.trim())
      ? { providerId: lastUsed, modelId: modelValue.trim() }
      : null;

  if (lastUsed !== null && hasCredentialMarker(lastUsedEntry)) {
    return { authenticated: true, providerId: lastUsed, configuredModel };
  }
  for (const [providerId, entry] of Object.entries(entries)) {
    if (hasCredentialMarker(entry)) return { authenticated: true, providerId, configuredModel };
  }
  return { authenticated: false, providerId: lastUsed, configuredModel };
}

/** Read-only credential summary, kept as a small compatibility helper for callers/tests. */
export function readClineCredentialSummary(providersJson: string): ClineCredentialSummary {
  const { authenticated, providerId } = readClineProviderSettingsSummary(providersJson);
  return { authenticated, providerId };
}

const runClineCli = (binaryPath: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(binaryPath, [...args], { env, extendEnv: true });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
  });

/**
 * One-shot probe that never fails: a launch problem, a nonzero exit, or a
 * probe that stalls past the deadline becomes a synthetic `code: -1` result
 * so callers branch on data, not on the error channel.
 */
const probeClineCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runClineCli(binaryPath, args, env).pipe(
    Effect.timeoutOption("15 seconds"),
    Effect.map((attempt) =>
      Option.match(attempt, {
        onNone: () => ({
          stdout: "",
          stderr: "Cline probe timed out after 15 seconds.",
          code: -1,
        }),
        onSome: (result) => result,
      }),
    ),
    Effect.catch((error) => Effect.succeed({ stdout: "", stderr: String(error), code: -1 })),
  );

export interface ClineStatusCheckInput {
  readonly config: ClineSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

function notInstalledDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly binaryPath: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Cline" },
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: UNKNOWN_AUTH,
      message:
        `Cline CLI could not be started (looked for ${input.binaryPath}). ` +
        "Install the CLI so `cline` is available on PATH; setting a Binary path is optional.",
    },
  });
}

export function checkClineProvider(input: ClineStatusCheckInput) {
  return Effect.gen(function* () {
    const enabled = input.config.enabled;
    const checkedAt = yield* checkedAtEffect;

    if (!enabled) {
      return buildServerProvider({
        presentation: { displayName: "Cline" },
        enabled: false,
        checkedAt,
        models: [],
        probe: { installed: false, version: null, status: "error", auth: UNKNOWN_AUTH },
      });
    }

    const binaryPath = input.config.binaryPath || "cline";
    const versionRun = yield* probeClineCli(binaryPath, [...CLINE_VERSION_ARGS], input.env);
    if (versionRun.code !== 0) {
      return notInstalledDraft({ enabled, checkedAt, binaryPath });
    }

    const version = parseClineVersion(versionRun.stdout);
    if (version === null) {
      return buildServerProvider({
        presentation: { displayName: "Cline" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: UNKNOWN_AUTH,
          message: `Cline answered a --version probe without a version (stdout: ${
            versionRun.stdout.trim().slice(0, 200) || "<empty>"
          }).`,
        },
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveClineDataDir(input.env, input.homeDir);
    const providersPath = path.join(dataDir, "settings", "providers.json");
    const providerSettings = yield* fileSystem.readFileString(providersPath).pipe(
      Effect.map(readClineProviderSettingsSummary),
      Effect.orElseSucceed(() => readClineProviderSettingsSummary("")),
    );
    const auth: ServerProviderAuth = providerSettings.authenticated
      ? {
          status: "authenticated",
          ...(providerSettings.providerId !== null ? { label: providerSettings.providerId } : {}),
        }
      : { status: "unauthenticated" };

    const historyRun = yield* probeClineCli(binaryPath, [...CLINE_HISTORY_ARGS], input.env);
    const models: ReadonlyArray<ServerProviderModel> =
      historyRun.code === 0
        ? parseClineHistoryModels(
            historyRun.stdout,
            providerSettings.configuredModel ?? undefined,
            input.config.thinkingLevel,
          )
        : parseClineHistoryModels(
            "[]",
            providerSettings.configuredModel ?? undefined,
            input.config.thinkingLevel,
          );

    const setupMessage = !providerSettings.authenticated
      ? "Cline is installed, but no saved provider sign-in was found. Sign in or configure a provider in Cline; T3 uses that account without changing its credentials."
      : models.length === 0
        ? "Cline is installed, but its saved provider settings and recent history do not identify a model yet. Configure a model in Cline to make it selectable here."
        : undefined;

    return buildServerProvider({
      presentation: { displayName: "Cline" },
      enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth,
        ...(setupMessage !== undefined ? { message: setupMessage } : {}),
      },
    });
  });
}

function pendingClineProvider(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly message: string | undefined;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Cline" },
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: input.enabled,
      version: null,
      status: "warning",
      auth: UNKNOWN_AUTH,
      ...(input.message !== undefined ? { message: input.message } : {}),
    },
  });
}

export interface ClineSnapshotInput {
  readonly config: ClineSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly stamp: (draft: ServerProviderDraft) => ServerProvider;
  readonly displayName: string;
  readonly driverKind: ServerProvider["driver"];
}

/**
 * Minimal `ServerProviderShape` for Cline. The full managed-provider
 * machinery (installer ownership, update advisories) does not apply to a CLI
 * that self-updates, so this holder just runs the status probe on demand
 * and on settings-triggered recreation.
 */
export function makeClineSnapshotShape(input: ClineSnapshotInput) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const checkedAt = yield* checkedAtEffect;
    const pending = input.stamp(
      pendingClineProvider({
        enabled: input.config.enabled,
        checkedAt,
        message: input.config.enabled ? "Checking Cline…" : undefined,
      }),
    );
    const state = yield* Ref.make<ServerProvider>(pending);

    const publish = (next: ServerProvider): Effect.Effect<void> =>
      Ref.modify(state, (current) => {
        if (Equal.equals(current, next)) {
          return [false, current] as const;
        }
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((changed) =>
          changed ? PubSub.publish(changes, next).pipe(Effect.asVoid) : Effect.void,
        ),
      );

    const refresh = Effect.gen(function* () {
      const draft = yield* checkClineProvider({
        config: input.config,
        env: input.env,
        homeDir: input.homeDir,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
      const next = input.stamp(draft);
      yield* publish(next);
      return next;
    });

    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: input.driverKind,
      packageName: null,
    });

    return {
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSnapshot: Ref.get(state),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      applyUsageLimits: () => Effect.void,
    } satisfies ServerProviderShape;
  });
}
