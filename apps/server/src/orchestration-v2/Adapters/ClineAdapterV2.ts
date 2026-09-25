/**
 * Cline's headless JSON interface is deliberately adapted as a one-shot
 * runtime: `cline --id` switches back to its interactive TTY mode, so T3
 * starts a fresh native session for every run and never claims that native
 * history, resume, fork, rollback, approvals, or active steering are available.
 */
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  CLINE_THINKING_LEVELS,
  type ClineThinkingLevel,
  ClineSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { clineTurnArgs } from "../../provider/clineLaunchArgs.ts";
import {
  parseClineNdjsonLine,
  renderClineToolOutput,
  type ClineUsageTotals,
} from "../../provider/clineNdjson.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeProviderFailure, makeProviderFailureTurnItem } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";

const CLINE_PROVIDER = ProviderDriverKind.make("cline");

/** Headless Cline starts a new CLI session for each turn. */
export const ClineProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ClineAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly config: ClineSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idAllocator: IdAllocatorV2Shape;
  readonly defaultCwd: string;
}

interface ClineChildHandle {
  readonly exitCode: Effect.Effect<number>;
  readonly kill: (options?: { readonly forceKillAfter?: unknown }) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array, never>;
  readonly stderr: Stream.Stream<Uint8Array, never>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, never>;
}

interface ActiveClineTurn {
  providerThread: OrchestrationV2ProviderThread;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly turnInput: ProviderAdapterV2TurnInput;
  requestedInterrupt: boolean;
  child: ClineChildHandle | null;
}

interface ClineStreamItem {
  readonly nativeItemId: string;
  readonly itemId: OrchestrationV2TurnItem["id"];
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly startedAt: DateTime.Utc;
  readonly ordinal: number;
  readonly kind: "assistant_message" | "reasoning" | "tool";
  readonly toolName?: string;
  readonly input?: unknown;
  readonly text: string;
  readonly output: string;
  readonly failed: boolean;
}

const providerRef = (nativeId: string) => ({
  driver: CLINE_PROVIDER,
  nativeId,
  strength: "weak" as const,
});

const toolInputText = (toolName: string, input: unknown): string => {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return toolName;
  const record = input as Record<string, unknown>;
  for (const key of ["commands", "command", "query", "path", "file_path", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .filter((part) => typeof part === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) return joined;
    }
  }
  return toolName;
};

const toTurnTokenUsage = (usage: ClineUsageTotals) => ({
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.cacheReadTokens,
  cacheCreationTokens: usage.cacheWriteTokens,
  hasSubagents: false,
});

function createFailure(message: string): OrchestrationV2ProviderFailure {
  return makeProviderFailure({
    message,
    class: /auth|login|credential|permission|forbidden|unauthorized/i.test(message)
      ? "permission_error"
      : "provider_error",
    retryable: null,
  });
}

/**
 * Native Orchestration V2 adapter for Cline's documented `--json` process
 * protocol. Each startTurn gets its own Cline process; there is no resume id
 * because Cline's `--id` option requires its interactive terminal UI.
 */
export function makeClineAdapterV2(options: ClineAdapterV2Options): ProviderAdapterV2Shape {
  const idAllocator = options.idAllocator;
  const unsupportedSnapshot = (providerThreadId: OrchestrationV2ProviderThread["id"]) =>
    new ProviderAdapterReadThreadSnapshotError({
      driver: CLINE_PROVIDER,
      providerThreadId,
      cause:
        "Cline headless turns use fresh native sessions and expose no resumable conversation history.",
    });

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CLINE_PROVIDER,
    getCapabilities: () => Effect.succeed(ClineProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ClineAdapterV2.openSession")(function* (
      input: ProviderAdapterV2OpenSessionInput,
    ) {
      const createdAt = yield* DateTime.now;
      const sessionScope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? options.defaultCwd;
      let providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: CLINE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: ClineProviderCapabilitiesV2,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      };
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const threads = yield* Ref.make(
        new Map<OrchestrationV2ProviderThread["id"], OrchestrationV2ProviderThread>(),
      );
      const activeTurn = yield* Ref.make<ActiveClineTurn | null>(null);

      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const updateSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError = providerSession.lastError,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          providerSession = { ...providerSession, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: CLINE_PROVIDER,
            providerSession,
          });
        });
      const updateThread = (
        providerThread: OrchestrationV2ProviderThread,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          const next = { ...providerThread, ...patch, updatedAt };
          yield* Ref.update(threads, (current) => new Map(current).set(next.id, next));
          yield* emit({
            type: "provider_thread.updated",
            driver: CLINE_PROVIDER,
            providerThread: next,
          });
          return next;
        });

      const registerThread = (input: {
        readonly threadId: ThreadId;
        readonly existingProviderThread?: OrchestrationV2ProviderThread;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const old = input.existingProviderThread;
          const thread: OrchestrationV2ProviderThread = {
            id:
              old?.id ??
              idAllocator.derive.providerThread({
                driver: CLINE_PROVIDER,
                nativeThreadId: `app-thread:${input.threadId}`,
                providerInstanceId: options.instanceId,
              }),
            driver: CLINE_PROVIDER,
            providerInstanceId: options.instanceId,
            providerSessionId: providerSession.id,
            appThreadId: input.threadId,
            ownerNodeId: old?.ownerNodeId ?? null,
            // This stable app-thread key only scopes T3's projected records;
            // it is not represented as a native Cline thread ID.
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: old?.firstRunOrdinal ?? null,
            lastRunOrdinal: old?.lastRunOrdinal ?? null,
            handoffIds: old?.handoffIds ?? [],
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            forkedFrom: old?.forkedFrom ?? null,
            createdAt: old?.createdAt ?? now,
            updatedAt: now,
          };
          yield* Ref.update(threads, (current) => new Map(current).set(thread.id, thread));
          yield* emit({
            type: "provider_thread.updated",
            driver: CLINE_PROVIDER,
            providerThread: thread,
          });
          return thread;
        });

      const updateItem = (
        turn: ActiveClineTurn,
        item: ClineStreamItem,
        status: "running" | "completed" | "failed",
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          const completedAt = status === "running" ? null : updatedAt;
          const nativeItemRef = providerRef(item.nativeItemId);
          const node: OrchestrationV2ExecutionNode = {
            id: item.nodeId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind:
              item.kind === "assistant_message"
                ? "assistant_message"
                : item.kind === "reasoning"
                  ? "reasoning"
                  : "tool_call",
            status,
            countsForRun: true,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: item.startedAt,
            completedAt,
          };
          yield* emit({ type: "node.updated", driver: CLINE_PROVIDER, node });
          const common = {
            id: item.itemId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: item.nodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef,
            parentItemId: null,
            ordinal: item.ordinal,
            status,
            title: item.kind === "tool" ? (item.toolName ?? null) : null,
            startedAt: item.startedAt,
            completedAt,
            updatedAt,
          };
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: CLINE_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: CLINE_PROVIDER,
              turnItem: {
                ...common,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming: status === "running",
              },
            });
            yield* emit({
              type: "message.updated",
              driver: CLINE_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: item.nodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming: status === "running",
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt,
              },
            });
            return;
          }
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: CLINE_PROVIDER,
              turnItem: {
                ...common,
                type: "reasoning",
                text: item.text,
                streaming: status === "running",
              },
            });
            return;
          }

          const commandTool =
            item.toolName === "run_commands" || item.toolName === "execute_command";
          const webSearchTool = item.toolName === "web_search";
          if (commandTool) {
            yield* emit({
              type: "turn_item.updated",
              driver: CLINE_PROVIDER,
              turnItem: {
                ...common,
                type: "command_execution",
                input: toolInputText(item.toolName ?? "command", item.input),
                ...(item.output.length === 0 ? {} : { output: item.output }),
                ...(status === "running" ? {} : { outputIndicatesFailure: item.failed }),
              },
            });
            return;
          }
          if (webSearchTool) {
            yield* emit({
              type: "turn_item.updated",
              driver: CLINE_PROVIDER,
              turnItem: {
                ...common,
                type: "web_search",
                patterns: [toolInputText(item.toolName ?? "web_search", item.input)],
                ...(item.output.length === 0 ? {} : { results: [{ snippet: item.output }] }),
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: CLINE_PROVIDER,
            turnItem: {
              ...common,
              type: "dynamic_tool",
              toolName: item.toolName ?? null,
              input: item.input ?? {},
              ...(item.output.length === 0 ? {} : { output: { text: item.output } }),
            },
          });
        });

      const startTurn = (turnInput: ProviderAdapterV2TurnInput) =>
        Effect.gen(function* () {
          const providerThread = (yield* Ref.get(threads)).get(turnInput.providerThread.id);
          if (providerThread === undefined) {
            return yield* new ProviderAdapterTurnStartError({
              driver: CLINE_PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause: "Cline provider thread was not ensured in this adapter session.",
            });
          }
          if (turnInput.message.attachments.length > 0) {
            return yield* new ProviderAdapterTurnStartError({
              driver: CLINE_PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: providerThread.id,
              runId: turnInput.runId,
              cause: "Cline's current headless adapter does not forward chat attachments.",
            });
          }
          if ((yield* Ref.get(activeTurn)) !== null) {
            return yield* new ProviderAdapterTurnStartError({
              driver: CLINE_PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: providerThread.id,
              runId: turnInput.runId,
              cause: "A Cline headless process is already running in this provider session.",
            });
          }
          const startedAt = yield* DateTime.now;
          const nativeTurnKey = `${turnInput.attemptId}`;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: idAllocator.derive.providerTurn({
              driver: CLINE_PROVIDER,
              nativeTurnId: nativeTurnKey,
            }),
            providerThreadId: providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const active: ActiveClineTurn = {
            providerThread,
            providerTurn,
            turnInput,
            requestedInterrupt: false,
            child: null,
          };
          yield* Ref.set(activeTurn, active);
          yield* emit({
            type: "provider_turn.updated",
            driver: CLINE_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          const runningThread = yield* updateThread(providerThread, {
            status: "active",
            firstRunOrdinal: providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          active.providerThread = runningThread;
          yield* updateSession("running", null);
          yield* runClineTurn(active).pipe(
            Effect.catchCause((cause) =>
              finishTurn(active, {
                status: "failed",
                failure: createFailure(`Cline headless process failed: ${String(cause)}`),
              }),
            ),
            Effect.ensuring(Ref.set(activeTurn, null)),
          );
        });

      const finishTurn = (
        turn: ActiveClineTurn,
        result:
          | { readonly status: "completed"; readonly usage?: ClineUsageTotals }
          | { readonly status: "interrupted"; readonly usage?: ClineUsageTotals }
          | { readonly status: "failed"; readonly failure: OrchestrationV2ProviderFailure },
      ) =>
        Effect.gen(function* () {
          const completedAt = yield* DateTime.now;
          const status = result.status;
          const providerTurn: OrchestrationV2ProviderTurn = {
            ...turn.providerTurn,
            status,
            completedAt,
            ...(result.status !== "failed" && result.usage !== undefined
              ? { turnTokenUsage: toTurnTokenUsage(result.usage) }
              : {}),
          };
          yield* emit({
            type: "provider_turn.updated",
            driver: CLINE_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn,
          });
          const currentThread =
            (yield* Ref.get(threads)).get(turn.providerThread.id) ?? turn.providerThread;
          const idleThread = yield* updateThread(currentThread, { status: "idle" });
          // Cline is launched per turn rather than kept as a persistent
          // process, so every terminal outcome returns the T3 session to ready.
          yield* updateSession("ready", result.status === "failed" ? result.failure.message : null);
          if (result.status === "failed") {
            const failureItem = makeProviderFailureTurnItem({
              idAllocator,
              driver: CLINE_PROVIDER,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: turn.turnInput.rootNodeId,
              providerThreadId: idleThread.id,
              providerTurnId: providerTurn.id,
              itemOrdinal: turn.turnInput.providerTurnOrdinal * 100 + 99,
              failure: result.failure,
              occurredAt: completedAt,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: CLINE_PROVIDER,
              turnItem: failureItem,
            });
            yield* emit({
              type: "turn.terminal",
              driver: CLINE_PROVIDER,
              providerThreadId: idleThread.id,
              providerTurnId: providerTurn.id,
              runOrdinal: turn.turnInput.runOrdinal,
              failureItemOrdinal: failureItem.ordinal,
              status: "failed",
              failure: result.failure,
              threadDisposition: "reusable",
            });
            return;
          }
          yield* emit({
            type: "turn.terminal",
            driver: CLINE_PROVIDER,
            providerThreadId: idleThread.id,
            providerTurnId: providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: result.status,
            failure: null,
            threadDisposition: "reusable",
          });
        });

      const runClineTurn = (turn: ActiveClineTurn) =>
        Effect.gen(function* () {
          const turnInput = turn.turnInput;
          const modelSelection = turnInput.modelSelection;
          const selectedThinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
          const thinking: ClineThinkingLevel = CLINE_THINKING_LEVELS.some(
            ({ value }) => value === selectedThinking,
          )
            ? (selectedThinking as ClineThinkingLevel)
            : options.config.thinkingLevel;
          const provider = getModelSelectionStringOptionValue(modelSelection, "provider");
          // Cline's CLI does not implement T3 approval callbacks. Never grant
          // auto-approve unless both the instance setting and requested T3
          // runtime mode allow full access.
          const permissionMode =
            options.config.permissionMode === "auto-accept" &&
            turnInput.runtimePolicy.runtimeMode === "full-access"
              ? "auto-accept"
              : "standard";
          const args = clineTurnArgs({
            permissionMode,
            thinkingLevel: thinking,
            model: modelSelection.model,
            provider,
            launchArgs: options.config.launchArgs,
            prompt: turnInput.message.text,
          });
          const cwd = turnInput.runtimePolicy.cwd ?? options.defaultCwd;
          const resolved = yield* resolveSpawnCommand(
            options.config.binaryPath || "cline",
            [...args],
            {
              env: options.environment,
              extendEnv: true,
            },
          );
          const spawned = yield* options.spawner
            .spawn(
              ChildProcess.make(resolved.command, resolved.args, {
                cwd,
                env: options.environment,
                extendEnv: true,
                shell: resolved.shell,
                forceKillAfter: "2 seconds",
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, sessionScope));
          const child = spawned as unknown as ClineChildHandle;
          turn.child = child;
          if (turn.requestedInterrupt) {
            yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
          }
          yield* Stream.run(Stream.empty, child.stdin).pipe(Effect.ignore);

          const items = new Map<string, ClineStreamItem>();
          let nextOrdinal = turn.turnInput.providerTurnOrdinal * 100 + 1;
          let buffer = "";
          let stderr = "";
          let usage: ClineUsageTotals | undefined;
          let doneText = "";
          let protocolError: string | undefined;
          let runResult:
            | Extract<ReturnType<typeof parseClineNdjsonLine>, { readonly kind: "runResult" }>
            | undefined;

          const scopedNativeItemId = (nativeId: string) => `${turn.providerTurn.id}:${nativeId}`;
          const newItem = (
            nativeItemId: string,
            kind: ClineStreamItem["kind"],
            details: Partial<ClineStreamItem> = {},
          ) =>
            Effect.gen(function* () {
              const startedAt = yield* DateTime.now;
              const scopedId = scopedNativeItemId(nativeItemId);
              const item: ClineStreamItem = {
                nativeItemId: scopedId,
                itemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CLINE_PROVIDER,
                  nativeItemId: scopedId,
                }),
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: CLINE_PROVIDER,
                  nativeItemId: scopedId,
                }),
                startedAt,
                ordinal: nextOrdinal++,
                kind,
                text: "",
                output: "",
                failed: false,
                ...details,
              };
              items.set(nativeItemId, item);
              return item;
            });
          const textItem = (
            kind: "assistant_message" | "reasoning",
            nativeId: string,
            delta: string,
          ) =>
            Effect.gen(function* () {
              const item = items.get(nativeId) ?? (yield* newItem(nativeId, kind));
              const updated = { ...item, text: item.text + delta };
              items.set(nativeId, updated);
              yield* updateItem(turn, updated, "running");
            });
          const toolItem = (nativeId: string, toolName: string, input: unknown) =>
            Effect.gen(function* () {
              const existing = items.get(nativeId);
              const item =
                existing ?? (yield* newItem(nativeId, "tool", { toolName, input: input ?? {} }));
              yield* updateItem(turn, item, "running");
            });
          const handleLine = (line: string) =>
            Effect.gen(function* () {
              const parsed = parseClineNdjsonLine(line);
              switch (parsed.kind) {
                case "textDelta":
                  yield* textItem("assistant_message", "assistant", parsed.delta);
                  return;
                case "reasoningDelta":
                  yield* textItem("reasoning", "reasoning", parsed.delta);
                  return;
                case "toolStart":
                  yield* toolItem(parsed.toolCallId, parsed.toolName, parsed.input);
                  return;
                case "toolUpdate": {
                  if (parsed.chunk.length === 0) return;
                  const item =
                    items.get(parsed.toolCallId) ??
                    (yield* newItem(parsed.toolCallId, "tool", {
                      toolName: parsed.toolName,
                      input: {},
                    }));
                  const updated = { ...item, output: item.output + parsed.chunk };
                  items.set(parsed.toolCallId, updated);
                  yield* updateItem(turn, updated, "running");
                  return;
                }
                case "toolEnd": {
                  const item =
                    items.get(parsed.toolCallId) ??
                    (yield* newItem(parsed.toolCallId, "tool", {
                      toolName: parsed.toolName,
                      input: {},
                    }));
                  const output = renderClineToolOutput(parsed.output).slice(0, 20_000);
                  const updated = {
                    ...item,
                    output: output || item.output,
                    failed: parsed.output.some((entry) => !entry.success),
                  };
                  items.set(parsed.toolCallId, updated);
                  yield* updateItem(turn, updated, updated.failed ? "failed" : "completed");
                  return;
                }
                case "usage":
                  usage = parsed.usage;
                  return;
                case "done":
                  doneText = parsed.text;
                  return;
                case "runResult":
                  runResult = parsed;
                  usage = parsed.usage;
                  return;
                case "error":
                  protocolError = parsed.message;
                  return;
                case "ignored":
                case "iterationEnd":
                  return;
              }
            });

          const stdoutLoop = child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                buffer += chunk;
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                  const line = buffer.slice(0, newline);
                  buffer = buffer.slice(newline + 1);
                  yield* handleLine(line);
                  newline = buffer.indexOf("\n");
                }
              }),
            ),
          );
          const stderrLoop = child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                const next = `${stderr}${chunk}`;
                stderr = next.length > 8_000 ? next.slice(-8_000) : next;
              }),
            ),
          );
          const [, , exitRaw] = yield* Effect.all(
            [stdoutLoop, stderrLoop, child.exitCode.pipe(Effect.orElseSucceed(() => -1))],
            { concurrency: "unbounded" },
          );
          turn.child = null;
          const exitCode = typeof exitRaw === "number" ? exitRaw : Number(exitRaw);
          if (buffer.trim().length > 0) yield* handleLine(buffer);

          for (const item of items.values()) {
            if (item.kind !== "tool" || item.failed) continue;
            yield* updateItem(turn, item, "completed");
          }
          for (const item of items.values()) {
            if (item.kind === "assistant_message" || item.kind === "reasoning") {
              yield* updateItem(turn, item, "completed");
            }
          }

          if (turn.requestedInterrupt) {
            yield* finishTurn(turn, {
              status: "interrupted",
              ...(usage === undefined ? {} : { usage }),
            });
          } else if (runResult?.finishReason === "completed") {
            yield* finishTurn(turn, {
              status: "completed",
              ...(usage === undefined ? {} : { usage }),
            });
          } else {
            const stderrLines = stderr.trim().split(/\r?\n/u);
            const stderrError = stderrLines
              .map((line) => parseClineNdjsonLine(line))
              .find((frame) => frame.kind === "error");
            const stderrMessage =
              stderrError?.kind === "error"
                ? stderrError.message
                : stderrLines.slice(-3).join("\n").trim();
            const message =
              protocolError ||
              runResult?.text.trim() ||
              doneText.trim() ||
              stderrMessage ||
              (exitCode === -1
                ? "Cline was terminated by signal."
                : `Cline exited with code ${exitCode}.`);
            yield* finishTurn(turn, {
              status: "failed",
              failure: createFailure(message.slice(0, 2_000)),
            });
          }
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const active = yield* Ref.get(activeTurn);
          if (active?.child !== null && active?.child !== undefined) {
            active.requestedInterrupt = true;
            yield* active.child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
          }
          yield* Queue.shutdown(events);
        }),
      );

      return {
        instanceId: options.instanceId,
        driver: CLINE_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return providerSession;
        },
        events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.succeed(false),
        hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
        ensureThread: (ensureInput) =>
          registerThread({
            threadId: ensureInput.threadId,
            ...(ensureInput.existingProviderThread === undefined
              ? {}
              : { existingProviderThread: ensureInput.existingProviderThread }),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterEnsureThreadError({
                  driver: CLINE_PROVIDER,
                  threadId: ensureInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (resumeInput) =>
          registerThread({
            threadId:
              resumeInput.threadId ?? resumeInput.providerThread.appThreadId ?? input.threadId,
            existingProviderThread: resumeInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterResumeThreadError({
                  driver: CLINE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: resumeInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        injectHistory: () => Effect.succeed(false),
        startTurn,
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapterSteerRunUnsupportedError({
              driver: CLINE_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const active = yield* Ref.get(activeTurn);
            if (active === null || active.providerTurn.id !== interruptInput.providerTurnId) return;
            active.requestedInterrupt = true;
            if (active.child !== null) {
              yield* active.child.kill({ forceKillAfter: "2 seconds" }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      driver: CLINE_PROVIDER,
                      providerThreadId: interruptInput.providerThread.id,
                      providerTurnId: interruptInput.providerTurnId,
                      cause,
                    }),
                ),
              );
            }
          }),
        respondToRuntimeRequest: (responseInput) =>
          Effect.fail(
            new ProviderAdapterRuntimeRequestResponseError({
              driver: CLINE_PROVIDER,
              requestId: responseInput.requestId,
              cause:
                "Cline headless mode does not expose approval or user-input request callbacks.",
            }),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.fail(unsupportedSnapshot(snapshotInput.providerThread.id)),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapterRollbackThreadError({
              driver: CLINE_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause: "Cline headless mode cannot resume or roll back a native conversation.",
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: CLINE_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: "Cline headless mode cannot natively fork or resume a conversation.",
            }),
          ),
      };
    }),
  });
}

export type ClineAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocatorV2
  | ServerConfig;

export const ClineAdapterV2Driver: ProviderAdapterDriver<ClineSettings, ClineAdapterV2DriverEnv> = {
  driverKind: CLINE_PROVIDER,
  configSchema: ClineSettings,
  defaultConfig: () => Schema.decodeSync(ClineSettings)({}),
  create: Effect.fn("ClineAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ClineSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocatorV2;
      const { cwd } = yield* ServerConfig;
      return makeClineAdapterV2({
        instanceId: input.instanceId,
        config: {
          ...input.config,
          enabled: input.enabled,
          binaryPath: expandHomePath(input.config.binaryPath),
        },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner,
        idAllocator,
        defaultCwd: cwd,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CLINE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Cline v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
