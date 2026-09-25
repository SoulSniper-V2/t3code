// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClineSettings,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "@effect/vitest";

import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { ClineProviderCapabilitiesV2, makeClineAdapterV2 } from "./ClineAdapterV2.ts";

const MOCK_AGENT_PATH = NodeURL.fileURLToPath(
  new URL("../../provider/testFixtures/clineHeadless/cline-mock-agent.cjs", import.meta.url),
);
const ClineAdapterV2TestLayer = Layer.merge(NodeServices.layer, idAllocatorLayer);

function makeMockHarness(): {
  readonly binaryPath: string;
  readonly argvLogPath: string;
  readonly cwd: string;
} {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cline-v2-"));
  const argvLogPath = NodePath.join(cwd, "argv.json");
  const binaryPath = NodePath.join(cwd, "cline");
  NodeFS.writeFileSync(
    binaryPath,
    `#!/usr/bin/env sh\nexec node '${MOCK_AGENT_PATH.replaceAll("'", "'\"'\"'")}' "$@"\n`,
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { binaryPath, argvLogPath, cwd };
}

function makeConfig(binaryPath: string): ClineSettings {
  return Schema.decodeSync(ClineSettings)({
    enabled: true,
    binaryPath,
    permissionMode: "auto-accept",
    thinkingLevel: "",
    launchArgs: "",
    customModels: [],
  });
}

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly cwd: string;
  readonly now: DateTime.Utc;
  readonly model?: string;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly text?: string;
  readonly turnOrdinal?: number;
}): ProviderAdapterV2TurnInput {
  const turnOrdinal = input.turnOrdinal ?? 1;
  const runId = RunId.make(`run:${input.threadId}:${turnOrdinal}`);
  const modelSelection = {
    instanceId: input.instanceId,
    model: input.model ?? "poolside/laguna-s-2.1:free",
  };
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "Cline V2 test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: input.runtimeMode ?? "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId,
    runOrdinal: turnOrdinal,
    providerTurnOrdinal: turnOrdinal,
    attemptId: RunAttemptId.make(`attempt:${input.threadId}:${turnOrdinal}`),
    rootNodeId: NodeId.make(`root:${input.threadId}:${turnOrdinal}`),
    providerThread: input.providerThread,
    message: {
      messageId: MessageId.make(`message:${input.threadId}:${turnOrdinal}`),
      createdBy: "user",
      creationSource: "web",
      text: input.text ?? "summarize the workspace",
      attachments: [],
    },
    modelSelection: {
      ...modelSelection,
      options: [
        { id: "thinking", value: "high" },
        { id: "provider", value: "cline" },
      ],
    },
    runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: input.runtimeMode ?? "approval-required",
      interactionMode: "default",
      cwd: input.cwd,
    }),
  };
}

it.layer(ClineAdapterV2TestLayer)("ClineAdapterV2 (headless protocol)", (it) => {
  it.effect("maps Cline NDJSON to V2 records and restricts auto-approve by runtime policy", () =>
    Effect.gen(function* () {
      const harness = makeMockHarness();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("cline-v2-test");
      const threadId = ThreadId.make("cline-v2-thread");
      const adapter = makeClineAdapterV2({
        instanceId,
        config: makeConfig(harness.binaryPath),
        environment: { ...process.env, T3_MOCK_ARGV_LOG: harness.argvLogPath },
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        idAllocator: yield* IdAllocatorV2,
        defaultCwd: harness.cwd,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cline-v2-session"),
        modelSelection: { instanceId, model: "poolside/laguna-s-2.1:free" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: harness.cwd,
        }),
      });
      let providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: { instanceId, model: "poolside/laguna-s-2.1:free" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: harness.cwd,
        }),
      });
      const now = yield* DateTime.now;
      const input = makeTurnInput({ threadId, instanceId, providerThread, cwd: harness.cwd, now });
      const eventFiber = yield* Effect.forkScoped(
        runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      yield* Effect.yieldNow;
      yield* runtime.startTurn(input);
      const events = yield* Fiber.join(eventFiber);
      const invocations = NodeFS.readFileSync(harness.argvLogPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { readonly argv: ReadonlyArray<string>; readonly prompt: string },
        );
      expect(invocations).toHaveLength(1);
      const argv = invocations[0]!;
      expect(argv.argv).toContain("--json");
      expect(argv.argv).toContain("--model");
      expect(argv.argv).toContain("poolside/laguna-s-2.1:free");
      expect(argv.argv).toContain("--provider");
      expect(argv.argv).toContain("cline");
      expect(argv.argv).toContain("--thinking");
      expect(argv.argv).toContain("high");
      expect(argv.argv).toContain("false");
      expect(argv.argv).not.toContain("--id");
      expect(argv.prompt).toBe("summarize the workspace");
      expect(
        events.some((event) => event.type === "message.updated" && event.message.text === "Hola"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        ),
      ).toBe(true);
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal?.type === "turn.terminal" ? terminal.status : undefined).toBe("completed");
      expect(ClineProviderCapabilitiesV2.threads.canReadThreadSnapshot).toBe(false);
      expect(ClineProviderCapabilitiesV2.tools.supportsMcpTools).toBe(false);
      expect(ClineProviderCapabilitiesV2.approvals.supportsCommandApproval).toBe(false);
      expect(
        yield* runtime.injectHistory!({
          providerThread,
          messages: [],
          context: "prior transcript",
        }),
      ).toBe(false);

      providerThread = events
        .filter(
          (event): event is Extract<typeof event, { readonly type: "provider_thread.updated" }> =>
            event.type === "provider_thread.updated",
        )
        .at(-1)!.providerThread;
      const secondEventsFiber = yield* Effect.forkScoped(
        runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      yield* Effect.yieldNow;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          instanceId,
          providerThread,
          cwd: harness.cwd,
          now,
          turnOrdinal: 2,
        }),
      );
      const secondEvents = yield* Fiber.join(secondEventsFiber);
      expect(
        secondEvents.some(
          (event) => event.type === "turn.terminal" && event.status === "completed",
        ),
      ).toBe(true);
      const invocationsAfterSecondTurn = NodeFS.readFileSync(harness.argvLogPath, "utf8")
        .trim()
        .split("\n");
      expect(invocationsAfterSecondTurn).toHaveLength(2);
      const argumentsByTurn = invocationsAfterSecondTurn.map(
        (line) => (JSON.parse(line) as { readonly argv: ReadonlyArray<string> }).argv,
      );
      expect(
        argumentsByTurn.every(
          (turnArgs) => turnArgs.includes("--json") && !turnArgs.includes("--id"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels its active one-shot process and reports the interrupted terminal", () =>
    Effect.gen(function* () {
      const harness = makeMockHarness();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("cline-v2-cancel");
      const threadId = ThreadId.make("cline-v2-cancel-thread");
      const adapter = makeClineAdapterV2({
        instanceId,
        config: makeConfig(harness.binaryPath),
        environment: { ...process.env, T3_MOCK_HANG: "1" },
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        idAllocator: yield* IdAllocatorV2,
        defaultCwd: harness.cwd,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cline-v2-cancel-session"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: harness.cwd,
        }),
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: harness.cwd,
        }),
      });
      const now = yield* DateTime.now;
      const input = makeTurnInput({
        threadId,
        instanceId,
        providerThread,
        cwd: harness.cwd,
        now,
        model: "default",
        runtimeMode: "full-access",
        text: "long running task",
      });
      const running = yield* Deferred.make<ProviderTurnId>();
      const terminal = yield* Deferred.make<"cancelled" | "interrupted" | "completed" | "failed">();
      yield* Effect.forkScoped(
        runtime.events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
              return Deferred.succeed(running, event.providerTurn.id).pipe(Effect.asVoid);
            }
            if (event.type === "turn.terminal") {
              return Deferred.succeed(terminal, event.status).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        ),
      );
      yield* Effect.yieldNow;
      const startFiber = yield* Effect.forkScoped(runtime.startTurn(input));
      const providerTurnId = yield* Deferred.await(running);
      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      expect(yield* Deferred.await(terminal)).toBe("interrupted");
      yield* Fiber.join(startFiber);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces CLI errors as a failed V2 terminal event", () =>
    Effect.gen(function* () {
      const harness = makeMockHarness();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("cline-v2-error");
      const threadId = ThreadId.make("cline-v2-error-thread");
      const adapter = makeClineAdapterV2({
        instanceId,
        config: makeConfig(harness.binaryPath),
        environment: { ...process.env, T3_MOCK_ERROR: "1" },
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        idAllocator: yield* IdAllocatorV2,
        defaultCwd: harness.cwd,
      });
      const policy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: harness.cwd,
      });
      const modelSelection = { instanceId, model: "default" };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cline-v2-error-session"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const eventFiber = yield* Effect.forkScoped(
        runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      yield* Effect.yieldNow;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, instanceId, providerThread, cwd: harness.cwd, now }),
      );
      const events = yield* Fiber.join(eventFiber);
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal?.type === "turn.terminal" ? terminal.status : undefined).toBe("failed");
      expect(
        terminal?.type === "turn.terminal" && terminal.status === "failed"
          ? terminal.failure.message
          : "",
      ).toBe("mock Cline provider failure");
    }).pipe(Effect.scoped),
  );
});
