/**
 * Native Orchestrator V2 adapter for the Command Code headless CLI.
 *
 * Each turn is a separate `command-code -p` process. The CLI's session id is
 * the durable native conversation reference and `--resume` reconnects later
 * turns. This adapter translates the CLI's NDJSON frames directly into V2
 * projections; it does not route V1 runtime events through the V2 contract.
 */
import {
  ProviderDriverKind,
  type CommandCodeSettings,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type ThreadTokenUsageSnapshot,
  type TurnTokenUsage,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Scope from "effect/Scope";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  parseCommandCodeNdjsonLine,
  type CommandCodeEventFrame,
} from "../../provider/CommandCodeProtocol.ts";
import { ServerConfig } from "../../config.ts";
import { commandCodeTurnArgs } from "../../provider/commandCodeLaunchArgs.ts";
import { providerMessageTextWithAttachmentPaths } from "../AttachmentPrompt.ts";
import type { IdAllocatorV2Shape } from "../IdAllocator.ts";
import {
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";

const COMMAND_CODE_PROVIDER = ProviderDriverKind.make("commandCode");
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;

export const CommandCodeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
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
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
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
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CommandCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
}

interface CommandCodeV2ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveCommandCodeTurn | null;
}

interface ActiveCommandCodeTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void>;
  cancelled: boolean;
  finalized: boolean;
  child: CommandCodeChild | null;
  nextItemOrdinal: number;
  messageOrdinal: number;
  reasoningOrdinal: number;
  activeAssistant: AssistantSegment | null;
  activeReasoning: ReasoningSegment | null;
  readonly tools: Map<string, ActiveToolItem>;
  usage: CommandCodeUsage | undefined;
}

interface CommandCodeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

interface CommandCodeChild {
  readonly exitCode: Effect.Effect<number>;
  readonly kill: (options?: { readonly forceKillAfter?: unknown }) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array, never>;
  readonly stderr: Stream.Stream<Uint8Array, never>;
  readonly stdin: import("effect/Sink").Sink<void, Uint8Array, never, never>;
}

interface AssistantSegment {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly messageId: OrchestrationV2ConversationMessage["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ReasoningSegment {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ActiveToolItem {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly toolName: string;
  readonly type: "command_execution" | "file_change" | "dynamic_tool";
  readonly input: unknown;
  readonly title: string | null;
  status: "running" | "completed" | "failed";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function readUsage(value: unknown): CommandCodeUsage | undefined {
  const recordValue = record(value);
  if (recordValue === undefined) return undefined;
  const number = (key: string): number | undefined => {
    const candidate = recordValue[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.trunc(candidate))
      : undefined;
  };
  const inputTokens = number("inputTokens");
  const outputTokens = number("outputTokens");
  const cacheReadTokens = number("cacheReadTokens");
  const cacheWriteTokens = number("cacheWriteTokens");
  const usage: CommandCodeUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function toTurnTokenUsage(usage: CommandCodeUsage): TurnTokenUsage {
  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens === undefined ? {} : { cachedInputTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheWriteTokens }),
    hasSubagents: false,
  };
}

function toThreadUsageSnapshot(usage: CommandCodeUsage): ThreadTokenUsageSnapshot {
  return {
    usedTokens: usage.inputTokens ?? 0,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cachedInputTokens: usage.cacheReadTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
}

function toolItemType(toolName: string): ActiveToolItem["type"] {
  if (["shell_command", "bash", "powershell"].includes(toolName)) return "command_execution";
  if (["write_file", "edit_file", "apply_patch", "multi_edit"].includes(toolName)) {
    return "file_change";
  }
  return "dynamic_tool";
}

function fileNameFromInput(input: unknown, fallback: string): string {
  const value = record(input);
  return (
    (typeof value?.["file_path"] === "string" && value["file_path"]) ||
    (typeof value?.["path"] === "string" && value["path"]) ||
    fallback
  );
}

function permissionModeForTurn(
  settings: CommandCodeSettings,
  input: ProviderAdapterV2TurnInput,
): CommandCodeSettings["permissionMode"] {
  // The CLI has a single broad `--yolo` switch and cannot surface approval
  // prompts. Only pass it when the saved setting and this turn's policy both
  // explicitly allow unrestricted execution.
  const policy = input.runtimePolicy;
  const sandboxType = record(policy.sandboxPolicy)?.["type"];
  const fullAccess =
    policy.runtimeMode === "full-access" &&
    policy.interactionMode !== "plan" &&
    (policy.approvalPolicy === undefined || policy.approvalPolicy === "never") &&
    (policy.sandboxPolicy === undefined ||
      policy.sandboxPolicy === "danger-full-access" ||
      sandboxType === "dangerFullAccess" ||
      sandboxType === "danger-full-access");
  return settings.permissionMode === "auto-accept" && fullAccess ? "auto-accept" : "standard";
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly previous?: OrchestrationV2ProviderThread;
  readonly nativeThreadId?: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const identity = input.nativeThreadId ?? `app-thread:${input.threadId}`;
  const previous = input.previous;
  return {
    id:
      previous?.id ??
      input.idAllocator.derive.providerThread({
        driver: COMMAND_CODE_PROVIDER,
        providerInstanceId: input.instanceId,
        nativeThreadId: identity,
      }),
    driver: COMMAND_CODE_PROVIDER,
    providerInstanceId: input.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: previous?.ownerNodeId ?? null,
    nativeThreadRef:
      input.nativeThreadId === undefined
        ? (previous?.nativeThreadRef ?? null)
        : {
            driver: COMMAND_CODE_PROVIDER,
            nativeId: input.nativeThreadId,
            strength: "strong",
          },
    nativeConversationHeadRef: previous?.nativeConversationHeadRef ?? null,
    status: "idle",
    firstRunOrdinal: previous?.firstRunOrdinal ?? null,
    lastRunOrdinal: previous?.lastRunOrdinal ?? null,
    handoffIds: previous?.handoffIds ?? [],
    forkedFrom: previous?.forkedFrom ?? null,
    pendingBackgroundTasks: previous?.pendingBackgroundTasks ?? [],
    contextUsage: previous?.contextUsage ?? null,
    nativeMetadata: previous?.nativeMetadata ?? null,
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

function providerThreadNativeId(providerThread: OrchestrationV2ProviderThread): string | undefined {
  const ref = providerThread.nativeThreadRef;
  return ref?.driver === COMMAND_CODE_PROVIDER ? (ref.nativeId ?? undefined) : undefined;
}

export function makeCommandCodeAdapterV2(
  settings: CommandCodeSettings,
  options: CommandCodeAdapterV2Options,
): ProviderAdapterV2Shape {
  const idAllocator = options.idAllocator;

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: COMMAND_CODE_PROVIDER,
    getCapabilities: () => Effect.succeed(CommandCodeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CommandCodeAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: COMMAND_CODE_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? options.serverConfig.cwd,
          model: input.modelSelection.model,
          capabilities: CommandCodeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const threads = yield* Ref.make(new Map<ProviderThreadId, CommandCodeV2ThreadState>());
        const runtimeStatus = yield* Ref.make(providerSession);

        const emit = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const emitSessionStatus = (status: OrchestrationV2ProviderSession["status"]) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const updated = { ...(yield* Ref.get(runtimeStatus)), status, updatedAt };
            yield* Ref.set(runtimeStatus, updated);
            yield* emit({
              type: "provider_session.updated",
              driver: COMMAND_CODE_PROVIDER,
              providerSession: updated,
            });
          });

        const emitThread = (providerThread: OrchestrationV2ProviderThread) =>
          emit({ type: "provider_thread.updated", driver: COMMAND_CODE_PROVIDER, providerThread });

        const sessionNativeId = input.initialNativeThreadId;
        if (sessionNativeId !== undefined && sessionNativeId.length > 0) {
          const initialThread = makeProviderThread({
            idAllocator,
            instanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            threadId: input.threadId,
            nativeThreadId: sessionNativeId,
            now,
          });
          yield* Ref.update(threads, (current) =>
            new Map(current).set(initialThread.id, {
              providerThread: initialThread,
              activeTurn: null,
            }),
          );
        }

        const findThread = (providerThreadId: ProviderThreadId) =>
          Ref.get(threads).pipe(
            Effect.flatMap((current) => {
              const state = current.get(providerThreadId);
              return state === undefined
                ? Effect.fail(
                    new ProviderAdapterProtocolError({
                      driver: COMMAND_CODE_PROVIDER,
                      detail: `Command Code provider thread ${providerThreadId} has not been ensured.`,
                    }),
                  )
                : Effect.succeed(state);
            }),
          );

        const updateThreadState = (
          providerThreadId: ProviderThreadId,
          update: (state: CommandCodeV2ThreadState) => CommandCodeV2ThreadState,
        ) =>
          Ref.update(threads, (current) => {
            const state = current.get(providerThreadId);
            if (state === undefined) return current;
            return new Map(current).set(providerThreadId, update(state));
          });

        const persistNativeSessionId = (active: ActiveCommandCodeTurn, nativeSessionId: string) =>
          Effect.gen(function* () {
            if (nativeSessionId.length === 0) return;
            const providerThreadId = active.input.providerThread.id;
            const current = yield* findThread(providerThreadId);
            if (providerThreadNativeId(current.providerThread) === nativeSessionId) return;
            const now = yield* DateTime.now;
            const providerThread = makeProviderThread({
              idAllocator,
              instanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              threadId: active.input.threadId,
              previous: current.providerThread,
              nativeThreadId: nativeSessionId,
              now,
            });
            yield* updateThreadState(providerThreadId, (state) => ({ ...state, providerThread }));
            yield* emitThread(providerThread);
          });

        const cleanup = Effect.gen(function* () {
          const current = yield* Ref.get(threads);
          for (const state of current.values()) {
            if (state.activeTurn !== null) {
              state.activeTurn.cancelled = true;
              if (state.activeTurn.child !== null) {
                yield* state.activeTurn.child
                  .kill({ forceKillAfter: "2 seconds" })
                  .pipe(Effect.ignore);
              }
            }
          }
          yield* Queue.shutdown(events);
        });
        yield* Effect.addFinalizer(() => cleanup);

        const makeNode = (
          active: ActiveCommandCodeTurn,
          nativeItemId: string,
          kind: OrchestrationV2ExecutionNode["kind"],
          status: OrchestrationV2ExecutionNode["status"],
          startedAt: DateTime.Utc,
          completedAt: DateTime.Utc | null,
        ) =>
          ({
            id: idAllocator.derive.nodeFromProviderItem({
              driver: COMMAND_CODE_PROVIDER,
              nativeItemId,
            }),
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: active.input.providerThread.id,
            providerTurnId: active.providerTurnId,
            nativeItemRef: {
              driver: COMMAND_CODE_PROVIDER,
              nativeId: nativeItemId,
              strength: "weak" as const,
            },
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          }) satisfies OrchestrationV2ExecutionNode;

        const emitAssistantSegment = (
          active: ActiveCommandCodeTurn,
          segment: AssistantSegment,
          streaming: boolean,
        ) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const status = streaming ? "running" : "completed";
            const nativeItemRef = {
              driver: COMMAND_CODE_PROVIDER,
              nativeId: segment.nativeItemId,
              strength: "weak" as const,
            };
            const node = {
              ...makeNode(
                active,
                segment.nativeItemId,
                "assistant_message",
                status,
                segment.startedAt,
                streaming ? null : now,
              ),
              nativeItemRef,
            } satisfies OrchestrationV2ExecutionNode;
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: segment.messageId,
              threadId: active.input.threadId,
              runId: active.input.runId,
              nodeId: node.id,
              role: "assistant",
              text: segment.text,
              attachments: [],
              streaming,
              createdAt: segment.startedAt,
              updatedAt: now,
            };
            const item: OrchestrationV2TurnItem = {
              id: segment.turnItemId,
              threadId: active.input.threadId,
              runId: active.input.runId,
              nodeId: node.id,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: segment.ordinal,
              status,
              title: null,
              startedAt: segment.startedAt,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: segment.messageId,
              text: segment.text,
              streaming,
            };
            yield* emit({ type: "node.updated", driver: COMMAND_CODE_PROVIDER, node });
            yield* emit({ type: "message.updated", driver: COMMAND_CODE_PROVIDER, message });
            yield* emit({
              type: "turn_item.updated",
              driver: COMMAND_CODE_PROVIDER,
              turnItem: item,
            });
          });

        const emitReasoningSegment = (
          active: ActiveCommandCodeTurn,
          segment: ReasoningSegment,
          streaming: boolean,
        ) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const status = streaming ? "running" : "completed";
            const nativeItemRef = {
              driver: COMMAND_CODE_PROVIDER,
              nativeId: segment.nativeItemId,
              strength: "weak" as const,
            };
            const node = {
              ...makeNode(
                active,
                segment.nativeItemId,
                "reasoning",
                status,
                segment.startedAt,
                streaming ? null : now,
              ),
              nativeItemRef,
            } satisfies OrchestrationV2ExecutionNode;
            const item: OrchestrationV2TurnItem = {
              id: segment.turnItemId,
              threadId: active.input.threadId,
              runId: active.input.runId,
              nodeId: node.id,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: segment.ordinal,
              status,
              title: null,
              startedAt: segment.startedAt,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "reasoning",
              text: segment.text,
              streaming,
            };
            yield* emit({ type: "node.updated", driver: COMMAND_CODE_PROVIDER, node });
            yield* emit({
              type: "turn_item.updated",
              driver: COMMAND_CODE_PROVIDER,
              turnItem: item,
            });
          });

        const emitToolItem = (active: ActiveCommandCodeTurn, tool: ActiveToolItem) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const done = tool.status !== "running";
            const status: OrchestrationV2ExecutionNode["status"] = tool.status;
            const nativeItemRef = {
              driver: COMMAND_CODE_PROVIDER,
              nativeId: tool.nativeItemId,
              strength: "strong" as const,
            };
            const node = {
              id: tool.nodeId,
              threadId: active.input.threadId,
              runId: active.input.runId,
              parentNodeId: active.input.rootNodeId,
              rootNodeId: active.input.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: tool.startedAt,
              completedAt: done ? now : null,
            } satisfies OrchestrationV2ExecutionNode;
            const base = {
              id: tool.turnItemId,
              threadId: active.input.threadId,
              runId: active.input.runId,
              nodeId: node.id,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: tool.ordinal,
              status: tool.status,
              title: tool.title,
              startedAt: tool.startedAt,
              completedAt: done ? now : null,
              updatedAt: now,
            } satisfies Pick<
              OrchestrationV2TurnItem,
              | "id"
              | "threadId"
              | "runId"
              | "nodeId"
              | "providerThreadId"
              | "providerTurnId"
              | "nativeItemRef"
              | "parentItemId"
              | "ordinal"
              | "status"
              | "title"
              | "startedAt"
              | "completedAt"
              | "updatedAt"
            >;
            const turnItem: OrchestrationV2TurnItem =
              tool.type === "command_execution"
                ? {
                    ...base,
                    type: "command_execution",
                    input: stringField(tool.input, "command") ?? stableJson(tool.input),
                  }
                : tool.type === "file_change"
                  ? {
                      ...base,
                      type: "file_change",
                      fileName: fileNameFromInput(tool.input, tool.toolName),
                    }
                  : { ...base, type: "dynamic_tool", toolName: tool.toolName, input: tool.input };
            yield* emit({ type: "node.updated", driver: COMMAND_CODE_PROVIDER, node });
            yield* emit({ type: "turn_item.updated", driver: COMMAND_CODE_PROVIDER, turnItem });
          });

        const beginAssistant = (active: ActiveCommandCodeTurn) =>
          Effect.gen(function* () {
            if (active.activeAssistant !== null)
              yield* emitAssistantSegment(active, active.activeAssistant, false);
            active.messageOrdinal += 1;
            const nativeItemId = `assistant:${active.input.attemptId}:${active.messageOrdinal}`;
            const ordinal = active.input.providerTurnOrdinal * 1000 + ++active.nextItemOrdinal;
            const segment: AssistantSegment = {
              nativeItemId,
              nodeId: idAllocator.derive.nodeFromProviderItem({
                driver: COMMAND_CODE_PROVIDER,
                nativeItemId,
              }),
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: COMMAND_CODE_PROVIDER,
                nativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: COMMAND_CODE_PROVIDER,
                nativeItemId,
              }),
              ordinal,
              startedAt: yield* DateTime.now,
              text: "",
            };
            active.activeAssistant = segment;
          });

        const beginReasoning = (active: ActiveCommandCodeTurn) =>
          Effect.gen(function* () {
            if (active.activeReasoning !== null)
              yield* emitReasoningSegment(active, active.activeReasoning, false);
            active.reasoningOrdinal += 1;
            const nativeItemId = `reasoning:${active.input.attemptId}:${active.reasoningOrdinal}`;
            active.activeReasoning = {
              nativeItemId,
              nodeId: idAllocator.derive.nodeFromProviderItem({
                driver: COMMAND_CODE_PROVIDER,
                nativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: COMMAND_CODE_PROVIDER,
                nativeItemId,
              }),
              ordinal: active.input.providerTurnOrdinal * 1000 + ++active.nextItemOrdinal,
              startedAt: yield* DateTime.now,
              text: "",
            };
          });

        const handleFrame = (active: ActiveCommandCodeTurn, frame: CommandCodeEventFrame) =>
          Effect.gen(function* () {
            switch (frame.type) {
              case "message_start":
                yield* beginAssistant(active);
                return;
              case "text_delta": {
                if (typeof frame["delta"] !== "string") return;
                if (active.activeAssistant === null) yield* beginAssistant(active);
                active.activeAssistant!.text += frame["delta"];
                yield* emitAssistantSegment(active, active.activeAssistant!, true);
                return;
              }
              case "message_end":
                if (active.activeAssistant !== null) {
                  yield* emitAssistantSegment(active, active.activeAssistant, false);
                  active.activeAssistant = null;
                }
                return;
              case "thinking_start":
                yield* beginReasoning(active);
                return;
              case "thinking_delta":
                if (typeof frame["delta"] !== "string") return;
                if (active.activeReasoning === null) yield* beginReasoning(active);
                active.activeReasoning!.text += frame["delta"];
                yield* emitReasoningSegment(active, active.activeReasoning!, true);
                return;
              case "thinking_end":
                if (active.activeReasoning !== null) {
                  yield* emitReasoningSegment(active, active.activeReasoning, false);
                  active.activeReasoning = null;
                }
                return;
              case "tool_queued":
              case "tool_running":
              case "tool_update":
              case "tool_denied":
              case "tool_hook_blocked":
              case "tool_errored":
              case "tool_completed": {
                const toolCallId = stringField(frame, "toolCallId");
                if (toolCallId === undefined) return;
                const toolName = stringField(frame, "toolName") ?? "tool";
                let tool = active.tools.get(toolCallId);
                if (tool === undefined) {
                  const nativeItemId = `tool:${active.input.attemptId}:${toolCallId}`;
                  const input = frame["input"];
                  const startedAt = yield* DateTime.now;
                  tool = {
                    nativeItemId,
                    nodeId: idAllocator.derive.nodeFromProviderItem({
                      driver: COMMAND_CODE_PROVIDER,
                      nativeItemId,
                    }),
                    turnItemId: idAllocator.derive.turnItemFromProviderItem({
                      driver: COMMAND_CODE_PROVIDER,
                      nativeItemId,
                    }),
                    ordinal: active.input.providerTurnOrdinal * 1000 + ++active.nextItemOrdinal,
                    startedAt,
                    toolName,
                    type: toolItemType(toolName),
                    input: input ?? {},
                    title: toolName,
                    status: "running",
                  };
                  active.tools.set(toolCallId, tool);
                }
                if (
                  frame.type === "tool_denied" ||
                  frame.type === "tool_hook_blocked" ||
                  frame.type === "tool_errored"
                ) {
                  tool.status = "failed";
                } else if (frame.type === "tool_completed") {
                  tool.status = "completed";
                }
                yield* emitToolItem(active, tool);
                return;
              }
              default:
                return;
            }
          });

        const terminalize = (
          active: ActiveCommandCodeTurn,
          status: "completed" | "interrupted" | "failed",
          failure?: ReturnType<typeof makeProviderFailure>,
        ) =>
          Effect.gen(function* () {
            if (active.finalized) return;
            active.finalized = true;
            const completedAt = yield* DateTime.now;
            if (active.activeAssistant !== null) {
              yield* emitAssistantSegment(active, active.activeAssistant, false);
              active.activeAssistant = null;
            }
            if (active.activeReasoning !== null) {
              yield* emitReasoningSegment(active, active.activeReasoning, false);
              active.activeReasoning = null;
            }
            for (const tool of active.tools.values()) {
              if (tool.status === "running") {
                tool.status =
                  status === "completed" ? "completed" : status === "failed" ? "failed" : "failed";
                yield* emitToolItem(active, tool);
              }
            }
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: active.providerTurnId,
              providerThreadId: active.input.providerThread.id,
              nodeId: active.input.rootNodeId,
              runAttemptId: active.input.attemptId,
              nativeTurnRef: null,
              ordinal: active.input.providerTurnOrdinal,
              status,
              startedAt: active.startedAt,
              completedAt,
              ...(active.usage === undefined
                ? {}
                : {
                    turnTokenUsage: toTurnTokenUsage(active.usage),
                    tokenUsage: {
                      usedTokens: active.usage.inputTokens ?? 0,
                      maxTokens: null,
                      ...(active.usage.inputTokens === undefined
                        ? {}
                        : { inputTokens: active.usage.inputTokens }),
                      ...(active.usage.cacheReadTokens === undefined
                        ? {}
                        : { cachedInputTokens: active.usage.cacheReadTokens }),
                      ...(active.usage.outputTokens === undefined
                        ? {}
                        : { outputTokens: active.usage.outputTokens }),
                      updatedAt: DateTime.formatIso(completedAt),
                    },
                  }),
            };
            yield* emit({
              type: "provider_turn.updated",
              driver: COMMAND_CODE_PROVIDER,
              threadId: active.input.threadId,
              providerTurn,
            });

            const currentState = yield* findThread(active.input.providerThread.id).pipe(
              Effect.catch(() =>
                Effect.succeed({ providerThread: active.input.providerThread, activeTurn: active }),
              ),
            );
            const nativeThreadId = providerThreadNativeId(currentState.providerThread);
            const currentProviderThread = makeProviderThread({
              idAllocator,
              instanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              threadId: active.input.threadId,
              previous: currentState.providerThread,
              ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
              now: completedAt,
            });
            const updatedProviderThread = {
              ...currentProviderThread,
              status: status === "failed" ? ("error" as const) : ("idle" as const),
              ...(active.usage === undefined
                ? {}
                : { contextUsage: toThreadUsageSnapshot(active.usage) }),
              firstRunOrdinal: currentProviderThread.firstRunOrdinal ?? active.input.runOrdinal,
              lastRunOrdinal: active.input.runOrdinal,
              updatedAt: completedAt,
            };
            yield* updateThreadState(active.input.providerThread.id, (state) => ({
              ...state,
              providerThread: updatedProviderThread,
              activeTurn: null,
            }));
            yield* emitThread(updatedProviderThread);

            if (status === "failed" || failure !== undefined) {
              const terminalFailure =
                failure ??
                makeProviderFailure({
                  message: "Command Code turn failed without a provider error payload.",
                  code: "command-code-failed-without-error",
                  class: "provider_error",
                  retryable: null,
                });
              const nativeItemId = `terminal-failure:${active.providerTurnId}`;
              const ordinal = active.input.providerTurnOrdinal * 1000 + ++active.nextItemOrdinal;
              const node = {
                id: idAllocator.derive.nodeFromProviderItem({
                  driver: COMMAND_CODE_PROVIDER,
                  nativeItemId,
                }),
                threadId: active.input.threadId,
                runId: active.input.runId,
                parentNodeId: active.input.rootNodeId,
                rootNodeId: active.input.rootNodeId,
                kind: "system",
                status: "failed",
                countsForRun: false,
                providerThreadId: active.input.providerThread.id,
                providerTurnId: active.providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: completedAt,
                completedAt,
              } satisfies OrchestrationV2ExecutionNode;
              const turnItem: OrchestrationV2TurnItem = {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver: COMMAND_CODE_PROVIDER,
                  nativeItemId,
                }),
                threadId: active.input.threadId,
                runId: active.input.runId,
                nodeId: node.id,
                providerThreadId: active.input.providerThread.id,
                providerTurnId: active.providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "failed",
                title: "Command Code error",
                startedAt: completedAt,
                completedAt,
                updatedAt: completedAt,
                type: "error",
                failure: terminalFailure,
              };
              yield* emit({ type: "node.updated", driver: COMMAND_CODE_PROVIDER, node });
              yield* emit({ type: "turn_item.updated", driver: COMMAND_CODE_PROVIDER, turnItem });
              yield* emit({
                type: "turn.terminal",
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: active.input.providerThread.id,
                providerTurnId: active.providerTurnId,
                runOrdinal: active.input.runOrdinal,
                failureItemOrdinal: ordinal,
                status: "failed",
                failure: terminalFailure,
                threadDisposition: "reusable",
              });
            } else {
              yield* emit({
                type: "turn.terminal",
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: active.input.providerThread.id,
                providerTurnId: active.providerTurnId,
                runOrdinal: active.input.runOrdinal,
                status,
                failure: null,
                threadDisposition: "reusable",
              });
            }
            yield* emitSessionStatus("ready");
            yield* Deferred.succeed(active.completed, undefined);
          });

        const runTurn = (active: ActiveCommandCodeTurn) =>
          Effect.gen(function* () {
            const turnInput = active.input;
            const threadState = yield* findThread(turnInput.providerThread.id);
            const prompt = providerMessageTextWithAttachmentPaths({
              text: turnInput.message.text,
              attachments: turnInput.message.attachments,
              attachmentsDir: options.serverConfig.attachmentsDir,
            });
            if (prompt.trim().length === 0) {
              return yield* new ProviderAdapterProtocolError({
                driver: COMMAND_CODE_PROVIDER,
                detail: "Command Code turn requires non-empty text or an attachment.",
              });
            }
            const args = commandCodeTurnArgs({
              permissionMode: permissionModeForTurn(settings, turnInput),
              model: turnInput.modelSelection.model,
              resumeSessionId: providerThreadNativeId(threadState.providerThread),
              launchArgs: settings.launchArgs,
            });
            const resolved = yield* resolveSpawnCommand(
              settings.binaryPath || "command-code",
              [...args],
              {
                env: options.environment,
                extendEnv: true,
              },
            );
            const spawned = yield* options.spawner
              .spawn(
                ChildProcess.make(resolved.command, resolved.args, {
                  ...(turnInput.runtimePolicy.cwd === null
                    ? {}
                    : { cwd: turnInput.runtimePolicy.cwd ?? undefined }),
                  env: options.environment,
                  extendEnv: true,
                  shell: resolved.shell,
                  forceKillAfter: "2 seconds",
                }),
              )
              .pipe(Effect.provideService(Scope.Scope, sessionScope));
            const child = spawned as unknown as CommandCodeChild;
            active.child = child;
            if (active.cancelled) {
              yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
            }
            yield* Stream.run(Stream.encodeText(Stream.make(prompt)), child.stdin).pipe(
              Effect.ignore,
            );

            let buffer = "";
            let stderrTail = "";
            let nativeSessionId: string | undefined;
            let resultSubtype: string | undefined;
            let resultStopReason: string | undefined;
            let resultError: string | undefined;
            let finalText: string | undefined;
            let lastUsage: CommandCodeUsage | undefined;
            let exitCode = -1;
            const handleLine = (line: string) =>
              Effect.gen(function* () {
                const parsed = parseCommandCodeNdjsonLine(line);
                if (parsed.kind === "result") {
                  resultSubtype =
                    typeof parsed.result.subtype === "string" ? parsed.result.subtype : undefined;
                  resultStopReason =
                    typeof parsed.result.stopReason === "string"
                      ? parsed.result.stopReason
                      : undefined;
                  if (typeof parsed.result.sessionId === "string") {
                    nativeSessionId = parsed.result.sessionId;
                    yield* persistNativeSessionId(active, nativeSessionId);
                  }
                  finalText =
                    typeof parsed.result.finalText === "string"
                      ? parsed.result.finalText
                      : finalText;
                  resultError =
                    typeof parsed.result.error === "string" ? parsed.result.error : resultError;
                  lastUsage = readUsage(parsed.result.usage) ?? lastUsage;
                  return;
                }
                if (parsed.kind !== "frame") return;
                if (
                  parsed.frame.type === "run_start" &&
                  typeof parsed.frame["sessionId"] === "string"
                ) {
                  nativeSessionId = parsed.frame["sessionId"];
                  yield* persistNativeSessionId(active, nativeSessionId);
                }
                if (parsed.frame.type === "model_request_end") {
                  lastUsage = readUsage(parsed.frame["usage"]) ?? lastUsage;
                  return;
                }
                yield* handleFrame(active, parsed.frame);
              });
            const stdoutLoop = child.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk: string) =>
                Effect.gen(function* () {
                  buffer += chunk;
                  let newlineIndex: number;
                  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    yield* handleLine(line);
                  }
                }),
              ),
            );
            const stderrLoop = child.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk: string) =>
                Effect.sync(() => {
                  const next = (stderrTail + chunk).replace(ANSI_ESCAPE_REGEX, "");
                  stderrTail = next.length > 8_000 ? next.slice(-8_000) : next;
                }),
              ),
            );
            const [, , code] = yield* Effect.all(
              [stdoutLoop, stderrLoop, child.exitCode.pipe(Effect.orElseSucceed(() => -1))],
              { concurrency: "unbounded" },
            );
            exitCode = typeof code === "number" ? code : Number(code);
            if (buffer.trim().length > 0) yield* handleLine(buffer);
            active.usage = lastUsage;

            if (nativeSessionId !== undefined) {
              yield* persistNativeSessionId(active, nativeSessionId);
            }

            if (active.cancelled) {
              yield* terminalize(active, "interrupted");
              return;
            }
            if (resultSubtype !== "error" && (resultSubtype === "success" || exitCode === 0)) {
              if (
                finalText !== undefined &&
                active.activeAssistant === null &&
                finalText.length > 0
              ) {
                yield* beginAssistant(active);
                active.activeAssistant!.text = finalText;
              }
              yield* terminalize(active, "completed");
              return;
            }

            const detail = [
              resultError,
              stderrTail.trim().split(/\r?\n/u).slice(-3).join("\n").trim(),
            ].find((part) => part !== undefined && part.length > 0);
            const message =
              `${exitCode === -1 ? "Command Code was terminated by signal" : `Command Code exited with code ${exitCode}`}${detail ? `: ${detail}` : ""}`.slice(
                0,
                2_000,
              );
            const failureClass: OrchestrationV2ProviderFailureClass =
              exitCode === 3 || exitCode === 4
                ? "permission_error"
                : exitCode === 1
                  ? "validation_error"
                  : exitCode === -1
                    ? "transport_error"
                    : "provider_error";
            yield* terminalize(
              active,
              "failed",
              makeProviderFailure({
                message,
                code: `command-code-exit-${exitCode}`,
                class: failureClass,
                retryable: null,
              }),
            );
            if (resultStopReason !== undefined) {
              yield* Effect.logDebug("orchestration-v2.command-code-stop-reason", {
                resultStopReason,
              });
            }
          }).pipe(
            Effect.catchCause((cause) =>
              terminalize(
                active,
                active.cancelled ? "interrupted" : "failed",
                active.cancelled
                  ? undefined
                  : makeProviderFailure({
                      cause,
                      class: "transport_error",
                      code: "command-code-transport",
                    }),
              ),
            ),
            Effect.ensuring(
              updateThreadState(active.input.providerThread.id, (state) => ({
                ...state,
                activeTurn:
                  state.activeTurn?.providerTurnId === active.providerTurnId
                    ? null
                    : state.activeTurn,
              })),
            ),
          );

        const startTurn = Effect.fn("CommandCodeAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapterV2TurnInput) {
            const now = yield* DateTime.now;
            const completed = yield* Deferred.make<void>();
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: COMMAND_CODE_PROVIDER,
              nativeTurnId: String(turnInput.attemptId),
            });
            const active: ActiveCommandCodeTurn = {
              input: turnInput,
              providerTurnId,
              startedAt: now,
              completed,
              cancelled: false,
              finalized: false,
              child: null,
              nextItemOrdinal: 0,
              messageOrdinal: 0,
              reasoningOrdinal: 0,
              activeAssistant: null,
              activeReasoning: null,
              tools: new Map(),
              usage: undefined,
            };
            type TurnReservation =
              | { readonly accepted: false }
              | {
                  readonly accepted: true;
                  readonly runningThread: OrchestrationV2ProviderThread;
                };
            const reservation = yield* Ref.modify(
              threads,
              (
                current,
              ): readonly [TurnReservation, Map<ProviderThreadId, CommandCodeV2ThreadState>] => {
                const state = current.get(turnInput.providerThread.id);
                if (state === undefined || state.activeTurn !== null) {
                  return [{ accepted: false as const }, current] as const;
                }
                const runningThread = {
                  ...state.providerThread,
                  status: "active" as const,
                  updatedAt: now,
                };
                const next = new Map(current).set(turnInput.providerThread.id, {
                  providerThread: runningThread,
                  activeTurn: active,
                });
                return [{ accepted: true as const, runningThread }, next] as const;
              },
            );
            if (!reservation.accepted) {
              return yield* new ProviderAdapterProtocolError({
                driver: COMMAND_CODE_PROVIDER,
                detail: `Command Code provider thread ${turnInput.providerThread.id} is missing or already has an active turn.`,
              });
            }
            const runningThread = reservation.runningThread;
            const runningTurn: OrchestrationV2ProviderTurn = {
              id: providerTurnId,
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: null,
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt: now,
              completedAt: null,
            };
            yield* emit({
              type: "provider_turn.updated",
              driver: COMMAND_CODE_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn: runningTurn,
            });
            yield* emitThread(runningThread);
            yield* emitSessionStatus("running");
            yield* runTurn(active).pipe(Effect.forkIn(sessionScope));
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: COMMAND_CODE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: COMMAND_CODE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: Effect.fn("CommandCodeAdapterV2.ensureThread")(function* (threadInput) {
            const now = yield* DateTime.now;
            const existing =
              threadInput.existingProviderThread ??
              [...(yield* Ref.get(threads)).values()].find(
                (state) => state.providerThread.appThreadId === threadInput.threadId,
              )?.providerThread;
            const initialNativeThreadId =
              threadInput.threadId === input.threadId ? input.initialNativeThreadId : undefined;
            const providerThread = makeProviderThread({
              idAllocator,
              instanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              threadId: threadInput.threadId,
              ...(existing === undefined ? {} : { previous: existing }),
              ...(initialNativeThreadId === undefined
                ? {}
                : { nativeThreadId: initialNativeThreadId }),
              now,
            });
            yield* Ref.update(threads, (current) =>
              new Map(current).set(providerThread.id, { providerThread, activeTurn: null }),
            );
            return providerThread;
          }),
          resumeThread: Effect.fn("CommandCodeAdapterV2.resumeThread")(function* (resumeInput) {
            const now = yield* DateTime.now;
            const nativeThreadId = providerThreadNativeId(resumeInput.providerThread);
            const providerThread = makeProviderThread({
              idAllocator,
              instanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              threadId:
                resumeInput.threadId ?? resumeInput.providerThread.appThreadId ?? input.threadId,
              previous: resumeInput.providerThread,
              ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
              now,
            });
            yield* Ref.update(threads, (current) => {
              const existing = current.get(providerThread.id);
              return new Map(current).set(providerThread.id, {
                providerThread,
                activeTurn: existing?.activeTurn ?? null,
              });
            });
            return providerThread;
          }),
          startTurn,
          steerTurn: (steerInput) =>
            Effect.fail(
              new ProviderAdapterSteerRunUnsupportedError({
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: steerInput.providerThread.id,
              }),
            ),
          interruptTurn: Effect.fn("CommandCodeAdapterV2.interruptTurn")(
            function* (interruptInput) {
              const state = yield* findThread(interruptInput.providerThread.id);
              const active = state.activeTurn;
              if (active === null || active.providerTurnId !== interruptInput.providerTurnId)
                return;
              active.cancelled = true;
              if (active.child !== null)
                yield* active.child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
              const stopped = yield* Deferred.await(active.completed).pipe(
                Effect.timeoutOption("3 seconds"),
              );
              if (Option.isNone(stopped)) {
                // A broken CLI may ignore the first process termination signal.
                // Reissue the kill and settle T3's turn so Stop cannot hang
                // forever; the cancelled flag makes a not-yet-spawned child
                // abort immediately if it appears after this fallback.
                if (active.child !== null) {
                  yield* active.child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
                }
                yield* terminalize(active, "interrupted");
              }
            },
            (effect, interruptInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      driver: COMMAND_CODE_PROVIDER,
                      providerThreadId: interruptInput.providerThread.id,
                      providerTurnId: interruptInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.fail(
              new ProviderAdapterRuntimeRequestResponseError({
                driver: COMMAND_CODE_PROVIDER,
                requestId: requestInput.requestId,
                cause:
                  "Command Code headless output does not surface interactive approval or user-input requests.",
              }),
            ),
          readThreadSnapshot: (snapshotInput) =>
            Effect.fail(
              new ProviderAdapterReadThreadSnapshotError({
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: snapshotInput.providerThread.id,
                cause:
                  "The Command Code CLI exposes resume but no supported conversation-history API.",
              }),
            ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapterRollbackThreadError({
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause:
                  "The Command Code headless protocol cannot rewind provider conversation history.",
              }),
            ),
          forkThread: (forkInput) =>
            Effect.fail(
              new ProviderAdapterForkThreadError({
                driver: COMMAND_CODE_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause:
                  "The Command Code headless protocol does not provide native conversation forks.",
              }),
            ),
        };
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: COMMAND_CODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}
