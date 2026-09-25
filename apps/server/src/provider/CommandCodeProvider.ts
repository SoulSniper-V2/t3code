/**
 * CommandCodeProvider — status probes and the per-instance snapshot holder
 * for the Command Code driver.
 *
 * The snapshot uses bounded, read-only CLI probes for installation/version,
 * `status --json` authentication, the live model catalog, and public BYOK
 * reasoning metadata. It never reads or returns credential values.
 *
 * @module provider/CommandCodeProvider
 */
import type {
  CommandCodeSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  COMMAND_CODE_LIST_MODELS_ARGS,
  COMMAND_CODE_STATUS_ARGS,
  COMMAND_CODE_VERSION_ARGS,
} from "./commandCodeLaunchArgs.ts";
import { parseCommandCodeModelList, parseCommandCodeProvidersJson } from "./commandCodeModels.ts";
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

/** Version probe may start with an auto-update banner; the CLI version is the last semver. */
export function parseCommandCodeVersion(output: string): string | null {
  const matches = [...output.matchAll(/\b(\d+\.\d+\.\d+)\b/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

/**
 * `command-code status --json` is documented as the CLI's read-only auth
 * status probe. Only consume its explicit top-level boolean; keep unknown
 * output forward-compatible and never surface the raw identity/config data.
 */
export function parseCommandCodeAuthStatus(output: string): ServerProviderAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return UNKNOWN_AUTH;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["authenticated"] !== "boolean"
  ) {
    return UNKNOWN_AUTH;
  }
  return (parsed as Record<string, unknown>)["authenticated"] === true
    ? { status: "authenticated", type: "command-code" }
    : { status: "unauthenticated", type: "command-code" };
}

export function resolveCommandCodeHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homeDir;
}

const runCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) =>
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
const probeCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runCommandCodeCli(binaryPath, args, env).pipe(
    Effect.timeoutOption("15 seconds"),
    Effect.map((attempt) =>
      Option.match(attempt, {
        onNone: () => ({
          stdout: "",
          stderr: "Command Code probe timed out after 15 seconds.",
          code: -1,
        }),
        onSome: (result) => result,
      }),
    ),
    Effect.catch((error) => Effect.succeed({ stdout: "", stderr: String(error), code: -1 })),
  );

export interface CommandCodeStatusCheckInput {
  readonly config: CommandCodeSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

function notInstalledDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly binaryPath: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Command Code" },
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: UNKNOWN_AUTH,
      message:
        `Command Code CLI could not be started (looked for ${input.binaryPath}). ` +
        "Install it or set the Binary path in this instance's settings.",
    },
  });
}

export function checkCommandCodeProvider(input: CommandCodeStatusCheckInput) {
  return Effect.gen(function* () {
    const enabled = input.config.enabled;
    const checkedAt = yield* checkedAtEffect;

    if (!enabled) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled: false,
        checkedAt,
        models: [],
        probe: { installed: false, version: null, status: "error", auth: UNKNOWN_AUTH },
      });
    }

    const binaryPath = input.config.binaryPath || "command-code";
    const versionRun = yield* probeCommandCodeCli(binaryPath, COMMAND_CODE_VERSION_ARGS, input.env);
    // Any nonzero exit (including the -1 sentinel) means the CLI did not
    // answer cleanly; a wrapper that echoes a version then fails is not ready.
    if (versionRun.code !== 0) {
      return notInstalledDraft({ enabled, checkedAt, binaryPath });
    }

    const version = parseCommandCodeVersion(versionRun.stdout);
    if (version === null) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: UNKNOWN_AUTH,
          message: `Command Code answered a --version probe without a version (stdout: ${
            versionRun.stdout.trim().slice(0, 200) || "<empty>"
          }).`,
        },
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = resolveCommandCodeHome(input.env, input.homeDir);
    const [modelsRun, statusRun, providersJson] = yield* Effect.all(
      [
        probeCommandCodeCli(binaryPath, COMMAND_CODE_LIST_MODELS_ARGS, input.env),
        probeCommandCodeCli(binaryPath, COMMAND_CODE_STATUS_ARGS, input.env),
        fileSystem
          .readFileString(path.join(home, ".commandcode", "providers.json"))
          .pipe(Effect.orElseSucceed(() => "")),
      ],
      { concurrency: "unbounded" },
    );
    const auth = parseCommandCodeAuthStatus(statusRun.stdout);
    if (modelsRun.code !== 0) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version,
          status: "warning",
          auth,
          message:
            auth.status === "unauthenticated"
              ? "Command Code is installed, but no signed-in Command Code account was detected. Sign in there, or use a configured BYOK provider."
              : "Command Code is installed but its model list could not be read.",
        },
      });
    }

    const models: ReadonlyArray<ServerProviderModel> = parseCommandCodeModelList(
      modelsRun.stdout,
      parseCommandCodeProvidersJson(providersJson),
    );
    return buildServerProvider({
      presentation: { displayName: "Command Code" },
      enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: auth.status === "unauthenticated" ? "warning" : "ready",
        auth,
        ...(auth.status === "unauthenticated"
          ? {
              message:
                "Command Code is installed, but no signed-in Command Code account was detected. Sign in there, or use a configured BYOK provider.",
            }
          : {}),
      },
    });
  });
}

function pendingCommandCodeProvider(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly message: string | undefined;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Command Code" },
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

export interface CommandCodeSnapshotInput {
  readonly config: CommandCodeSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly stamp: (draft: ServerProviderDraft) => ServerProvider;
  readonly displayName: string;
  readonly driverKind: ServerProvider["driver"];
}

/**
 * Minimal `ServerProviderShape` for Command Code. The full managed-provider
 * machinery (installer ownership, update advisories, manifest refresh) does
 * not apply to a CLI that self-updates on launch, so this holder just runs
 * the status probe on demand and on settings-triggered recreation.
 */
export function makeCommandCodeSnapshotShape(input: CommandCodeSnapshotInput) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const checkedAt = yield* checkedAtEffect;
    const pending = input.stamp(
      pendingCommandCodeProvider({
        enabled: input.config.enabled,
        checkedAt,
        message: input.config.enabled ? "Checking Command Code…" : undefined,
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
      const draft = yield* checkCommandCodeProvider({
        config: input.config,
        env: input.env,
        homeDir: input.homeDir,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
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
