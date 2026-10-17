import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { HopliteCredentialStore } from "@t3tools/provider-hoplite/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Base64Url from "effect/encoding/Base64Url";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as HopliteManagement from "./HopliteManagement.ts";

const instanceId = ProviderInstanceId.make("hoplite-work");
const projectId = ProjectId.make("local-project");
const at = "2026-10-16T12:00:00.000Z";
const providerSnapshot: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("hoplite"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [
    {
      slug: "catalog-default",
      name: "Default",
      isDefault: true,
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function harness(options: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly existingProject?: ProjectId;
  readonly configured?: boolean;
}) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const commits: ReadonlyArray<OrchestrationV2DomainEvent>[] = [];
  let shell: OrchestrationV2ThreadShell | null =
    options.existingProject === undefined
      ? null
      : ({ projectId: options.existingProject } as OrchestrationV2ThreadShell);
  const layer = HopliteManagement.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request);
              expect(request.url.startsWith("https://api.hoplite.sh/api/")).toBe(true);
              expect(request.headers.authorization).toBe("Bearer hop_test_key");
              return HttpClientResponse.fromWeb(request, options.response(request));
            }),
          ),
        ),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed(
              options.configured === false
                ? undefined
                : ({
                    driverKind: ProviderDriverKind.make("hoplite"),
                    snapshot: {
                      getSnapshot: Effect.succeed(providerSnapshot),
                    },
                  } as ProviderInstance),
            ),
        }),
        Layer.mock(HopliteCredentialStore)({
          authorization: () =>
            Effect.succeed({ header: "Authorization" as const, value: "Bearer hop_test_key" }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Local",
              workspaceRoot: "/local",
              defaultModelSelection: null,
              scripts: [],
              createdAt: at,
              updatedAt: at,
              deletedAt: null,
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.sync(() => shell),
          assertProviderInstanceEnabled: () => Effect.void,
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              commits.push(events);
              const created = events.find((event) => event.type === "thread.created");
              if (created?.type === "thread.created")
                shell = { projectId: created.payload.projectId } as OrchestrationV2ThreadShell;
              return events.map((event, index) => ({
                sequence: index + 1,
                commandId: null,
                event,
              }));
            }),
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand: (effect) => effect,
        }),
      ),
    ),
  );
  return { layer, requests, commits };
}

describe("Hoplite management", () => {
  it.effect("reads cursor project pages without exposing credentials", () => {
    const test = harness({
      response: () =>
        json({
          ok: true,
          projects: [{ id: "remote", name: "Cloud", apiKey: "must-not-leave-server" }],
          nextCursor: "opaque/?cursor=value",
        }),
    });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      const page = yield* service.listProjects({ instanceId, cursor: "cursor/+=", limit: 20 });
      expect(page).toEqual({
        projects: [{ id: "remote", name: "Cloud" }],
        nextCursor: "opaque/?cursor=value",
      });
      expect(test.requests[0]?.urlParams.params).toEqual(
        expect.arrayContaining([
          ["pagination", "cursor"],
          ["cursor", "cursor/+="],
          ["limit", "20"],
        ]),
      );
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("strips MCP authentication configuration and write-only environment values", () => {
    const test = harness({
      response: (request) =>
        request.url.endsWith("/mcp/servers")
          ? json({
              ok: true,
              servers: [
                {
                  id: "mcp",
                  name: "Private",
                  enabled: true,
                  config: {
                    headers: { Authorization: "secret" },
                    auth: { tokens: { accessToken: "secret" } },
                  },
                },
              ],
            })
          : json({ ok: true, envVars: [{ key: "TOKEN", value: "secret", updatedAt: at }] }),
    });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      expect(yield* service.read({ instanceId, request: { type: "mcpServers" } })).toEqual({
        type: "mcpServers",
        data: { servers: [{ id: "mcp", name: "Private", enabled: true }] },
      });
      expect(
        yield* service.read({
          instanceId,
          request: { type: "environmentVariables", projectId: "remote" },
        }),
      ).toEqual({
        type: "environmentVariables",
        data: { envVars: [{ key: "TOKEN", updatedAt: at }] },
      });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("never enables automatic PR merging and preserves retry identity", () => {
    const test = harness({
      response: () => json({ ok: true, reviewLoop: { enabled: true, autoMerge: false } }),
    });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      yield* service.mutate({
        instanceId,
        idempotencyKey: "same-logical-write",
        mutation: { type: "setReviewLoop", threadId: "remote", enabled: true },
      });
      const request = test.requests[0]!;
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe("https://api.hoplite.sh/api/threads/remote/pr/review-loop");
      expect(request.headers["idempotency-key"]).toBe("same-logical-write");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array")
        expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
          enabled: true,
          autoMerge: false,
        });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "returns safe created resource IDs and operation receipts without MCP credentials",
    () => {
      const test = harness({
        response: () => {
          const response = json(
            {
              ok: true,
              server: {
                id: "mcp",
                name: "Private",
                config: { headers: { Authorization: "secret" } },
              },
              webhookToken: "one-time-secret",
            },
            201,
          );
          response.headers.set("x-operation-id", "operation");
          return response;
        },
      });
      return Effect.gen(function* () {
        const service = yield* HopliteManagement.HopliteManagement;
        expect(
          yield* service.mutate({
            instanceId,
            idempotencyKey: "create-mcp",
            mutation: {
              type: "createMcpServer",
              settings: {
                name: "Private",
                config: {
                  transport: "http",
                  url: "https://mcp.example.test",
                  headers: { Authorization: "secret" },
                },
              },
            },
          }),
        ).toEqual({ ok: true, server: { id: "mcp", name: "Private" }, operationId: "operation" });
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("imports backward-paged history atomically with native IDs, once", () => {
    const test = harness({
      response: (request) => {
        if (!request.url.endsWith("/messages"))
          return json({
            ok: true,
            thread: {
              id: "remote",
              projectId: "cloud-project",
              title: "Existing work",
              modelId: "provider/model",
              createdAt: at,
              updatedAt: at,
            },
          });
        const older = request.urlParams.params.some(([key]) => key === "cursor");
        return json({
          ok: true,
          hasMore: !older,
          messages: [
            {
              id: older ? "first" : "last",
              threadId: "remote",
              role: older ? "user" : "assistant",
              kind: "chat",
              content: older ? "question" : "answer",
              createdAt: older ? "2026-10-16T11:00:00.000Z" : at,
            },
          ],
          nextCursor: older ? null : "older",
        });
      },
    });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      const imported = yield* service.importThread({
        instanceId,
        projectId,
        remoteThreadId: "remote",
      });
      expect(imported.imported).toBe(true);
      expect(test.commits).toHaveLength(1);
      const events = test.commits[0]!;
      expect(events.find((event) => event.type === "thread.created")?.payload).toMatchObject({
        runtimeMode: "full-access",
      });
      expect(
        events
          .filter((event) => event.type === "message.updated")
          .map((event) => event.payload.text),
      ).toEqual(["question", "answer"]);
      const assistant = events.find(
        (event) => event.type === "message.updated" && event.payload.role === "assistant",
      );
      expect(assistant?.type === "message.updated" && assistant.payload.id).toBe(
        derive.messageFromProviderItem({
          driver: ProviderDriverKind.make("hoplite"),
          nativeItemId: `${instanceId}:remote:last`,
        }),
      );
      const provider = events.find((event) => event.type === "provider-thread.updated");
      expect(
        provider?.type === "provider-thread.updated" && provider.payload.nativeThreadRef,
      ).toEqual({ driver: "hoplite", nativeId: "remote", strength: "strong" });
      expect(
        yield* service.importThread({ instanceId, projectId, remoteThreadId: "remote" }),
      ).toEqual({ threadId: imported.threadId, imported: false });
      expect(test.commits).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("refuses to remap an imported remote thread to another local project", () => {
    const test = harness({ existingProject: ProjectId.make("other"), response: () => json({}) });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      const failure = yield* service
        .importThread({ instanceId, projectId, remoteThreadId: "remote" })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("project_conflict");
      expect(test.requests).toHaveLength(0);
      expect(test.commits).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "continues documented backward pagination when an older response omits nextCursor",
    () => {
      const test = harness({
        response: (request) => {
          if (!request.url.endsWith("/messages"))
            return json({ ok: true, thread: { id: "remote", projectId: "cloud-project" } });
          const cursor = request.urlParams.params.find(([key]) => key === "cursor")?.[1];
          if (cursor === undefined)
            return json({
              ok: true,
              hasMore: true,
              messages: [
                {
                  id: "last",
                  threadId: "remote",
                  role: "assistant",
                  kind: "chat",
                  content: "answer",
                  createdAt: at,
                },
              ],
            });
          expect(cursor).toBe(Base64Url.encode(JSON.stringify({ id: "last", createdAt: at })));
          return json({
            ok: true,
            hasMore: false,
            messages: [
              {
                id: "first",
                threadId: "remote",
                role: "user",
                kind: "chat",
                content: "question",
                createdAt: "2026-10-16T11:00:00.000Z",
              },
            ],
          });
        },
      });
      return Effect.gen(function* () {
        const service = yield* HopliteManagement.HopliteManagement;
        yield* service.importThread({ instanceId, projectId, remoteThreadId: "remote" });
        expect(
          test.commits[0]
            ?.filter((event) => event.type === "message.updated")
            .map((event) => event.payload.text),
        ).toEqual(["question", "answer"]);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect.each(["repeated-cursor", "wrong-thread"] as const)(
    "rejects $0 pages before any local commit",
    (failure) => {
      const test = harness({
        response: (request) =>
          request.url.endsWith("/messages")
            ? json({
                ok: true,
                hasMore: true,
                nextCursor: "same",
                messages: [
                  {
                    id: "message",
                    threadId: failure === "wrong-thread" ? "another" : "remote",
                    role: "assistant",
                    kind: "chat",
                    content: "answer",
                    createdAt: at,
                  },
                ],
              })
            : json({ ok: true, thread: { id: "remote", projectId: "cloud-project" } }),
      });
      return Effect.gen(function* () {
        const service = yield* HopliteManagement.HopliteManagement;
        const error = yield* service
          .importThread({ instanceId, projectId, remoteThreadId: "remote" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid_response");
        expect(test.commits).toHaveLength(0);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("does not leak remote error bodies across RPC", () => {
    const test = harness({
      response: () => json({ ok: false, error: "secret-key-and-private-body" }, 403),
    });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      const failure = yield* service.listProjects({ instanceId }).pipe(Effect.flip);
      const rpc = HopliteManagement.toRpcError(failure);
      expect(rpc.reason).toBe("permission_denied");
      expect(rpc.status).toBe(403);
      expect(JSON.stringify(rpc)).not.toContain("secret");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("rejects missing or wrong-provider bindings before any request", () => {
    const test = harness({ configured: false, response: () => json({}) });
    return Effect.gen(function* () {
      const service = yield* HopliteManagement.HopliteManagement;
      expect((yield* service.listProjects({ instanceId }).pipe(Effect.flip)).reason).toBe(
        "not_configured",
      );
      expect(test.requests).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  });
});
