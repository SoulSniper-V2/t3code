// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  NodeId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type CommandCodeSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";

import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  CommandCodeProviderCapabilitiesV2,
  makeCommandCodeAdapterV2,
} from "./CommandCodeAdapterV2.ts";
import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";

const MOCK_AGENT_PATH = NodeURL.fileURLToPath(
  new URL(
    "../../provider/testFixtures/commandCodeHeadless/commandcode-v2-mock-agent.cjs",
    import.meta.url,
  ),
);
const CommandCodeAdapterV2TestLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer);

function prepareMockHarness(mode: "success" | "tools" | "error" | "hang" = "success") {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cc-v2-adapter-"));
  const logPath = NodePath.join(cwd, "invocations.jsonl");
  const isWindows = HostProcessPlatform.defaultValue() === "win32";
  const binaryPath = NodePath.join(cwd, isWindows ? "command-code.cmd" : "command-code");
  NodeFS.writeFileSync(
    binaryPath,
    isWindows
      ? `@echo off\r\nnode "${MOCK_AGENT_PATH}" %*\r\n`
      : `#!/usr/bin/env sh\nexec node '${MOCK_AGENT_PATH.replaceAll("'", "'\"'\"'")}' "$@"\n`,
  );
  if (!isWindows) NodeFS.chmodSync(binaryPath, 0o755);
  return { cwd, logPath, binaryPath, mode };
}

function readInvocations(path: string): Array<{
  argv: string[];
  prompt: string;
  modPath?: string | null;
  modExistsDuringTurn?: boolean;
  modContainsAuthorization?: boolean;
  mcpEndpointPresent?: boolean;
  mcpAuthorizationPresent?: boolean;
}> {
  return NodeFS.readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          argv: string[];
          prompt: string;
          modPath?: string | null;
          modExistsDuringTurn?: boolean;
          modContainsAuthorization?: boolean;
          mcpEndpointPresent?: boolean;
          mcpAuthorizationPresent?: boolean;
        },
    );
}

function makeSettings(binaryPath: string): CommandCodeSettings {
  return {
    enabled: true,
    binaryPath,
    permissionMode: "auto-accept",
    launchArgs: "--verbose",
    customModels: [],
  } as unknown as CommandCodeSettings;
}

function makeTurnInput(input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attemptNumber: number;
  readonly reasoningEffort?: string | undefined;
}): ProviderAdapterV2TurnInput {
  const attemptId = RunAttemptId.make(`attempt-${input.attemptNumber}`);
  return {
    appThread: {} as never,
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptNumber}`),
    runOrdinal: input.attemptNumber,
    providerTurnOrdinal: input.attemptNumber,
    attemptId,
    rootNodeId: NodeId.make(`root-${input.attemptNumber}`),
    providerThread: input.providerThread,
    message: {
      messageId: MessageId.make(`message-${input.attemptNumber}`),
      text: `prompt ${input.attemptNumber}`,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: undefined,
      senderThreadId: undefined,
    },
    modelSelection: {
      instanceId: input.instanceId,
      model: "deepseek/deepseek-v4-flash",
      ...(input.reasoningEffort === undefined
        ? {}
        : { options: [{ id: "effort", value: input.reasoningEffort }] }),
    },
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: null,
      approvalPolicy: "never",
      sandboxPolicy: "danger-full-access",
    },
  };
}

function collectThroughTerminal(
  events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>,
) {
  return Stream.runCollect(
    events.pipe(Stream.takeUntil((event) => event.type === "turn.terminal")),
  ).pipe(Effect.map((items) => Array.from(items)));
}

it.layer(CommandCodeAdapterV2TestLayer)("CommandCodeAdapterV2 (mock CLI)", (it) => {
  it.effect("streams V2 artifacts and resumes the native Command Code session", () =>
    Effect.gen(function* () {
      const harness = prepareMockHarness("tools");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("command-code-v2-test");
      const threadId = ThreadId.make("thread-command-code-v2");
      const idAllocator = yield* IdAllocatorV2;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const adapter = makeCommandCodeAdapterV2(makeSettings(harness.binaryPath), {
        instanceId,
        environment: {
          ...process.env,
          T3_CC_V2_LOG: harness.logPath,
          T3_CC_V2_MODE: harness.mode,
        },
        spawner,
        idAllocator,
        serverConfig: { cwd: harness.cwd, attachmentsDir: harness.cwd } as never,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-command-code-v2"),
        modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: harness.cwd,
          approvalPolicy: "never",
          sandboxPolicy: "danger-full-access",
        },
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: harness.cwd,
          approvalPolicy: "never",
          sandboxPolicy: "danger-full-access",
        },
      });

      const firstEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
      yield* runtime.startTurn(
        makeTurnInput({
          instanceId,
          threadId,
          providerThread,
          attemptNumber: 1,
          reasoningEffort: "high",
        }),
      );
      const firstEvents = yield* Fiber.join(firstEventsFiber);
      const firstTerminal = firstEvents.find((event) => event.type === "turn.terminal");
      expect(firstTerminal?.type).toBe("turn.terminal");
      if (firstTerminal?.type !== "turn.terminal") throw new Error("missing terminal event");
      expect(firstTerminal.status).toBe("completed");
      expect(
        firstEvents.some(
          (event) => event.type === "message.updated" && event.message.text === "V2 says hi",
        ),
      ).toBe(true);
      expect(
        firstEvents.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        ),
      ).toBe(true);
      const storedThread = firstEvents.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      expect(storedThread?.type).toBe("provider_thread.updated");
      if (storedThread?.type !== "provider_thread.updated")
        throw new Error("missing provider thread update");
      expect(storedThread.providerThread.nativeThreadRef?.nativeId).toBe("cc-v2-session-1");

      const secondEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
      yield* runtime.startTurn(
        makeTurnInput({
          instanceId,
          threadId,
          providerThread: storedThread.providerThread,
          attemptNumber: 2,
        }),
      );
      const secondEvents = yield* Fiber.join(secondEventsFiber);
      expect(
        secondEvents.some(
          (event) => event.type === "turn.terminal" && event.status === "completed",
        ),
      ).toBe(true);

      const calls = readInvocations(harness.logPath);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain(
        "You are running inside T3 Code through the Command Code harness, as deepseek/deepseek-v4-flash with high reasoning effort",
      );
      expect(calls[0]?.prompt.endsWith("\n\nprompt 1")).toBe(true);
      expect(calls[1]?.prompt).toContain(
        "You are running inside T3 Code through the Command Code harness, as deepseek/deepseek-v4-flash.",
      );
      expect(calls[1]?.prompt.endsWith("\n\nprompt 2")).toBe(true);
      expect(calls[0]?.argv).toContain("--yolo");
      expect(calls[0]?.argv).toContain("--model");
      expect(calls[0]?.argv).toContain("--verbose");
      expect(calls[0]?.argv).toContain("--effort");
      expect(calls[0]?.argv).toContain("high");
      expect(calls[1]?.argv).toContain("--resume");
      expect(calls[1]?.argv).toContain("cc-v2-session-1");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "uses a private per-turn mod for the active T3 MCP session and cleans it after success or failure",
    () =>
      Effect.gen(function* () {
        const harness = prepareMockHarness("success");
        const instanceId = ProviderInstanceId.make("command-code-v2-mcp");
        const threadId = ThreadId.make("thread-command-code-v2-mcp");
        const environment = {
          ...process.env,
          T3_CC_V2_LOG: harness.logPath,
          T3_CC_V2_MODE: "success",
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            McpProviderSession.clearMcpProviderSession(threadId);
            NodeFS.rmSync(harness.cwd, { recursive: true, force: true });
          }),
        );
        const mcpSession = (providerInstanceId: ProviderInstanceId) => ({
          environmentId: EnvironmentId.make("command-code-v2-mcp-test"),
          threadId,
          providerSessionId: "mcp-session-v2-test",
          providerInstanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer command-code-v2-test-token",
          browserToolsAvailable: false,
          capabilities: new Set(["threads"]),
        });
        McpProviderSession.setMcpProviderSession(
          mcpSession(ProviderInstanceId.make("another-provider-instance")),
        );
        const idAllocator = yield* IdAllocatorV2;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const adapter = makeCommandCodeAdapterV2(makeSettings(harness.binaryPath), {
          instanceId,
          environment,
          spawner,
          idAllocator,
          serverConfig: { cwd: harness.cwd, attachmentsDir: harness.cwd } as never,
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-command-code-v2-mcp"),
          modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: harness.cwd,
            approvalPolicy: "never",
            sandboxPolicy: "danger-full-access",
          },
        });
        let providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: harness.cwd,
            approvalPolicy: "never",
            sandboxPolicy: "danger-full-access",
          },
        });

        const firstEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
        yield* runtime.startTurn(
          makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 1 }),
        );
        const firstEvents = yield* Fiber.join(firstEventsFiber);
        expect(
          firstEvents.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        ).toBe(true);
        const firstStoredThread = firstEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        if (firstStoredThread?.type !== "provider_thread.updated")
          throw new Error("missing Command Code MCP provider-thread update");
        providerThread = firstStoredThread.providerThread;

        const withoutMcp = readInvocations(harness.logPath)[0];
        expect(withoutMcp?.argv).not.toContain("--mod");
        expect(withoutMcp?.mcpEndpointPresent).toBe(false);
        expect(withoutMcp?.mcpAuthorizationPresent).toBe(false);

        McpProviderSession.setMcpProviderSession(mcpSession(instanceId));
        const secondEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
        yield* runtime.startTurn(
          makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 2 }),
        );
        const secondEvents = yield* Fiber.join(secondEventsFiber);
        expect(
          secondEvents.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        ).toBe(true);
        const secondStoredThread = secondEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        if (secondStoredThread?.type !== "provider_thread.updated")
          throw new Error("missing Command Code MCP provider-thread update after success");
        providerThread = secondStoredThread.providerThread;

        environment.T3_CC_V2_MODE = "error";
        const thirdEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
        yield* runtime.startTurn(
          makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 3 }),
        );
        const thirdEvents = yield* Fiber.join(thirdEventsFiber);
        expect(
          thirdEvents.some((event) => event.type === "turn.terminal" && event.status === "failed"),
        ).toBe(true);

        McpProviderSession.clearMcpProviderSession(threadId);
        environment.T3_CC_V2_MODE = "success";
        const fourthEventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
        yield* runtime.startTurn(
          makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 4 }),
        );
        const fourthEvents = yield* Fiber.join(fourthEventsFiber);
        expect(
          fourthEvents.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        ).toBe(true);

        const calls = readInvocations(harness.logPath);
        expect(calls).toHaveLength(4);
        expect(calls[0]?.argv).not.toContain("--mod");
        expect(calls[0]?.mcpEndpointPresent).toBe(false);
        expect(calls[0]?.mcpAuthorizationPresent).toBe(false);
        for (const call of calls.slice(1, 3)) {
          expect(call.argv).toContain("--mod");
          expect(call.modPath).toBeTruthy();
          expect(call.modExistsDuringTurn).toBe(true);
          expect(call.modContainsAuthorization).toBe(false);
          expect(call.mcpEndpointPresent).toBe(true);
          expect(call.mcpAuthorizationPresent).toBe(true);
          expect(NodeFS.existsSync(call.modPath!)).toBe(false);
        }
        expect(calls[3]?.argv).not.toContain("--mod");
        expect(calls[3]?.mcpEndpointPresent).toBe(false);
        expect(calls[3]?.mcpAuthorizationPresent).toBe(false);

        const capabilities = yield* adapter.getCapabilities();
        expect(capabilities.tools.supportsMcpTools).toBe(true);
        expect(capabilities.tools.supportsDynamicToolCallbacks).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("maps a nonzero CLI result to a failed terminal event and error item", () =>
    Effect.gen(function* () {
      const harness = prepareMockHarness("error");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("command-code-v2-error");
      const threadId = ThreadId.make("thread-command-code-v2-error");
      const idAllocator = yield* IdAllocatorV2;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const adapter = makeCommandCodeAdapterV2(makeSettings(harness.binaryPath), {
        instanceId,
        environment: { ...process.env, T3_CC_V2_MODE: harness.mode },
        spawner,
        idAllocator,
        serverConfig: { cwd: harness.cwd, attachmentsDir: harness.cwd } as never,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-command-code-v2-error"),
        modelSelection: { instanceId, model: "model" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: harness.cwd },
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: { instanceId, model: "model" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: harness.cwd },
      });
      const eventsFiber = yield* Effect.forkScoped(collectThroughTerminal(runtime.events));
      yield* runtime.startTurn(
        makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 1 }),
      );
      const events = yield* Fiber.join(eventsFiber);
      expect(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.failure.class === "provider_error",
        ),
      ).toBe(true);
      expect(
        events.some((event) => event.type === "turn.terminal" && event.status === "failed"),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an active subprocess and does not advertise unsupported operations", () =>
    Effect.gen(function* () {
      const harness = prepareMockHarness("hang");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("command-code-v2-interrupt");
      const threadId = ThreadId.make("thread-command-code-v2-interrupt");
      const idAllocator = yield* IdAllocatorV2;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const adapter = makeCommandCodeAdapterV2(makeSettings(harness.binaryPath), {
        instanceId,
        environment: { ...process.env, T3_CC_V2_MODE: harness.mode },
        spawner,
        idAllocator,
        serverConfig: { cwd: harness.cwd, attachmentsDir: harness.cwd } as never,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-command-code-v2-interrupt"),
        modelSelection: { instanceId, model: "model" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: harness.cwd },
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: { instanceId, model: "model" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: harness.cwd },
      });
      const turn = makeTurnInput({ instanceId, threadId, providerThread, attemptNumber: 3 });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ProviderDriverKind.make("commandCode"),
        nativeTurnId: String(turn.attemptId),
      });
      const firstEventsFiber = yield* Effect.forkScoped(
        Stream.runCollect(
          runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.text === "V2 says hi",
            ),
          ),
        ).pipe(Effect.map((items) => Array.from(items))),
      );
      yield* runtime.startTurn(turn);
      const firstEvents = yield* Fiber.join(firstEventsFiber);
      expect(
        firstEvents.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        ),
      ).toBe(true);
      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      const events = yield* collectThroughTerminal(runtime.events);
      expect(
        events.some((event) => event.type === "turn.terminal" && event.status === "interrupted"),
      ).toBe(true);

      const capabilities = yield* adapter.getCapabilities();
      expect(capabilities.threads.canReadThreadSnapshot).toBe(false);
      expect(capabilities.threads.canRollbackThread).toBe(false);
      expect(capabilities.threads.canForkThread).toBe(false);
      expect(capabilities.approvals.supportsCommandApproval).toBe(false);
      expect(CommandCodeProviderCapabilitiesV2.tools.supportsMcpTools).toBe(true);
      expect(CommandCodeProviderCapabilitiesV2.tools.supportsDynamicToolCallbacks).toBe(true);
    }).pipe(Effect.scoped),
  );
});
