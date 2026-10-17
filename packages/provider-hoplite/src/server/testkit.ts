import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const instanceId = ProviderInstanceId.make("hoplite-test");
export const threadId = ThreadId.make("thread-test");
export const sessionId = ProviderSessionId.make("session-test");
export const selection = { instanceId, model: "model-a" };
export const policy = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  cwd: "/local/repo",
};
export const timestamp = "2026-10-16T12:00:00.000Z";
export const catalog = {
  runConfig: { defaultModelId: "model-a", defaultReasoning: "high", defaultSpeed: "standard" },
  models: [
    {
      id: "model-a",
      name: "Model A",
      provider: "openai",
      capabilities: { reasoningLevels: ["low", "high"], supportsFast: true },
    },
  ],
};

export function makeHost() {
  const values = new Map<string, Uint8Array>();
  return ProviderHost.ProviderHost.of({
    paths: {
      cwd: "/local/repo",
      baseDir: "/test",
      stateDir: "/test/state",
      providerStatusCacheDir: "/test/cache",
      attachmentsDir: "/test/attachments",
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(false),
    resolveAttachmentPath: (attachment) => `/test/attachments/${attachment.id}`,
    credentials: (namespace, id) =>
      Effect.succeed({
        binding: { owner: "t3" as const, key: `${namespace}:${id}` },
        get: Effect.sync(() => Option.fromUndefinedOr(values.get(`${namespace}:${id}`))),
        set: (value) =>
          Effect.sync(() => {
            values.set(`${namespace}:${id}`, value);
          }),
        remove: Effect.sync(() => {
          values.delete(`${namespace}:${id}`);
        }),
      }),
  });
}

export const response = (
  request: HttpClientRequest.HttpClientRequest,
  value: unknown,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

export function requestText(request: HttpClientRequest.HttpClientRequest) {
  return request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
}

export const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  return {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Hoplite test",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${ordinal}`),
      text: "Build the feature",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
  };
});
