import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionListEntry,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type AgentSessionSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { ProjectService } from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

const sessionSelectionKey = (selection: AgentSessionSelection): string =>
  `${selection.provider}\0${selection.providerInstanceId}\0${selection.providerSessionId}`;

export function isAgentSessionResumable(
  source: AgentSessionSource,
  threadResumable?: boolean,
): boolean {
  return threadResumable ?? (source !== "cline" && source !== "commandCode");
}

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectService;
  const eventSink = yield* EventSinkV2;
  const idAllocator = yield* IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const completedSourcesForWorkspace = Effect.fn("completedAgentSessionSourcesForWorkspace")(
    function* (workspaceRoot: string) {
      const rows = yield* runtimes
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      return rows.flatMap((runtime) => {
        const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
        if (
          Option.isNone(payload) ||
          payload.value.cwd === undefined ||
          normalizeProjectPathForComparison(payload.value.cwd) !==
            normalizeProjectPathForComparison(workspaceRoot)
        ) {
          return [];
        }
        return payload.value.importedTranscripts ?? [];
      });
    },
  );

  const listRecentAgentThreads = Effect.fn("listRecentAgentThreadsV2")(function* (
    input: AgentSessionListInput,
  ): Effect.fn.Return<AgentSessionListResult, AgentSessionScanError> {
    const scan = yield* scanner.scan;
    let workspaceRoot = input.workspaceRoot;
    let completedSources: ReadonlyArray<AgentSessionImportSource> = [];
    if (input.projectId !== undefined) {
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new AgentSessionScanError({
                  operation: "read-projects",
                  cause: new Error("The project no longer exists."),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (
        normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.workspaceRoot)
      ) {
        return yield* new AgentSessionScanError({
          operation: "read-projects",
          cause: new Error("The project no longer points at the scanned workspace."),
        });
      }
      workspaceRoot = project.workspaceRoot;
      completedSources = yield* completedSourcesForWorkspace(workspaceRoot);
    }
    const candidateExists = scan.candidates.some(
      (candidate) =>
        normalizeProjectPathForComparison(candidate.path) ===
        normalizeProjectPathForComparison(workspaceRoot),
    );
    if (!candidateExists) {
      return yield* new AgentSessionScanError({
        operation: "read-projects",
        cause: new Error(
          "The requested workspace was not present in the latest agent-session scan.",
        ),
      });
    }

    const outcomes = yield* Stream.runCollect(
      scanner.recentThreads(workspaceRoot, completedSources, { mode: "preview" }),
    );
    const sessions = new Map<string, AgentSessionListEntry>();
    let skippedCount = 0;
    for (const outcome of outcomes) {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        continue;
      }
      if (outcome._tag === "Duplicate") continue;
      const thread = outcome._tag === "Importable" ? outcome.thread : undefined;
      const source = outcome.source;
      const selection: AgentSessionSelection = {
        provider: source.provider,
        providerInstanceId: source.providerInstanceId,
        providerSessionId: source.providerSessionId,
      };
      const key = sessionSelectionKey(selection);
      if (sessions.has(key)) continue;
      const preview = thread?.messages.find((message) => message.role === "user")?.text ?? "";
      sessions.set(key, {
        ...selection,
        title: thread?.title.trim() || `Previously imported ${source.provider} session`,
        preview: preview.slice(0, 180),
        lastActiveAt:
          thread?.updatedAt ?? DateTime.formatIso(DateTime.makeUnsafe(source.mtimeMs ?? 0)),
        alreadyImported: outcome._tag === "AlreadyImported",
        resumable: isAgentSessionResumable(source.provider, thread?.resumable),
      });
    }
    return { sessions: [...sessions.values()], skippedCount };
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const completedSources = yield* completedSourcesForWorkspace(project.workspaceRoot);
    const selectedKeys =
      input.selectedSessions === undefined
        ? null
        : new Set(input.selectedSessions.map(sessionSelectionKey));
    const seenSelectedKeys = new Set<string>();
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources, {
      mode: "import",
      ...(input.selectedSessions === undefined ? {} : { selectedSessions: input.selectedSessions }),
    });
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          if (selectedKeys === null) skippedCount += 1;
          return;
        }
        const source = outcome.source;
        if (selectedKeys !== null) {
          const key = sessionSelectionKey({
            provider: source.provider,
            providerInstanceId: source.providerInstanceId,
            providerSessionId: source.providerSessionId,
          });
          seenSelectedKeys.add(key);
        }
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const driver = ProviderDriverKind.make(thread.source);
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId:
              thread.resumable === false ? `app-thread:${threadId}` : thread.providerSessionId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef:
              thread.resumable === false
                ? null
                : {
                    driver,
                    nativeId: thread.providerSessionId,
                    strength: "strong",
                  },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          yield* runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.resumable === false
                  ? null
                  : thread.source === "codex"
                    ? { threadId: thread.providerSessionId }
                    : thread.source === "commandCode" || thread.source === "opencode"
                      ? { sessionId: thread.providerSessionId }
                      : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    if (selectedKeys !== null) {
      skippedCount += [...selectedKeys].filter((key) => !seenSelectedKeys.has(key)).length;
    }

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  return { listRecentAgentThreads, importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
