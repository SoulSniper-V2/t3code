// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ClineSettings,
  EnvironmentId,
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "@effect/vitest";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { ClineProviderCapabilitiesV2, makeClineAdapterV2 } from "./ClineAdapterV2.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);
const JsonString = Schema.fromJsonString(Schema.Unknown);
const decodeClineInvocation = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      argv: Schema.Array(Schema.String),
      prompt: Schema.String,
    }),
  ),
);

const MOCK_AGENT_PATH = NodeURL.fileURLToPath(
  new URL("../../provider/testFixtures/clineHeadless/cline-mock-agent.cjs", import.meta.url),
);
const ClineAdapterV2TestLayer = Layer.merge(NodeServices.layer, idAllocatorLayer);

function makeTestEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CLINE_MCP_SETTINGS_PATH;
  delete environment.CLINE_DATA_DIR;
  delete environment.CLINE_DIR;
  Object.assign(environment, overrides);
  return environment;
}

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
    `#!/usr/bin/env sh
if [ -n "\${T3_MOCK_MCP_CAPTURE_PATH:-}" ]; then
  if [ -n "\${CLINE_MCP_SETTINGS_PATH:-}" ]; then
    printf '%s\\n' "$CLINE_MCP_SETTINGS_PATH" >> "$T3_MOCK_MCP_CAPTURE_PATH"
    cat "$CLINE_MCP_SETTINGS_PATH" >> "$T3_MOCK_MCP_CAPTURE_PATH"
    printf '\\n' >> "$T3_MOCK_MCP_CAPTURE_PATH"
  else
    printf 'none\\n\\n' >> "$T3_MOCK_MCP_CAPTURE_PATH"
  fi
fi
exec node '${MOCK_AGENT_PATH.replaceAll("'", "'\"'\"'")}' "$@"
`,
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { binaryPath, argvLogPath, cwd };
}

function makeConfig(binaryPath: string): ClineSettings {
  return decodeClineSettings({
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
      const mcpCapturePath = NodePath.join(harness.cwd, "mcp-capture.log");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(harness.cwd, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("cline-v2-test");
      const threadId = ThreadId.make("cline-v2-thread");
      const adapter = makeClineAdapterV2({
        instanceId,
        config: makeConfig(harness.binaryPath),
        environment: makeTestEnvironment({
          T3_MOCK_ARGV_LOG: harness.argvLogPath,
          T3_MOCK_MCP_CAPTURE_PATH: mcpCapturePath,
        }),
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
        .map((line) => decodeClineInvocation(line));
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
      expect(argv.prompt).toContain("You are running inside T3 Code through the Cline harness");
      expect(argv.prompt.endsWith("summarize the workspace")).toBe(true);
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
      expect(ClineProviderCapabilitiesV2.tools.supportsMcpTools).toBe(true);
      expect(NodeFS.readFileSync(mcpCapturePath, "utf8")).toBe("none\n\n");
      expect(ClineProviderCapabilitiesV2.approvals.supportsCommandApproval).toBe(false);
      expect(
        yield* runtime.injectHistory!({
          providerThread,
          messages: [],
          context: "prior transcript",
        }),
      ).toBe(false);

      providerThread = events.findLast(
        (event): event is Extract<typeof event, { readonly type: "provider_thread.updated" }> =>
          event.type === "provider_thread.updated",
      )!.providerThread;
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
        (line) => decodeClineInvocation(line).argv,
      );
      expect(
        argumentsByTurn.every(
          (turnArgs) => turnArgs.includes("--json") && !turnArgs.includes("--id"),
        ),
      ).toBe(true);
      expect(NodeFS.readFileSync(mcpCapturePath, "utf8")).toBe("none\n\nnone\n\n");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "injects scoped T3 MCP settings, preserves user servers, and cleans them with the V2 session",
    () =>
      Effect.gen(function* () {
        const harness = makeMockHarness();
        const mcpCapturePath = NodePath.join(harness.cwd, "mcp-capture.log");
        const dataDir = NodePath.join(harness.cwd, "cline-data");
        const originalSettingsPath = NodePath.join(dataDir, "settings", "cline_mcp_settings.json");
        NodeFS.mkdirSync(NodePath.dirname(originalSettingsPath), { recursive: true });
        const originalSettings = yield* Schema.encodeEffect(JsonString)({
          mcpServers: {
            userServer: {
              command: "synthetic-user-server",
              env: { API_TOKEN: "synthetic-user-secret" },
            },
          },
        });
        NodeFS.writeFileSync(originalSettingsPath, originalSettings, { mode: 0o600 });

        const instanceId = ProviderInstanceId.make("cline-v2-mcp");
        const threadId = ThreadId.make("cline-v2-mcp-thread");
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("cline-v2-mcp-environment"),
          threadId,
          providerSessionId: "cline-v2-mcp-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer synthetic-t3-secret",
          browserToolsAvailable: false,
          capabilities: new Set(["threads"]),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            McpProviderSession.clearMcpProviderSession(threadId);
            NodeFS.rmSync(harness.cwd, { recursive: true, force: true });
          }),
        );

        const sessionScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
        const adapter = makeClineAdapterV2({
          instanceId,
          config: makeConfig(harness.binaryPath),
          environment: makeTestEnvironment({
            CLINE_DATA_DIR: dataDir,
            T3_MOCK_ARGV_LOG: harness.argvLogPath,
            T3_MOCK_MCP_CAPTURE_PATH: mcpCapturePath,
          }),
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          idAllocator: yield* IdAllocatorV2,
          defaultCwd: harness.cwd,
        });
        const runtime = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("cline-v2-mcp-provider-session"),
            modelSelection: { instanceId, model: "poolside/laguna-s-2.1:free" },
            runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: harness.cwd,
            }),
          })
          .pipe(Effect.provideService(Scope.Scope, sessionScope));
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "poolside/laguna-s-2.1:free" },
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
          runtimeMode: "full-access",
        });
        const eventFiber = yield* Effect.forkScoped(
          runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        yield* Effect.yieldNow;
        yield* runtime.startTurn(input);
        yield* Fiber.join(eventFiber);

        const [scopedSettingsPath, scopedSettingsText] = NodeFS.readFileSync(
          mcpCapturePath,
          "utf8",
        ).split("\n");
        expect(scopedSettingsPath).toBeTruthy();
        expect(scopedSettingsPath).not.toBe(originalSettingsPath);
        expect(NodeFS.existsSync(scopedSettingsPath!)).toBe(true);
        expect(yield* Schema.decodeUnknownEffect(JsonString)(scopedSettingsText!)).toEqual({
          mcpServers: {
            userServer: {
              command: "synthetic-user-server",
              env: { API_TOKEN: "synthetic-user-secret" },
            },
            "t3-code": {
              type: "streamableHttp",
              url: "http://127.0.0.1:43123/mcp",
              headers: { Authorization: "Bearer synthetic-t3-secret" },
              disabled: false,
              autoApprove: [],
            },
          },
        });
        if (HostProcessPlatform.defaultValue() !== "win32") {
          expect(NodeFS.statSync(scopedSettingsPath!).mode & 0o777).toBe(0o600);
          expect(NodeFS.statSync(NodePath.dirname(scopedSettingsPath!)).mode & 0o777).toBe(0o700);
        }
        expect(NodeFS.readFileSync(originalSettingsPath, "utf8")).toBe(originalSettings);

        yield* Scope.close(sessionScope, Exit.void);
        expect(NodeFS.existsSync(scopedSettingsPath!)).toBe(false);
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
