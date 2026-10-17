import {
  CommandId,
  HopliteError,
  type HopliteImportThreadInput,
  type HopliteImportThreadResult,
  type HopliteListProjectsInput,
  HopliteListProjectsResult,
  type HopliteListThreadsInput,
  HopliteListThreadsResult,
  type HopliteMutateInput,
  HopliteMutateResult,
  type HopliteReadInput,
  HopliteReadResult,
  ThreadId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { HttpMethod } from "effect/http/HttpMethod";
import { HopliteCredentialStore } from "@t3tools/provider-hoplite/api";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { mutationRequest, readRequest } from "./operations.ts";
import { importEvents, RemoteMessagesPage } from "./importEvents.ts";

export class HopliteManagementError extends Schema.TaggedError<HopliteManagementError>()(
  "HopliteManagementError",
  {
    operation: Schema.String,
    reason: HopliteError.fields.reason,
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hoplite ${this.operation} failed (${this.reason}).`;
  }
}

export const toRpcError = (error: HopliteManagementError) =>
  new HopliteError({
    operation: error.operation,
    reason: error.reason,
    ...(error.status === undefined ? {} : { status: error.status }),
  });

export class HopliteManagement extends Context.Service<
  HopliteManagement,
  {
    readonly listProjects: (
      input: HopliteListProjectsInput,
    ) => Effect.Effect<HopliteListProjectsResult, HopliteManagementError>;
    readonly listThreads: (
      input: HopliteListThreadsInput,
    ) => Effect.Effect<HopliteListThreadsResult, HopliteManagementError>;
    readonly read: (
      input: HopliteReadInput,
    ) => Effect.Effect<HopliteReadResult, HopliteManagementError>;
    readonly mutate: (
      input: HopliteMutateInput,
    ) => Effect.Effect<HopliteMutateResult, HopliteManagementError>;
    readonly importThread: (
      input: HopliteImportThreadInput,
    ) => Effect.Effect<HopliteImportThreadResult, HopliteManagementError>;
  }
>()("t3/hoplite/HopliteManagement") {}

const decodeRead = Schema.decodeUnknownEffect(HopliteReadResult);
const decodeMutation = Schema.decodeUnknownEffect(HopliteMutateResult);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProjects = Schema.decodeUnknownEffect(HopliteListProjectsResult);
const decodeThreads = Schema.decodeUnknownEffect(HopliteListThreadsResult);
const decodeMessages = Schema.decodeUnknownEffect(RemoteMessagesPage);
const encodeMessageCursor = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
);

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const crypto = yield* Crypto.Crypto;
  const credentials = yield* HopliteCredentialStore;
  const imports = yield* Semaphore.make(1);

  const authorization = Effect.fn("HopliteManagement.authorization")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance?.driverKind !== "hoplite") {
      return yield* new HopliteManagementError({
        operation: "credentials",
        reason: "not_configured",
      });
    }
    return yield* credentials.authorization(instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new HopliteManagementError({
            operation: "credentials",
            reason: "not_configured",
            cause,
          }),
      ),
    );
  });

  const request = Effect.fn("HopliteManagement.request")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly operation: string;
    readonly method: HttpMethod;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  }) {
    const auth = yield* authorization(input.instanceId);
    let outgoing = HttpClientRequest.make(input.method)(`https://api.hoplite.sh${input.path}`).pipe(
      HttpClientRequest.setHeader(auth.header, auth.value),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    if (input.query !== undefined) outgoing = HttpClientRequest.setUrlParams(outgoing, input.query);
    if (input.idempotencyKey !== undefined)
      outgoing = HttpClientRequest.setHeader(outgoing, "Idempotency-Key", input.idempotencyKey);
    if (input.body !== undefined) {
      outgoing = yield* HttpClientRequest.bodyJson(outgoing, input.body).pipe(
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.operation,
              reason: "request_failed",
              cause,
            }),
        ),
      );
    }
    return yield* Effect.gen(function* () {
      const response = yield* http.execute(outgoing).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.operation,
              reason: "request_failed",
              cause,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new HopliteManagementError({
          operation: input.operation,
          reason:
            response.status === 401 || response.status === 403
              ? "permission_denied"
              : response.status === 404
                ? "not_found"
                : response.status === 409
                  ? "conflict"
                  : response.status === 429
                    ? "rate_limited"
                    : "request_failed",
          status: response.status,
        });
      }
      if (response.status === 204) return { ok: true };
      const body = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.runFoldEffect(
          () => "",
          (text, chunk) =>
            text.length + chunk.length > 8_000_000
              ? Effect.fail(
                  new HopliteManagementError({
                    operation: input.operation,
                    reason: "invalid_response",
                  }),
                )
              : Effect.succeed(text + chunk),
        ),
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.operation,
              reason: "invalid_response",
              cause,
            }),
        ),
      );
      const json = yield* decodeJson(body).pipe(
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.operation,
              reason: "invalid_response",
              cause,
            }),
        ),
      );
      const operationId = response.headers["x-operation-id"];
      return input.method !== "GET" &&
        operationId !== undefined &&
        typeof json === "object" &&
        json !== null &&
        !Array.isArray(json)
        ? { ...json, operationId }
        : json;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new HopliteManagementError({
              operation: input.operation,
              reason: "request_failed",
              cause,
            }),
          ),
      }),
    );
  });

  const listProjects: HopliteManagement["Service"]["listProjects"] = Effect.fn(
    "HopliteManagement.listProjects",
  )(function* (input) {
    const query: Record<string, string> = { pagination: "cursor" };
    if (input.cursor !== undefined) query.cursor = input.cursor;
    if (input.limit !== undefined) query.limit = String(input.limit);
    const json = yield* request({
      instanceId: input.instanceId,
      operation: "listProjects",
      method: "GET",
      path: "/api/projects",
      query,
    });
    return yield* decodeProjects(json).pipe(
      Effect.mapError(
        (cause) =>
          new HopliteManagementError({
            operation: "listProjects",
            reason: "invalid_response",
            cause,
          }),
      ),
    );
  });

  const listThreads: HopliteManagement["Service"]["listThreads"] = Effect.fn(
    "HopliteManagement.listThreads",
  )(function* (input) {
    const { instanceId, ...filters } = input;
    const query = Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const json = yield* request({
      instanceId,
      operation: "listThreads",
      method: "GET",
      path: "/api/threads",
      query,
    });
    return yield* decodeThreads(json).pipe(
      Effect.mapError(
        (cause) =>
          new HopliteManagementError({
            operation: "listThreads",
            reason: "invalid_response",
            cause,
          }),
      ),
    );
  });

  const read: HopliteManagement["Service"]["read"] = Effect.fn("HopliteManagement.read")(
    function* (input) {
      const endpoint = readRequest(input.request);
      const json = yield* request({
        instanceId: input.instanceId,
        operation: input.request.type,
        method: "GET",
        ...endpoint,
      });
      return yield* decodeRead({ type: input.request.type, data: json }).pipe(
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.request.type,
              reason: "invalid_response",
              cause,
            }),
        ),
      );
    },
  );

  const mutate: HopliteManagement["Service"]["mutate"] = Effect.fn("HopliteManagement.mutate")(
    function* (input) {
      const endpoint = mutationRequest(input.mutation);
      const json = yield* request({
        instanceId: input.instanceId,
        operation: input.mutation.type,
        idempotencyKey: input.idempotencyKey,
        ...endpoint,
      });
      return yield* decodeMutation(json).pipe(
        Effect.mapError(
          (cause) =>
            new HopliteManagementError({
              operation: input.mutation.type,
              reason: "invalid_response",
              cause,
            }),
        ),
      );
    },
  );

  const importThread: HopliteManagement["Service"]["importThread"] = (input) =>
    imports.withPermits(1)(
      Effect.gen(function* () {
        yield* authorization(input.instanceId);
        const localProject = yield* projects.getById(input.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new HopliteManagementError({
                operation: "importThread",
                reason: "import_failed",
                cause,
              }),
          ),
        );
        if (Option.isNone(localProject))
          return yield* new HopliteManagementError({
            operation: "importThread",
            reason: "not_found",
          });
        const digest = yield* crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(
              `${input.instanceId.length}:${input.instanceId}${input.remoteThreadId}`,
            ),
          )
          .pipe(Effect.map(Hex.encode), Effect.orDie);
        const threadId = ThreadId.make(`hoplite:${digest}`);
        const existing = yield* threads.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new HopliteManagementError({
                operation: "importThread",
                reason: "import_failed",
                cause,
              }),
          ),
        );
        if (existing !== null) {
          if (existing.projectId !== input.projectId)
            return yield* new HopliteManagementError({
              operation: "importThread",
              reason: "project_conflict",
            });
          return { threadId, imported: false };
        }
        const remote = yield* read({
          instanceId: input.instanceId,
          request: { type: "thread", threadId: input.remoteThreadId },
        });
        if (remote.type !== "thread")
          return yield* new HopliteManagementError({
            operation: "importThread",
            reason: "invalid_response",
          });
        const thread = remote.data.thread;
        if (thread.id !== input.remoteThreadId)
          return yield* new HopliteManagementError({
            operation: "importThread",
            reason: "invalid_response",
          });
        let model = thread.modelId;
        if (!model) {
          const instance = yield* instances.getInstance(input.instanceId);
          const snapshot =
            instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
          model =
            snapshot?.models.find((candidate) => candidate.isDefault)?.slug ??
            snapshot?.models[0]?.slug;
          if (model === undefined)
            return yield* new HopliteManagementError({
              operation: "importThread",
              reason: "not_configured",
            });
        }
        const messages: Array<(typeof RemoteMessagesPage.Type)["messages"][number]> = [];
        const seen = new Set<string>();
        let transcriptSize = 0;
        let cursor: string | undefined;
        const now = yield* DateTime.now;
        const messageTime = (createdAt: string) =>
          DateTime.toEpochMillis(Option.getOrElse(DateTime.make(createdAt), () => now));
        do {
          const json = yield* request({
            instanceId: input.instanceId,
            operation: "importThread",
            method: "GET",
            path: `/api/threads/${encodeURIComponent(input.remoteThreadId)}/messages`,
            query: {
              limit: "100",
              activityLimit: "0",
              ...(cursor === undefined ? {} : { cursor }),
            },
          });
          const page = yield* decodeMessages(json).pipe(
            Effect.mapError(
              (cause) =>
                new HopliteManagementError({
                  operation: "importThread",
                  reason: "invalid_response",
                  cause,
                }),
            ),
          );
          if (page.messages.some((message) => message.threadId !== input.remoteThreadId))
            return yield* new HopliteManagementError({
              operation: "importThread",
              reason: "invalid_response",
            });
          messages.push(...page.messages);
          transcriptSize += page.messages.reduce(
            (size, message) => size + message.content.length,
            0,
          );
          cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
          if (page.hasMore && cursor === undefined) {
            const oldest = page.messages.reduce<(typeof page.messages)[number] | undefined>(
              (previous, message) =>
                previous === undefined ||
                messageTime(message.createdAt) < messageTime(previous.createdAt)
                  ? message
                  : previous,
              undefined,
            );
            if (oldest === undefined)
              return yield* new HopliteManagementError({
                operation: "importThread",
                reason: "invalid_response",
              });
            cursor = Base64Url.encode(
              yield* encodeMessageCursor({ id: oldest.id, createdAt: oldest.createdAt }).pipe(
                Effect.mapError(
                  (cause) =>
                    new HopliteManagementError({
                      operation: "importThread",
                      reason: "invalid_response",
                      cause,
                    }),
                ),
              ),
            );
          }
          if (messages.length > 10_000 || transcriptSize > 16_000_000 || seen.size >= 100)
            return yield* new HopliteManagementError({
              operation: "importThread",
              reason: "import_too_large",
            });
          if (cursor !== undefined && seen.has(cursor))
            return yield* new HopliteManagementError({
              operation: "importThread",
              reason: "invalid_response",
            });
          if (cursor !== undefined) seen.add(cursor);
        } while (cursor !== undefined);
        const orderedMessages = [
          ...new Map(messages.map((message) => [message.id, message])).values(),
        ].sort(
          (a, b) => messageTime(a.createdAt) - messageTime(b.createdAt) || a.id.localeCompare(b.id),
        );
        const commandId = CommandId.make(`hoplite-import:${digest}`);
        yield* threads
          .assertProviderInstanceEnabled({
            projectId: input.projectId,
            commandId,
            instanceId: input.instanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new HopliteManagementError({
                  operation: "importThread",
                  reason: "not_configured",
                  cause,
                }),
            ),
          );
        const stored = yield* startup
          .enqueueCommand(
            sink.write({
              events: importEvents({
                binding: input,
                threadId,
                remote: { ...thread, modelId: model },
                messages: orderedMessages,
                now,
              }),
            }),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const raced = yield* threads.getThreadShell(threadId).pipe(
                  Effect.mapError(
                    (readCause) =>
                      new HopliteManagementError({
                        operation: "importThread",
                        reason: "import_failed",
                        cause: readCause,
                      }),
                  ),
                );
                if (raced?.projectId === input.projectId) return [];
                return yield* new HopliteManagementError({
                  operation: "importThread",
                  reason: "import_failed",
                  cause,
                });
              }),
            ),
          );
        return { threadId, imported: stored.length > 0 };
      }),
    );

  return HopliteManagement.of({ listProjects, listThreads, read, mutate, importThread });
});

export const layer = Layer.effect(HopliteManagement, make);
