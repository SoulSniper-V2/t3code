import { describe, expect, it } from "@effect/vitest";
import { ChatAttachmentId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import { makeHopliteApi } from "../api.ts";
import { HopliteSettings } from "../settings.ts";
import { makeHopliteAdapter } from "./adapter.ts";
import {
  catalog,
  instanceId,
  makeHost,
  policy,
  requestText,
  response,
  selection,
  sessionId,
  threadId,
  timestamp,
  turnInput,
} from "./testkit.ts";

const decodeSettings = Schema.decodeEffect(HopliteSettings);
const harness = Effect.fnUntraced(function* (
  options: {
    nativeId?: string;
    history?: boolean;
    expireFirstStream?: boolean;
    omitRunHandles?: boolean;
    reasoningLevels?: string[];
    spendLimitUsd?: string;
    createError?: { status: number; error: string; oversized?: boolean };
  } = {},
) {
  const connected = yield* Queue.unbounded<void>();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  let runStatus = "running";
  let messageId = "submitted";
  let submitted = false;
  let questionOpen = true;
  let assistant = "";
  let streamCount = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(request);
      const url = new URL(request.url);
      const route = url.pathname;
      if (route === "/api/events/stream") {
        streamCount++;
        if (options.expireFirstStream && streamCount === 1) {
          yield* Queue.offer(connected, undefined);
          return response(request, { ok: false, error: "cursor_expired" }, 410);
        }
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        });
        yield* Queue.offer(connected, undefined);
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      }
      if (route === "/api/events/head") return response(request, { cursor: `head-${streamCount}` });
      if (route === "/api/model-providers")
        return response(
          request,
          options.reasoningLevels
            ? {
                ...catalog,
                models: catalog.models.map((model) => ({
                  ...model,
                  capabilities: { ...model.capabilities, reasoningLevels: options.reasoningLevels },
                })),
              }
            : catalog,
        );
      if (route.endsWith("/attachments/presign"))
        return response(request, {
          upload: {
            artifactId: "artifact-1",
            ticket: "upload-ticket",
            uploadUrl: "https://storage.hoplite.test/object",
            contentType: "image/png",
          },
        });
      if (route === "/object" || route.endsWith("/attachments/confirm"))
        return response(request, { ok: true });
      if (route === "/api/threads" && request.method === "POST") {
        if (options.createError)
          return response(
            request,
            {
              ok: false,
              error: options.createError.error,
              message: "hop_secret_echo_must_not_leak",
              padding: options.createError.oversized ? "x".repeat(9000) : "",
            },
            options.createError.status,
          );
        const body = JSON.parse(requestText(request));
        submitted = true;
        messageId = body.initialMessageId;
        return response(
          request,
          {
            thread: { id: "remote-1", projectId: "cloud-project", status: "running" },
            ...(options.omitRunHandles
              ? {}
              : { message: { id: messageId }, run: { id: "native-run" } }),
          },
          201,
        );
      }
      if (route === "/api/threads/remote-1")
        return response(request, {
          thread: { id: "remote-1", projectId: "cloud-project", status: "ready" },
        });
      if (route.endsWith("/messages") && request.method === "POST") {
        submitted = true;
        messageId = "submitted-followup";
        return response(request, { message: { id: messageId }, run: { id: "native-run" } }, 201);
      }
      if (route.endsWith("/messages")) {
        const historical = options.history
          ? [
              {
                id: "newer",
                threadId: "remote-1",
                role: "assistant",
                kind: "chat",
                content: "Newer",
                createdAt: "2026-10-16T12:01:00.000Z",
              },
              {
                id: "older",
                threadId: "remote-1",
                role: "user",
                kind: "chat",
                content: "Older",
                createdAt: timestamp,
              },
            ]
          : [];
        const olderPage = UrlParams.getAll(request.urlParams, "cursor").length > 0;
        return response(request, {
          messages:
            options.history && olderPage
              ? [historical[1]]
              : [
                  ...(options.history ? [historical[0]] : []),
                  ...(submitted
                    ? [
                        {
                          id: messageId,
                          threadId: "remote-1",
                          runId: "native-run",
                          role: "user",
                          kind: "chat",
                          content: "Build the feature",
                          createdAt: timestamp,
                        },
                      ]
                    : []),
                  ...(assistant
                    ? [
                        {
                          id: "answer",
                          threadId: "remote-1",
                          runId: "native-run",
                          role: "assistant",
                          kind: "chat",
                          content: assistant,
                          createdAt: timestamp,
                        },
                      ]
                    : []),
                ],
          nextCursor: options.history && !olderPage ? "older-page" : null,
        });
      }
      if (route.endsWith("/export")) return response(request, { runs: [] });
      if (route.endsWith("/questions") && request.method === "GET")
        return response(request, {
          questions:
            submitted && questionOpen
              ? [
                  {
                    questionId: "question-1",
                    runId: "native-run",
                    request: {
                      questions: [
                        {
                          header: "Database",
                          multiSelect: false,
                          question: "Which database?",
                          options: [
                            { label: "SQLite", description: "Embedded" },
                            { label: "Postgres", description: "Server" },
                          ],
                        },
                      ],
                    },
                  },
                ]
              : [],
        });
      if (route.endsWith("/questions/question-1")) {
        questionOpen = false;
        return response(request, { ok: true }, 202);
      }
      if (route.endsWith("/activity"))
        return response(request, {
          items: [
            {
              id: "tool-1",
              kind: "tool",
              status: runStatus === "running" ? "running" : "completed",
              createdAt: timestamp,
              toolName: "shell",
              inputPreview: "pnpm test",
              outputPreview: "passed",
            },
          ],
          nextCursor: null,
        });
      if (route.endsWith("/runs"))
        return response(request, {
          runs: submitted ? [{ id: "native-run", status: runStatus, createdAt: timestamp }] : [],
          nextCursor: null,
        });
      if (route.endsWith("/stop")) {
        runStatus = "cancelled";
        return response(request, { ok: true }, 202);
      }
      if (route.endsWith("/failure"))
        return response(request, {
          detail: { code: "spend_limit_exceeded", message: "Thread spend limit exceeded." },
        });
      throw new Error(`Unexpected fake HTTP request: ${request.method} ${route}`);
    }),
  );
  const api = yield* makeHopliteApi({ apiKey: Effect.succeed("hop_test") }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const settings = yield* decodeSettings({
    enabled: true,
    projectId: "cloud-project",
    spendLimitUsd: options.spendLimitUsd ?? "",
  });
  const adapter = yield* makeHopliteAdapter({ instanceId, settings, api }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ProviderHost.ProviderHost, makeHost()),
    Effect.provide(
      FileSystem.layerNoop({ readFile: () => Effect.succeed(new Uint8Array([1, 2, 3])) }),
    ),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: sessionId,
    modelSelection: selection,
    runtimePolicy: policy,
    ...(options.nativeId ? { initialNativeThreadId: options.nativeId } : {}),
  });
  const all: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        all.push(event);
        yield* Queue.offer(emitted, event);
      }),
    ),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const take = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(type: T) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (event.type === type)
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
    }
  });
  const frame = (event: string, data: unknown, cursor?: string) =>
    Effect.sync(() =>
      controller!.enqueue(
        new TextEncoder().encode(
          `${cursor ? `id: ${cursor}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      ),
    );
  return {
    runtime,
    providerThread,
    calls,
    all,
    take,
    frame,
    connected,
    complete: (status: string, text = "Done") =>
      Effect.sync(() => {
        runStatus = status;
        assistant = text;
      }),
    close: Effect.sync(() => controller!.close()),
  };
});

describe("native Hoplite REST runtime", () => {
  it.effect("converts a dollar-denominated thread budget to the API's integer microdollars", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ spendLimitUsd: "2.50" });
        yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
        yield* Queue.take(h.connected);
        const create = h.calls.find(
          (call) => call.method === "POST" && call.url.endsWith("/threads"),
        )!;
        expect(JSON.parse(requestText(create)).spendLimitMicros).toBe(2_500_000);
      }),
    ),
  );
  it.effect(
    "explains rejected cloud admission with safe billing, sign-in, permission and backoff guidance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const failure of [
            { status: 402, error: "insufficient_credits", expected: "Add credits" },
            { status: 401, error: "invalid_api_key", expected: "Sign in again" },
            { status: 403, error: "forbidden", expected: "permissions" },
            { status: 429, error: "rate_limited", expected: "Wait" },
            { status: 500, error: "hop_secret_unknown_error", expected: "HTTP 500" },
            { status: 500, error: "insufficient_credits", oversized: true, expected: "HTTP 500" },
          ]) {
            const h = yield* harness({ createError: failure });
            const result = yield* h.runtime
              .startTurn(yield* turnInput(h.providerThread))
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag !== "Failure") throw new Error("Expected cloud admission to fail");
            expect(result.failure.detail).toContain(failure.expected);
            expect(result.failure.detail).not.toContain("hop_secret");
            expect(result.failure).not.toHaveProperty("payload");
          }
        }),
      ),
  );
  it.effect("omits reasoning for models that report no supported reasoning levels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ reasoningLevels: [] });
        yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
        yield* Queue.take(h.connected);
        const create = h.calls.find(
          (call) => call.method === "POST" && call.url.endsWith("/threads"),
        )!;
        expect(JSON.parse(requestText(create))).not.toHaveProperty("reasoning");
      }),
    ),
  );
  it.effect(
    "binds asynchronously provisioned runs from the submitted message and surfaces cloud failure details",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ omitRunHandles: true });
          yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
          yield* Queue.take(h.connected);
          yield* h.complete("failed", "");
          yield* h.frame(
            "run.failed",
            {
              id: "failed-event",
              type: "run.failed",
              threadId: "remote-1",
              runId: "native-run",
              cursor: "failure-cursor",
              data: {},
            },
            "failure-cursor",
          );
          const terminal = yield* h.take("turn.terminal");
          expect(terminal.status).toBe("failed");
          expect(terminal.failure).toMatchObject({
            code: "spend_limit_exceeded",
            message: "Thread spend limit exceeded.",
          });
          const updated = h.all.findLast((event) => event.type === "provider_thread.updated");
          if (updated?.type !== "provider_thread.updated")
            throw new Error("Missing cloud thread reference");
          const snapshot = yield* h.runtime.readThreadSnapshot({
            providerThread: updated.providerThread,
          });
          expect(snapshot.providerTurns).toHaveLength(1);
          expect(snapshot.providerTurns[0]?.nativeTurnRef?.nativeId).toBe("native-run");
        }),
      ),
  );
  it.effect(
    "defers cloud creation, streams replaceable drafts, answers real questions and interrupts the intended run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          expect(h.calls.some((call) => call.method === "POST")).toBe(false);
          const turn = yield* turnInput(h.providerThread);
          yield* h.runtime.startTurn(turn);
          yield* Queue.take(h.connected);
          const started = yield* h.take("provider_turn.updated");
          const create = h.calls.find(
            (call) => call.method === "POST" && call.url.endsWith("/threads"),
          )!;
          const body = JSON.parse(requestText(create));
          expect(create.headers["idempotency-key"]).toBe(body.clientOperationId);
          expect(body).toMatchObject({
            projectId: "cloud-project",
            model: "model-a",
            reasoning: { mode: "high" },
          });
          expect(body).not.toHaveProperty("cwd");
          expect(create.headers["x-api-key"]).toBe("hop_test");
          const question = yield* h.take("runtime_request.updated");
          yield* h.runtime.respondToRuntimeRequest({
            requestId: question.runtimeRequest.id,
            answers: { "Which database?": "SQLite" },
          });
          const answerCall = h.calls.find((call) => call.url.endsWith("/questions/question-1"))!;
          expect(JSON.parse(requestText(answerCall))).toEqual({
            answers: { "Which database?": "SQLite" },
          });
          yield* h.frame("draft.updated", {
            messageId: "answer",
            streamId: "draft-1",
            revision: 1,
            content: "Hello",
          });
          yield* h.take("message.updated");
          yield* h.frame("draft.updated", {
            messageId: "answer",
            streamId: "draft-1",
            revision: 2,
            content: "Hello world",
          });
          const draft = yield* h.take("message.updated");
          expect(draft.message.text).toBe("Hello world");
          yield* h.runtime.interruptTurn({
            providerThread: h.providerThread,
            providerTurnId: derive.providerTurn({
              driver: h.providerThread.driver,
              nativeTurnId: "stale",
            }),
          });
          expect(h.calls.some((call) => call.url.endsWith("/stop"))).toBe(false);
          yield* h.runtime.interruptTurn({
            providerThread: h.providerThread,
            providerTurnId: started.providerTurn.id,
          });
          const stop = h.calls.find((call) => call.url.endsWith("/stop"))!;
          expect(JSON.parse(requestText(stop))).toEqual({ runId: "native-run" });
          yield* h.frame(
            "run.cancelled",
            {
              id: "evt-1",
              type: "run.cancelled",
              threadId: "remote-1",
              runId: "native-run",
              cursor: "opaque-cursor",
              data: { status: "cancelled" },
            },
            "opaque-cursor",
          );
          const terminal = yield* h.take("turn.terminal");
          expect(terminal.status).toBe("interrupted");
          expect(h.calls.filter((call) => call.url.endsWith("/export"))).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "resumes a native thread and sorts all backward message pages before emitting stable history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ nativeId: "remote-1", history: true });
          const snapshot = yield* h.runtime.readThreadSnapshot({
            providerThread: h.providerThread,
          });
          expect(snapshot.messages.map((message) => message.text)).toEqual(["Older", "Newer"]);
          expect(
            h.calls
              .filter((call) => call.method === "GET" && call.url.endsWith("/messages"))
              .every(
                (call) =>
                  Option.getOrThrow(UrlParams.getFirst(call.urlParams, "activityLimit")) === "0",
              ),
          ).toBe(true);
          expect(h.calls.some((call) => call.method === "POST")).toBe(false);
          yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
          yield* Queue.take(h.connected);
          const afterStart = yield* h.runtime.readThreadSnapshot({
            providerThread: h.providerThread,
          });
          expect(
            afterStart.messages
              .filter((message) => message.text === "Older" || message.text === "Newer")
              .every((message) => message.runId === null),
          ).toBe(true);
          expect(
            h.calls.filter((call) => call.method === "POST" && call.url.endsWith("/threads")),
          ).toHaveLength(0);
          expect(
            h.calls.some((call) => call.method === "POST" && call.url.endsWith("/messages")),
          ).toBe(true);
        }),
      ),
  );

  it.effect("reconciles a completed run after disconnect without sending its prompt again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
        yield* Queue.take(h.connected);
        yield* h.complete("completed", "Recovered result");
        yield* h.close;
        const terminal = yield* h.take("turn.terminal").pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(terminal)).status).toBe("completed");
        expect(
          h.all.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "Recovered result",
          ),
        ).toBe(true);
        expect(
          h.calls.filter((call) => call.method === "POST" && call.url.endsWith("/threads")),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "recovers an expired cursor using a fresh thread-filtered head before snapshots and reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ expireFirstStream: true });
          yield* h.runtime.startTurn(yield* turnInput(h.providerThread));
          yield* Queue.take(h.connected);
          yield* TestClock.adjust("1 second");
          yield* Queue.take(h.connected);
          const streams = h.calls.filter((call) => call.url.endsWith("/api/events/stream"));
          expect(streams).toHaveLength(2);
          expect(streams[1]?.headers["last-event-id"]).toBe("head-1");
          const freshHeadIndex = h.calls.findLastIndex((call) =>
            call.url.endsWith("/api/events/head"),
          );
          expect(
            Option.getOrThrow(UrlParams.getFirst(h.calls[freshHeadIndex]!.urlParams, "threadId")),
          ).toBe("remote-1");
          expect(
            h.calls.slice(freshHeadIndex + 1).some((call) => call.url.endsWith("/messages")),
          ).toBe(true);
          expect(
            h.calls.filter((call) => call.method === "POST" && call.url.endsWith("/threads")),
          ).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "uploads attachment bytes without forwarding Hoplite credentials and redeems initial tickets on creation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const turn = yield* turnInput(h.providerThread);
          yield* h.runtime.startTurn({
            ...turn,
            message: {
              ...turn.message,
              attachments: [
                {
                  type: "image",
                  id: ChatAttachmentId.make("image-1"),
                  name: "screen.png",
                  mimeType: "image/png",
                  sizeBytes: 3,
                },
              ],
            },
          });
          yield* Queue.take(h.connected);
          const upload = h.calls.find((call) => call.method === "PUT")!;
          expect(upload.headers["x-api-key"]).toBeUndefined();
          expect(upload.headers.authorization).toBeUndefined();
          expect(upload.body._tag === "Uint8Array" && [...upload.body.body]).toEqual([1, 2, 3]);
          const presign = h.calls.find((call) => call.url.endsWith("/attachments/presign"))!;
          const create = h.calls.find(
            (call) => call.method === "POST" && call.url.endsWith("/threads"),
          )!;
          expect(JSON.parse(requestText(create)).initialAttachmentTickets).toEqual([
            "upload-ticket",
          ]);
          expect(JSON.parse(requestText(presign)).initialClientOperationId).toBe(
            create.headers["idempotency-key"],
          );
        }),
      ),
  );
});
