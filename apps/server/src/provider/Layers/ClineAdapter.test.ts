// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ClineSettings, ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import { makeClineAdapter } from "./ClineAdapter.ts";

const MOCK_AGENT_PATH = NodeURL.fileURLToPath(
  new URL("../testFixtures/clineHeadless/cline-mock-agent.cjs", import.meta.url),
);

const ClineAdapterTestLayer = NodeServices.layer;

function prepareMockHarness(): {
  readonly binaryPath: string;
  readonly argvLogPath: string;
  readonly cwd: string;
} {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cline-adapter-"));
  const argvLogPath = NodePath.join(cwd, "argv.json");
  const isWindows = HostProcessPlatform.defaultValue() === "win32";
  const binaryPath = NodePath.join(cwd, isWindows ? "cline.cmd" : "cline");
  NodeFS.writeFileSync(
    binaryPath,
    isWindows
      ? `@echo off\r\nnode "${MOCK_AGENT_PATH}" %*\r\n`
      : `#!/usr/bin/env sh\nexec node '${MOCK_AGENT_PATH.replaceAll("'", "'\"'\"'")}' "$@"\n`,
  );
  if (!isWindows) {
    NodeFS.chmodSync(binaryPath, 0o755);
  }
  return { binaryPath, argvLogPath, cwd };
}

function readArgvLog(path: string): { argv: string[]; prompt: string } {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as { argv: string[]; prompt: string };
}

function makeConfig(binaryPath: string): ClineSettings {
  return {
    enabled: true,
    binaryPath,
    permissionMode: "auto-accept",
    thinkingLevel: "",
    launchArgs: "",
    customModels: [],
  } as unknown as ClineSettings;
}

/** Run a scenario to its terminal runtime event and return every event seen. */
function collectN(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return Stream.runCollect(Stream.take(stream, count)).pipe(
    Effect.map((events) => Array.from(events)),
  );
}

it.layer(ClineAdapterTestLayer)("ClineAdapter (mock CLI)", (it) => {
  it.effect("runs a successful turn with text, tools, and usage", () =>
    Effect.gen(function* () {
      const harness = prepareMockHarness();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("clineTest");
      const threadId = ThreadId.make("thread-1");
      const adapter = yield* makeClineAdapter(makeConfig(harness.binaryPath), {
        driverKind: ProviderDriverKind.make("cline"),
        instanceId,
        environment: { ...process.env, T3_MOCK_ARGV_LOG: harness.argvLogPath },
      });
      yield* adapter.startSession({ threadId, cwd: harness.cwd, runtimeMode: "full-access" });

      const eventsFiber = yield* Effect.forkScoped(collectN(adapter.streamEvents, 8));
      // Let the collector subscribe to the pubsub before the turn emits.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId,
        input: "hola",
        modelSelection: { instanceId, model: "poolside/laguna-s-2.1:free" },
      });
      const events = yield* Fiber.join(eventsFiber);

      expect(events[0]?.type).toBe("turn.started");
      expect(events.some((event) => event.type === "item.started")).toBe(true);
      expect(
        events.some((event) => event.type === "content.delta" && event.payload.delta === "Hola"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            typeof event.itemId === "string" &&
            event.itemId.startsWith("tool-"),
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);

      // Headless JSON with explicit auto-approve and the requested model.
      const argv = readArgvLog(harness.argvLogPath);
      expect(argv.argv).toContain("--json");
      expect(argv.argv).toContain("--auto-approve");
      expect(argv.argv).toContain("true");
      expect(argv.argv).toContain("--model");
      expect(argv.prompt).toBe("hola");
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an in-flight turn and emits turn.aborted", () =>
    Effect.gen(function* () {
      const harness = prepareMockHarness();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("clineTest");
      const threadId = ThreadId.make("thread-interrupt");
      const adapter = yield* makeClineAdapter(makeConfig(harness.binaryPath), {
        driverKind: ProviderDriverKind.make("cline"),
        instanceId,
        environment: {
          ...process.env,
          T3_MOCK_ARGV_LOG: harness.argvLogPath,
          T3_MOCK_HANG: "1",
        },
      });
      yield* adapter.startSession({ threadId, cwd: harness.cwd, runtimeMode: "full-access" });

      const eventsFiber = yield* Effect.forkScoped(collectN(adapter.streamEvents, 5));
      const sendFiber = yield* Effect.forkScoped(
        adapter.sendTurn({ threadId, input: "tarea larga" }),
      );
      // Wait until the mock has emitted its first text chunk (the child
      // is running and holding), then interrupt it.
      yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "content.delta" && event.payload.delta === "Hola",
        ),
        Stream.runDrain,
      );
      yield* adapter.interruptTurn(threadId);

      yield* Fiber.join(sendFiber);
      const events = yield* Fiber.join(eventsFiber);
      expect(events.some((event) => event.type === "turn.started")).toBe(true);
      expect(events.at(-1)?.type).toBe("turn.aborted");
    }).pipe(Effect.scoped),
  );
});
