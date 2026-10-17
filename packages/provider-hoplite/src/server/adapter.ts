import {
  ProviderDriverKind,
  ProviderTurnId,
  RuntimeRequestId,
  type ProviderInstanceId,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ModelSelection,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  HopliteApiError,
  HopliteEvent,
  HopliteMessage,
  HopliteThread,
  HopliteModelCatalog,
  type HopliteApi,
} from "../api.ts";
import type { HopliteSettings } from "../settings.ts";
import { hopliteCapabilities } from "./capabilities.ts";
import {
  DraftSnapshots,
  HopliteActivity,
  HopliteQuestion,
  HopliteDraft,
  HopliteRun,
  HopliteTranscript,
  operationKey,
} from "./protocol.ts";

const driver = ProviderDriverKind.make("hoplite");
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isHopliteApiError = Schema.is(HopliteApiError);
const decodeDraft = Schema.decodeEffect(Schema.fromJsonString(HopliteDraft));
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(HopliteEvent));
const decodeRemovedDraft = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ messageId: Schema.String })),
);
const decodeUrl = Schema.decodeEffect(Schema.URLFromString);
const nativeRef = (nativeId: string): OrchestrationV2ProviderRef => ({
  driver,
  nativeId,
  strength: "strong",
});
const ok = Schema.Struct({ ok: Schema.Boolean });
const protocolError = (detail: string) =>
  new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });
const option = (selection: ModelSelection, id: string) =>
  selection.options?.find((entry) => entry.id === id)?.value;
const time = (value: string | null | undefined, fallback: DateTime.Utc) =>
  value ? Option.getOrElse(DateTime.make(value), () => fallback) : fallback;

export const makeHopliteAdapter = Effect.fn("makeHopliteAdapter")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HopliteSettings;
  readonly api: HopliteApi;
}) {
  const host = yield* ProviderHost.ProviderHost;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const api = options.api;

  const openSession = Effect.fn("Hoplite.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const scope = yield* Effect.scope;
    const now = yield* DateTime.now;
    const providerSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: options.instanceId,
      status: "ready" as const,
      cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
      model: input.modelSelection.model,
      capabilities: hopliteCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<
      ProviderAdapter.ProviderAdapterV2Event,
      ProviderAdapter.ProviderAdapterV2Error | Cause.Done
    >();
    yield* Effect.addFinalizer(() => Queue.shutdown(events));
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(events, event).pipe(Effect.asVoid);
    let thread: OrchestrationV2ProviderThread | undefined;
    let active:
      | {
          input: ProviderAdapter.ProviderAdapterV2TurnInput;
          turn: OrchestrationV2ProviderTurn;
          nativeRunId?: string;
          submittedMessageId: string;
          interrupted: boolean;
          done: boolean;
        }
      | undefined;
    let cursor: string | undefined;
    let ordinal = 0;
    const ordinals = new Map<string, number>();
    const drafts = new DraftSnapshots();
    const requests = new Map<
      RuntimeRequestId,
      { nativeId: string; request: OrchestrationV2RuntimeRequest }
    >();
    const messages = new Map<string, OrchestrationV2ConversationMessage>();
    const turns = new Map<string, OrchestrationV2ProviderTurn>();
    const seen = new Set<string>();
    const initialId = input.initialNativeThreadId;

    const nativeId = () => thread?.nativeThreadRef?.nativeId;
    const path = () => {
      const id = nativeId();
      return id ? `/api/threads/${encodeURIComponent(id)}` : undefined;
    };
    const wrap = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isProtocolError(error)
            ? error
            : isHopliteApiError(error)
              ? protocolError(error.message)
              : protocolError(
                  "Hoplite API request failed. Check permissions and cloud thread status.",
                ),
        ),
      );
    const ensureThread = Effect.fnUntraced(function* (
      args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
    ) {
      if (thread) {
        if (thread.appThreadId !== args.threadId)
          return yield* protocolError("A Hoplite session owns one app thread.");
        return thread;
      }
      const existing = args.existingProviderThread;
      if (
        existing &&
        (existing.driver !== driver || existing.providerInstanceId !== options.instanceId)
      )
        return yield* protocolError("Hoplite thread belongs to another provider instance.");
      const remote = existing?.nativeThreadRef?.nativeId ?? initialId;
      if (remote)
        yield* api.request(
          "GET",
          `/api/threads/${encodeURIComponent(remote)}`,
          Schema.Struct({ thread: HopliteThread }),
        );
      const createdAt = yield* DateTime.now;
      thread = existing
        ? { ...existing, providerSessionId: input.providerSessionId, updatedAt: createdAt }
        : {
            id: derive.providerThread({
              driver,
              providerInstanceId: options.instanceId,
              nativeThreadId: remote ?? `pending:${args.threadId}`,
            }),
            driver,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: args.threadId,
            ownerNodeId: null,
            nativeThreadRef: remote ? nativeRef(remote) : null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          };
      yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
      if (remote) {
        yield* loadHistory();
        yield* loadQuestions();
      }
      return thread;
    });

    const baseItem = (
      id: string,
      startedAt: DateTime.Utc,
      streaming = false,
      belongsToActive = true,
    ) => {
      const identity = `${options.instanceId}:${nativeId() ?? thread?.id}:${id}`;
      if (!ordinals.has(id)) ordinals.set(id, ++ordinal);
      return {
        id: derive.turnItemFromProviderItem({ driver, nativeItemId: identity }),
        nodeId: belongsToActive ? (active?.input.rootNodeId ?? null) : null,
        threadId: thread!.appThreadId!,
        runId: belongsToActive ? (active?.input.runId ?? null) : null,
        providerThreadId: thread!.id,
        providerTurnId: belongsToActive ? (active?.turn.id ?? null) : null,
        nativeItemRef: nativeRef(id),
        parentItemId: null,
        ordinal: ordinals.get(id)!,
        status: streaming ? ("running" as const) : ("completed" as const),
        title: null,
        startedAt,
        completedAt: streaming ? null : startedAt,
        updatedAt: startedAt,
      };
    };
    const publishMessage = Effect.fnUntraced(function* (
      message: HopliteMessage,
      streaming = false,
    ) {
      if (!thread) return;
      const updatedAt = yield* DateTime.now;
      const createdAt = time(message.createdAt, updatedAt);
      const belongsToActive = active !== undefined && message.runId === active.nativeRunId;
      const base = baseItem(message.id, createdAt, streaming, belongsToActive);
      if (!streaming) drafts.settle(message.id);
      if (message.kind === "thinking") {
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: { ...base, type: "reasoning", text: message.content, streaming },
        });
        return;
      }
      if (message.kind !== "chat" || message.role === "tool") return;
      const id = derive.messageFromProviderItem({
        driver,
        nativeItemId: `${options.instanceId}:${nativeId()}:${message.id}`,
      });
      const mapped: OrchestrationV2ConversationMessage = {
        id,
        threadId: thread.appThreadId!,
        runId: base.runId,
        nodeId: base.nodeId,
        role:
          message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
        text: message.content,
        attachments: [],
        streaming,
        createdBy: message.role === "user" ? "user" : "agent",
        creationSource: "provider",
        createdAt,
        updatedAt,
      };
      if (
        messages.get(message.id)?.text === mapped.text &&
        messages.get(message.id)?.streaming === streaming
      )
        return;
      messages.set(message.id, mapped);
      yield* emit({ type: "message.updated", driver, message: mapped });
      if (message.role === "assistant")
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...base,
            type: "assistant_message",
            messageId: id,
            text: message.content,
            streaming,
          },
        });
    });

    const loadMessages = Effect.fnUntraced(function* () {
      const root = path();
      if (!root) return;
      let next: string | undefined;
      const collected = new Map<string, HopliteMessage>();
      do {
        const page = yield* api.request(
          "GET",
          `${root}/messages`,
          Schema.Struct({
            messages: Schema.Array(HopliteMessage),
            nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
          }),
          { query: { limit: "100", activityLimit: "0", ...(next ? { cursor: next } : {}) } },
        );
        for (const message of page.messages) collected.set(message.id, message);
        next = page.nextCursor ?? undefined;
      } while (next);
      for (const message of [...collected.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )) {
        if (active && message.id === active.submittedMessageId && message.runId)
          yield* bindRun(message.runId);
        if (active && message.id === active.submittedMessageId) continue;
        yield* publishMessage(message);
      }
    });

    const loadActivity = Effect.fnUntraced(function* () {
      const root = path();
      const turn = active;
      if (!root || !turn?.nativeRunId) return;
      let next: string | undefined;
      do {
        const page = yield* api.request(
          "GET",
          `${root}/runs/${encodeURIComponent(turn.nativeRunId)}/activity`,
          Schema.Struct({
            items: Schema.Array(HopliteActivity),
            nextCursor: Schema.NullOr(Schema.String),
          }),
          { query: { pagination: "cursor", limit: "100", ...(next ? { cursor: next } : {}) } },
        );
        for (const item of page.items) {
          const updatedAt = yield* DateTime.now;
          const running = item.status === "running" || item.status === "pending";
          const base = {
            ...baseItem(item.id, time(item.createdAt, updatedAt), running),
            updatedAt,
            status:
              item.status === "failed" || item.status === "rejected"
                ? ("failed" as const)
                : running
                  ? ("running" as const)
                  : ("completed" as const),
            completedAt: running ? null : time(item.completedAt, updatedAt),
            title: item.description ?? item.toolName ?? null,
          };
          const turnItem: OrchestrationV2TurnItem =
            item.kind === "thinking"
              ? {
                  ...base,
                  type: "reasoning",
                  text: item.outputPreview ?? item.description ?? "",
                  streaming: running,
                }
              : {
                  ...base,
                  type: "dynamic_tool",
                  toolName: item.toolName ?? null,
                  input: item.inputPreview ?? "",
                  output: item.errorPreview ?? item.outputPreview,
                };
          yield* emit({ type: "turn_item.updated", driver, turnItem });
        }
        next = page.nextCursor ?? undefined;
      } while (next);
    });

    const loadQuestions = Effect.fnUntraced(function* () {
      const root = path();
      if (!root || !thread) return;
      const page = yield* api.request(
        "GET",
        `${root}/questions`,
        Schema.Struct({ questions: Schema.Array(HopliteQuestion) }),
      );
      const pendingIds = new Set(page.questions.map((question) => question.questionId));
      for (const [requestId, pending] of requests) {
        if (pending.request.status !== "pending" || pendingIds.has(pending.nativeId)) continue;
        const request = {
          ...pending.request,
          status: "resolved" as const,
          resolvedAt: yield* DateTime.now,
        };
        requests.set(requestId, { ...pending, request });
        yield* emit({ type: "runtime_request.updated", driver, runtimeRequest: request });
      }
      for (const question of page.questions) {
        const requestId = RuntimeRequestId.make(
          `hoplite:${options.instanceId}:${nativeId()}:${question.questionId}`,
        );
        if (requests.has(requestId)) continue;
        const now = yield* DateTime.now;
        const nodeId = derive.approvalNode({ requestId });
        const current = active && question.runId === active.nativeRunId ? active : undefined;
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: current?.turn.id ?? null,
          nativeRequestRef: nativeRef(question.questionId),
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: now,
          resolvedAt: null,
        };
        requests.set(requestId, { nativeId: question.questionId, request });
        yield* emit({
          type: "runtime_request.updated",
          driver,
          threadId: thread.appThreadId!,
          runtimeRequest: request,
        });
        yield* emit({
          type: "node.updated",
          driver,
          node: {
            id: nodeId,
            threadId: thread.appThreadId!,
            runId: current?.input.runId ?? null,
            parentNodeId: current?.input.rootNodeId ?? null,
            rootNodeId: current?.input.rootNodeId ?? nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: thread.id,
            providerTurnId: request.providerTurnId,
            nativeItemRef: nativeRef(question.questionId),
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: request.createdAt,
            completedAt: null,
          },
        });
        const base = {
          ...baseItem(
            `question:${question.questionId}`,
            request.createdAt,
            true,
            current !== undefined,
          ),
          id: derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting" as const,
        };
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...base,
            type: "user_input_request",
            requestId,
            questions: question.request.questions.map((entry) => ({
              ...entry,
              id: entry.question,
              allowCustomAnswer: true,
              required: true,
            })),
          },
        });
      }
    });

    const bindRun = Effect.fnUntraced(function* (id: string) {
      if (!active || active.nativeRunId) return;
      turns.delete(active.turn.id);
      active.nativeRunId = id;
      active.turn = { ...active.turn, nativeTurnRef: nativeRef(id) };
      turns.set(id, active.turn);
      yield* emit({ type: "provider_turn.updated", driver, providerTurn: active.turn });
    });
    const loadHistory = Effect.fnUntraced(function* () {
      const root = path();
      if (!root || !thread) return;
      const history = yield* api.request("GET", `${root}/export`, HopliteTranscript, {
        query: { format: "json", level: "full", subagents: "true" },
      });
      let runOrdinal = 0;
      for (const run of history.runs) {
        const now = yield* DateTime.now;
        const runNodeId = derive.nodeFromProviderItem({
          driver,
          nativeItemId: `${options.instanceId}:${nativeId()}:run:${run.id}`,
        });
        const providerTurn = turns.get(run.id) ?? {
          id: derive.providerTurn({
            driver,
            nativeTurnId: `${options.instanceId}:${nativeId()}:${run.id}`,
          }),
          providerThreadId: thread.id,
          nodeId: runNodeId,
          runAttemptId: null,
          nativeTurnRef: nativeRef(run.id),
          ordinal: ++runOrdinal,
          status:
            run.status === "failed"
              ? ("failed" as const)
              : run.status === "cancelled"
                ? ("cancelled" as const)
                : run.status === "completed"
                  ? ("completed" as const)
                  : ("running" as const),
          startedAt: time(run.createdAt, now),
          completedAt: run.finishedAt ? time(run.finishedAt, now) : null,
        };
        if (run.id !== "unattached") turns.set(run.id, providerTurn);
        for (const entry of run.entries) {
          const createdAt = time(entry.createdAt, now);
          const running = entry.status === "running";
          const base = {
            ...baseItem(entry.id, createdAt, running, run.id === active?.nativeRunId),
            providerTurnId: run.id === "unattached" ? null : providerTurn.id,
            completedAt: running ? null : time(entry.completedAt, now),
            status:
              entry.status === "failed" || entry.status === "rejected"
                ? ("failed" as const)
                : running
                  ? ("running" as const)
                  : ("completed" as const),
          };
          if (entry.type === "message" || entry.type === "thinking") {
            if (entry.id === active?.submittedMessageId) continue;
            yield* publishMessage({
              id: entry.id,
              threadId: nativeId()!,
              runId: run.id,
              role: entry.role === "user" ? "user" : "assistant",
              kind: entry.type === "thinking" ? "thinking" : "chat",
              content: entry.content ?? "",
              createdAt: entry.createdAt,
            });
          } else if (entry.type === "tool_call") {
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...base,
                type: "dynamic_tool",
                toolName: entry.toolName ?? null,
                title: entry.label ?? entry.toolName ?? null,
                input: entry.input ?? "",
                output: entry.error ?? entry.output,
              },
            });
          } else if (entry.type === "compaction") {
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: { ...base, type: "compaction", driver, summary: entry.summary ?? "" },
            });
          } else if (entry.type === "subagent") {
            const nodeId = derive.nodeFromProviderItem({
              driver,
              nativeItemId: `${options.instanceId}:${nativeId()}:subagent:${entry.id}`,
            });
            yield* emit({
              type: "subagent.updated",
              driver,
              subagent: {
                id: nodeId,
                threadId: thread.appThreadId!,
                runId: active?.input.runId ?? null,
                parentNodeId: active?.input.rootNodeId ?? runNodeId,
                origin: "provider_native",
                createdBy: "agent",
                driver,
                providerInstanceId: options.instanceId,
                providerThreadId: thread.id,
                childThreadId: null,
                nativeTaskRef: nativeRef(entry.id),
                prompt: entry.prompt ?? "",
                title: entry.name ?? null,
                model: null,
                status:
                  entry.status === "failed"
                    ? "failed"
                    : entry.status === "interrupted"
                      ? "interrupted"
                      : running
                        ? "running"
                        : "completed",
                result: entry.summary ?? null,
                startedAt: createdAt,
                completedAt: base.completedAt,
                updatedAt: now,
              },
            });
          }
        }
      }
    });
    const finish = Effect.fnUntraced(function* (status: "completed" | "failed" | "cancelled") {
      const turn = active;
      if (!turn || turn.done) return;
      turn.done = true;
      const completedAt = yield* DateTime.now;
      const mapped = status === "cancelled" && turn.interrupted ? "interrupted" : status;
      turn.turn = { ...turn.turn, status: mapped, completedAt };
      turns.set(turn.nativeRunId ?? turn.turn.id, turn.turn);
      yield* emit({ type: "provider_turn.updated", driver, providerTurn: turn.turn });
      const failureDetail =
        status === "failed" && turn.nativeRunId && path()
          ? yield* api
              .request(
                "GET",
                `${path()!}/runs/${encodeURIComponent(turn.nativeRunId)}/failure`,
                Schema.Struct({
                  detail: Schema.NullOr(
                    Schema.Struct({ code: Schema.String, message: Schema.String }),
                  ),
                }),
              )
              .pipe(Effect.option)
          : Option.none();
      const detail = Option.isSome(failureDetail) ? failureDetail.value.detail : null;
      yield* emit(
        status === "failed"
          ? {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.turn.providerThreadId,
              providerTurnId: turn.turn.id,
              runOrdinal: turn.input.runOrdinal,
              failureItemOrdinal: ++ordinal,
              status: "failed",
              failure: makeProviderFailure({
                message:
                  detail?.message ??
                  "Hoplite cloud run failed. Inspect its failure details in the Hoplite workspace.",
                code: detail?.code,
              }),
              threadDisposition: "reusable",
            }
          : {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.turn.providerThreadId,
              providerTurnId: turn.turn.id,
              runOrdinal: turn.input.runOrdinal,
              status: mapped as "completed" | "interrupted" | "cancelled",
              failure: null,
              threadDisposition: "reusable",
            },
      );
    });

    const reconcile = Effect.fnUntraced(function* () {
      yield* loadMessages();
      yield* loadQuestions();
      yield* loadActivity();
      const root = path();
      if (!root || !active?.nativeRunId) return;
      let next: string | undefined;
      do {
        const page = yield* api.request(
          "GET",
          `${root}/runs`,
          Schema.Struct({
            runs: Schema.Array(HopliteRun),
            nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
          }),
          { query: { limit: "100", ...(next ? { cursor: next } : {}) } },
        );
        const run = page.runs.find((run) => run.id === active?.nativeRunId);
        if (run) {
          if (run.status === "completed" || run.status === "failed" || run.status === "cancelled")
            yield* finish(run.status);
          return;
        }
        next = page.nextCursor ?? undefined;
      } while (next);
    });

    const watch = Effect.fnUntraced(function* () {
      const watched = active;
      if (!watched) return;
      let retries = 0;
      while (!watched.done) {
        if (active !== watched) return;
        const id = nativeId();
        if (!id) return;
        const result = yield* api.events({ threadId: id, ...(cursor ? { cursor } : {}) }).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              if (watched.done || active !== watched) return;
              if (frame.event === "heartbeat" || frame.event === "ping") {
                if (frame.id) cursor = frame.id;
                return;
              }
              if (frame.event === "draft.removed") {
                const removed = yield* decodeRemovedDraft(frame.data).pipe(Effect.option);
                if (Option.isSome(removed)) {
                  yield* loadMessages();
                  const draft = messages.get(removed.value.messageId);
                  if (draft?.streaming) {
                    yield* publishMessage({
                      id: removed.value.messageId,
                      threadId: id,
                      runId: watched.nativeRunId,
                      role: "assistant",
                      kind: "chat",
                      content: "",
                      createdAt: DateTime.formatIso(draft.createdAt),
                    });
                  }
                }
                return;
              }
              if (frame.event.startsWith("draft")) {
                const draft = yield* decodeDraft(frame.data).pipe(Effect.option);
                if (Option.isNone(draft)) return;
                if (!drafts.accept(draft.value)) return;
                yield* publishMessage(
                  {
                    id: draft.value.messageId,
                    threadId: id,
                    runId: watched.nativeRunId,
                    role: "assistant",
                    kind:
                      (draft.value.draft?.kind ?? draft.value.kind) === "thinking"
                        ? "thinking"
                        : "chat",
                    content:
                      draft.value.draft?.content ??
                      draft.value.draft?.text ??
                      draft.value.content ??
                      draft.value.text ??
                      "",
                    createdAt: DateTime.formatIso(yield* DateTime.now),
                  },
                  true,
                );
                return;
              }
              const event = yield* decodeEvent(frame.data).pipe(
                Effect.mapError(() => new HopliteApiError({ operation: "decode event" })),
              );
              if (seen.has(event.id)) {
                cursor = frame.id ?? event.cursor;
                return;
              }
              if (event.threadId && event.threadId !== id) return;
              if (event.type.startsWith("run.") && !active?.nativeRunId) yield* loadMessages();
              if (event.type === "message.persisted") yield* loadMessages();
              if (event.type === "tool.updated") yield* loadActivity();
              if (event.type.startsWith("approval.") || event.type === "run.waiting")
                yield* loadQuestions();
              if (
                event.runId === active?.nativeRunId &&
                ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
              ) {
                yield* loadMessages();
                yield* loadActivity();
                yield* finish(
                  event.type === "run.failed"
                    ? "failed"
                    : event.type === "run.cancelled"
                      ? "cancelled"
                      : "completed",
                );
              }
              seen.add(event.id);
              if (seen.size > 4096) seen.delete(seen.values().next().value!);
              cursor = frame.id ?? event.cursor;
              retries = 0;
            }),
          ),
          Stream.takeUntil(() => watched.done),
          Stream.runDrain,
          Effect.result,
        );
        if (watched.done || active !== watched) return;
        if (result._tag === "Failure" && isHopliteApiError(result.failure)) {
          if (result.failure.status === 401 || result.failure.status === 403)
            return yield* protocolError(
              "Hoplite event access expired. Sign in again; the cloud run may still be running.",
            );
          if (result.failure.status === 410) {
            cursor = (yield* api.request(
              "GET",
              "/api/events/head",
              Schema.Struct({ cursor: Schema.String }),
              { query: { threadId: id } },
            )).cursor;
          }
          yield* Effect.sleep(
            result.failure.retryAfter
              ? `${result.failure.retryAfter} seconds`
              : `${Math.min(2 ** retries++, 30)} seconds`,
          );
        } else yield* Effect.sleep("1 second");
        yield* reconcile();
      }
    });

    const upload = Effect.fnUntraced(function* (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      operationId: string,
    ) {
      const initial = !nativeId();
      const root = path() ?? "/api/threads/initial";
      const tickets: string[] = [];
      const attachments: Array<{ artifactId: string; contentType: string; name: string }> = [];
      if (turn.message.attachments.length > 10)
        return yield* protocolError("Hoplite accepts at most 10 attachments per message.");
      for (const attachment of turn.message.attachments) {
        const localPath = host.resolveAttachmentPath(attachment);
        if (!localPath) return yield* protocolError("Cannot resolve the local chat attachment.");
        const bytes = yield* fs.readFile(localPath);
        const key = operationKey("upload", `${operationId}:${attachment.id}`);
        const signed = yield* api.request(
          "POST",
          `${root}/attachments/presign`,
          Schema.Struct({
            upload: Schema.Struct({
              artifactId: Schema.String,
              ticket: Schema.String,
              uploadUrl: Schema.String,
              contentType: Schema.String,
            }),
          }),
          {
            idempotencyKey: key,
            query: initial ? { projectId: options.settings.projectId } : {},
            body: {
              filename: attachment.name,
              contentType: attachment.mimeType,
              byteSize: bytes.length,
              ...(initial ? { initialClientOperationId: operationId } : {}),
            },
          },
        );
        const url = yield* decodeUrl(signed.upload.uploadUrl).pipe(
          Effect.mapError(() => protocolError("Hoplite returned an invalid attachment URL.")),
        );
        if (url.protocol !== "https:")
          return yield* protocolError("Hoplite returned an insecure attachment URL.");
        yield* http
          .execute(
            HttpClientRequest.put(url.toString()).pipe(
              HttpClientRequest.bodyUint8Array(bytes, signed.upload.contentType),
            ),
          )
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        if (initial) tickets.push(signed.upload.ticket);
        else {
          yield* api.request("POST", `${root}/attachments/confirm`, ok, {
            idempotencyKey: operationKey("confirm", key),
            body: { ticket: signed.upload.ticket },
          });
          attachments.push({
            artifactId: signed.upload.artifactId,
            contentType: signed.upload.contentType,
            name: attachment.name,
          });
        }
      }
      return { tickets, attachments };
    });

    const startTurn = Effect.fn("Hoplite.startTurn")(function* (
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      if (active && !active.done)
        return yield* protocolError("A Hoplite cloud run is already active.");
      thread = turnInput.providerThread;
      if (turnInput.runtimePolicy.runtimeMode !== "full-access")
        return yield* protocolError(
          "Hoplite runs in its cloud workspace and cannot enforce local sandbox or approval modes. Select Full access for this provider.",
        );
      if (!nativeId() && !options.settings.projectId.trim())
        return yield* protocolError(
          "Choose a Hoplite cloud project in provider settings before starting a thread.",
        );
      const key = operationKey("message", turnInput.message.messageId);
      cursor = (yield* api.request(
        "GET",
        "/api/events/head",
        Schema.Struct({ cursor: Schema.String }),
        nativeId()
          ? { query: { threadId: nativeId()! } }
          : { query: { projectId: options.settings.projectId } },
      )).cursor;
      const uploaded = yield* upload(turnInput, key);
      const effort =
        option(turnInput.modelSelection, "reasoningEffort") ?? options.settings.reasoning;
      const speed = option(turnInput.modelSelection, "speed") ?? options.settings.speed;
      const catalog = yield* api.request("GET", "/api/model-providers", HopliteModelCatalog);
      const model =
        turnInput.modelSelection.model === "default"
          ? catalog.runConfig.defaultModelId
          : turnInput.modelSelection.model;
      const selectedModel = catalog.models.find((entry) => entry.id === model);
      if (!selectedModel)
        return yield* protocolError(
          "The selected Hoplite model is not available to this credential.",
        );
      if (!nativeId() && selectedModel.capabilities) {
        if (speed === "fast" && !selectedModel.capabilities.supportsFast)
          return yield* protocolError("The selected Hoplite model does not support fast mode.");
        if (
          selectedModel.capabilities.reasoningLevels.length &&
          !selectedModel.capabilities.reasoningLevels.includes(String(effort))
        )
          return yield* protocolError(
            "The selected Hoplite model does not support this reasoning level.",
          );
      }
      let nativeRunId: string | undefined;
      let submittedMessageId = key;
      if (!nativeId()) {
        const result = yield* api.request(
          "POST",
          "/api/threads",
          Schema.Struct({
            thread: HopliteThread,
            run: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
            message: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
          }),
          {
            idempotencyKey: key,
            body: {
              projectId: options.settings.projectId,
              prompt: turnInput.message.text,
              model,
              ...(selectedModel.capabilities?.reasoningLevels.length
                ? { reasoning: { mode: effort } }
                : {}),
              speed,
              spendLimitMicros: options.settings.spendLimitUsd
                ? Math.round(Number(options.settings.spendLimitUsd) * 1_000_000) || null
                : null,
              clientOperationId: key,
              initialMessageId: key,
              ...(uploaded.tickets.length ? { initialAttachmentTickets: uploaded.tickets } : {}),
            },
          },
        );
        thread = {
          ...thread,
          nativeThreadRef: nativeRef(result.thread.id),
          updatedAt: yield* DateTime.now,
        };
        nativeRunId = result.run?.id;
        submittedMessageId = result.message?.id ?? key;
        cursor = (yield* api.request(
          "GET",
          "/api/events/head",
          Schema.Struct({ cursor: Schema.String }),
          { query: { threadId: result.thread.id } },
        )).cursor;
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        yield* emit({
          type: "provider_session.updated",
          driver,
          providerSession: { ...providerSession, updatedAt: yield* DateTime.now },
        });
      } else {
        const result = yield* api.request(
          "POST",
          `${path()!}/messages`,
          Schema.Struct({
            message: Schema.Struct({ id: Schema.String }),
            run: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
          }),
          {
            idempotencyKey: key,
            body: {
              content: turnInput.message.text,
              clientMessageId: key,
              model,
              ...(uploaded.attachments.length ? { attachments: uploaded.attachments } : {}),
            },
          },
        );
        nativeRunId = result.run?.id;
        submittedMessageId = result.message.id;
      }
      const startedAt = yield* DateTime.now;
      const turn: OrchestrationV2ProviderTurn = {
        id: ProviderTurnId.make(`hoplite:${options.instanceId}:${turnInput.attemptId}`),
        providerThreadId: thread.id,
        nodeId: turnInput.rootNodeId,
        runAttemptId: turnInput.attemptId,
        nativeTurnRef: nativeRunId ? nativeRef(nativeRunId) : null,
        ordinal: turnInput.providerTurnOrdinal,
        status: "running",
        startedAt,
        completedAt: null,
      };
      active = {
        input: turnInput,
        turn,
        submittedMessageId,
        interrupted: false,
        done: false,
        ...(nativeRunId ? { nativeRunId } : {}),
      };
      turns.set(nativeRunId ?? turn.id, turn);
      yield* emit({ type: "provider_turn.updated", driver, providerTurn: turn });
      yield* reconcile();
      yield* watch().pipe(
        Effect.catch((error) =>
          Queue.fail(
            events,
            isProtocolError(error)
              ? error
              : protocolError("Hoplite stream disconnected. The cloud run may still be active."),
          ),
        ),
        Effect.forkIn(scope),
      );
    });

    return {
      instanceId: options.instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      providerSession,
      events: Stream.fromQueue(events),
      ensureThread: (args) => wrap(ensureThread(args)),
      resumeThread: (args) =>
        wrap(
          ensureThread({
            threadId: args.threadId ?? args.providerThread.appThreadId!,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }),
        ),
      injectHistory: () => Effect.succeed(false),
      startTurn: (args) => wrap(startTurn(args)),
      steerTurn: (args) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
            driver,
            providerThreadId: args.providerThread.id,
          }),
        ),
      interruptTurn: (args: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
        wrap(
          Effect.gen(function* () {
            if (!active || active.done || !path()) return;
            if (args.providerTurnId !== active.turn.id) return;
            if (!active.nativeRunId) yield* loadMessages();
            if (!active.nativeRunId)
              return yield* protocolError(
                "Hoplite has not assigned the intended run yet. Retry interruption after it starts.",
              );
            yield* api.request("POST", `${path()!}/stop`, ok, {
              idempotencyKey: operationKey("stop", active.input.attemptId),
              body: { runId: active.nativeRunId },
            });
            active.interrupted = true;
          }),
        ),
      respondToRuntimeRequest: (args) =>
        wrap(
          Effect.gen(function* () {
            const pending = requests.get(args.requestId);
            if (!pending || !path())
              return yield* protocolError("This Hoplite question is not available in the session.");
            const answers: Record<string, string> = {};
            for (const [key, value] of Object.entries(args.answers ?? {})) {
              if (typeof value === "string") answers[key] = value;
              else if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
                answers[key] = value.join(", ");
            }
            const body = {
              answers: args.decision === "decline" || args.decision === "cancel" ? null : answers,
            };
            yield* api.request(
              "POST",
              `${path()!}/questions/${encodeURIComponent(pending.nativeId)}`,
              ok,
              { idempotencyKey: operationKey("question", pending.nativeId), body },
            );
            const request = {
              ...pending.request,
              status: "resolved" as const,
              resolvedAt: yield* DateTime.now,
              ...(args.decision ? { decision: args.decision } : {}),
              ...(args.answers ? { answers: args.answers } : {}),
            };
            requests.set(args.requestId, { ...pending, request });
            yield* emit({ type: "runtime_request.updated", driver, runtimeRequest: request });
          }),
        ),
      readThreadSnapshot: (args) =>
        wrap(
          Effect.gen(function* () {
            thread = args.providerThread;
            yield* reconcile();
            yield* loadHistory();
            return {
              providerThread: thread,
              providerTurns: [...turns.values()],
              messages: [...messages.values()],
              runtimeRequests: [...requests.values()].map((entry) => entry.request),
            };
          }),
        ),
      rollbackThread: () =>
        Effect.fail(
          protocolError(
            "Hoplite checkpoints restore cloud workspaces, not conversation history. Use cloud workspace recovery.",
          ),
        ),
      forkThread: () =>
        Effect.fail(protocolError("The public Hoplite API does not support conversation forks.")),
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  });
  return {
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(hopliteCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      openSession(input).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
            }),
        ),
      ),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
});
