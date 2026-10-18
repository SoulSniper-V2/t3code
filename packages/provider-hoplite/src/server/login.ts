import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

export interface HopliteDeviceLogin {
  readonly url: string;
  readonly userCode: string;
}

/** `hoplite login` prints "visit https://hoplite.sh/device?user_code=CODE" before it waits. */
export function parseHopliteDeviceLogin(output: string): HopliteDeviceLogin | undefined {
  const match = /(https:\/\/\S+\/device\?user_code=([A-Za-z0-9-]+))/.exec(output);
  return match?.[1] && match[2] ? { url: match[1], userCode: match[2] } : undefined;
}

const McpConfig = Schema.Struct({
  mcpServers: Schema.Struct({
    hoplite: Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
  }),
});
const decodeMcpConfig = Schema.decodeUnknownOption(Schema.fromJsonString(McpConfig));

/** `hoplite mcp config --inline-key` is the CLI's documented way to hand its stored key to another client. */
export function parseHopliteMcpConfigKey(stdout: string): string | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  const config = decodeMcpConfig(stdout.slice(start));
  if (config._tag === "None") return undefined;
  const headers = config.value.mcpServers.hoplite.headers;
  const key = headers.Authorization?.replace(/^Bearer\s+/i, "") ?? headers["X-Api-Key"];
  return key?.trim().startsWith("hop_") ? key.trim() : undefined;
}

/**
 * The CLI must read the key it just stored, never one inherited from the
 * server's environment, and must not open a browser on a remote host.
 */
export function hopliteLoginEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    HOPLITE_API_KEY: _apiKey,
    HOPLITE_ACP_API_KEY: _acpApiKey,
    HOPLITE_ACP_URL: _acpUrl,
    ...rest
  } = environment;
  return { ...rest, NO_BROWSER: "1", HOPLITE_NO_UPDATE_CHECK: "1" };
}

/**
 * The CLI keeps one credential store per machine, so two instances signing in
 * at once could each export the other's key. One sign-in runs at a time.
 */
const cliSignInLock = Semaphore.makeUnsafe(1);

/**
 * Runs the official CLI's browser sign-in, then exports the key it minted so
 * T3 can store it per instance like a pasted API key.
 */
export const signInWithHopliteCli = (input: Parameters<typeof runCliSignIn>[0]) =>
  cliSignInLock.withPermit(runCliSignIn(input));

const runCliSignIn = Effect.fn("signInWithHopliteCli")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onDeviceLogin: (login: HopliteDeviceLogin) => Effect.Effect<void>;
  readonly onVerifying: Effect.Effect<void>;
}) {
  const failure = (detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation: "start", detail, cause });
  const env = hopliteLoginEnvironment(input.environment);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = (args: ReadonlyArray<string>) =>
    resolveSpawnCommand(input.binaryPath, args, { env }).pipe(
      Effect.map((resolved) =>
        ChildProcess.make(resolved.command, resolved.args, { env, shell: resolved.shell }),
      ),
    );

  const login = yield* spawner
    .spawn(yield* command(["login"]))
    .pipe(
      Effect.mapError((cause) =>
        failure("Could not start the Hoplite CLI. Is it installed?", cause),
      ),
    );
  const output = yield* Ref.make("");
  const announced = yield* Ref.make(false);
  yield* Stream.decodeText(login.all).pipe(
    Stream.runForEach((chunk) =>
      Ref.updateAndGet(output, (text) => (text + chunk).slice(-16_384)).pipe(
        Effect.flatMap((text) => {
          const device = parseHopliteDeviceLogin(text);
          return device
            ? Ref.getAndSet(announced, true).pipe(
                Effect.flatMap((already) => (already ? Effect.void : input.onDeviceLogin(device))),
              )
            : Effect.void;
        }),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  const exitCode = Number(yield* login.exitCode.pipe(Effect.orElseSucceed(() => -1)));
  if (exitCode !== 0) {
    const text = yield* Ref.get(output);
    return yield* failure(
      /secure credential storage unavailable/i.test(text)
        ? "The Hoplite CLI needs a system keychain to sign in on this machine. Use an API key instead."
        : "Hoplite sign-in did not finish. Start again.",
    );
  }

  yield* input.onVerifying;
  const exported = yield* spawnAndCollect(
    input.binaryPath,
    yield* command(["mcp", "config", "--inline-key"]),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.orElseSucceed(() => undefined),
  );
  const apiKey = exported?.code === 0 ? parseHopliteMcpConfigKey(exported.stdout) : undefined;
  if (!apiKey)
    return yield* failure("Signed in, but the Hoplite CLI did not return a key. Try again.");
  return apiKey;
});
