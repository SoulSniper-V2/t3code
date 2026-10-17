import {
  EventId,
  ProviderDriverKind,
  type HopliteImportThreadInput,
  type HopliteThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const RemoteMessagesPage = Schema.Struct({
  hasMore: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      threadId: Schema.String,
      role: Schema.Literals(["user", "assistant", "system", "tool"]),
      kind: Schema.Literals(["chat", "thinking", "tool", "status"]),
      content: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export function importEvents(input: {
  readonly binding: HopliteImportThreadInput;
  readonly threadId: ThreadId;
  readonly remote: HopliteThread & { readonly modelId: string };
  readonly messages: ReadonlyArray<(typeof RemoteMessagesPage.Type)["messages"][number]>;
  readonly now: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { binding, threadId, remote, now } = input;
  const driver = ProviderDriverKind.make("hoplite");
  const at = (value?: string | null) =>
    value ? Option.getOrElse(DateTime.make(value), () => now) : now;
  const createdAt = at(remote.createdAt);
  const updatedAt = at(remote.updatedAt);
  const providerThreadId = derive.providerThread({
    driver,
    providerInstanceId: binding.instanceId,
    nativeThreadId: binding.remoteThreadId,
  });
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "server",
    id: threadId,
    projectId: binding.projectId,
    title: remote.title?.trim() || "Imported Hoplite thread",
    providerInstanceId: binding.instanceId,
    modelSelection: { instanceId: binding.instanceId, model: remote.modelId },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    historyOrigin: "native",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: remote.archivedAt ? at(remote.archivedAt) : null,
    settledOverride: null,
    settledAt: updatedAt,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      providerInstanceId: binding.instanceId,
      occurredAt: createdAt,
      payload: appThread,
    },
    {
      id: EventId.make(`${threadId}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId: binding.instanceId,
      occurredAt: updatedAt,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: binding.instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: binding.remoteThreadId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        nativeMetadata: {
          itemIdentityVersion: 2,
          title: remote.title ?? null,
          updatedAt: remote.updatedAt ?? null,
        },
        createdAt,
        updatedAt,
      },
    },
  ];
  input.messages.forEach((message, index) => {
    if (message.threadId !== binding.remoteThreadId || message.role === "tool") return;
    const identity = `${binding.instanceId}:${binding.remoteThreadId}:${message.id}`;
    const messageId = derive.messageFromProviderItem({ driver, nativeItemId: identity });
    const timestamp = at(message.createdAt);
    const base = {
      id: derive.turnItemFromProviderItem({ driver, nativeItemId: identity }),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: { driver, nativeId: message.id, strength: "strong" as const },
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    let item: OrchestrationV2TurnItem;
    if (message.kind === "thinking") {
      item = { ...base, type: "reasoning", text: message.content, streaming: false };
    } else if (message.kind === "chat") {
      events.push({
        id: EventId.make(`${threadId}:message:${message.id}`),
        type: "message.updated",
        threadId,
        occurredAt: timestamp,
        payload: {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: message.role,
          text: message.content,
          attachments: [],
          streaming: false,
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "provider",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
      if (message.role === "system") return;
      item =
        message.role === "user"
          ? {
              ...base,
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text: message.content,
              attachments: [],
              createdBy: "user",
              creationSource: "provider",
            }
          : {
              ...base,
              type: "assistant_message",
              messageId,
              text: message.content,
              streaming: false,
            };
    } else return;
    events.push({
      id: EventId.make(`${threadId}:item:${message.id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: timestamp,
      payload: item,
    });
  });
  return events;
}
