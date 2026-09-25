import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpCreateThreadsInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-created-1");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const PROVIDER_ID = ProviderInstanceId.make("codex");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: PROVIDER_ID,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: {
    readonly failure?: OrchestratorMcpFailure;
  } = {},
) {
  const calls = yield* Ref.make<
    ReadonlyArray<{
      readonly scope: McpInvocationContext.McpInvocationScope;
      readonly input: OrchestratorMcpCreateThreadsInput;
    }>
  >([]);

  const serviceLayer = Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
    createThreads: (scope, input) =>
      Ref.update(calls, (current) => [...current, { scope, input }]).pipe(
        Effect.flatMap(() =>
          options.failure === undefined
            ? Effect.succeed({
                threads: [
                  {
                    threadId: THREAD_ID,
                    runId: null,
                    status: "starting" as const,
                    title: input.threads[0]?.title ?? "Fix the flaky test in auth",
                    createdBy: "agent" as const,
                    creationSource: "mcp" as const,
                    providerInstanceId: PROVIDER_ID,
                    model: input.threads[0]?.target?.model ?? "gpt-5",
                  },
                ],
              })
            : Effect.fail(options.failure),
        ),
      ),
  });
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(serviceLayer))),
  );

  const call = (
    params: Parameters<typeof toolkit.handle<"start_thread">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads", "orchestration"],
  ) =>
    toolkit.handle("start_thread", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<typeof ThreadsToolkit.tools.start_thread>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(serviceLayer),
    );

  return { calls, call };
});

describe("threads toolkit handlers", () => {
  it.effect("requires the fork's threads capability before creating a conversation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ prompt: "Do the thing" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "threads",
        threadId: PARENT_THREAD_ID,
      });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect(
    "routes start_thread through V2 while preserving the provider and checkout inheritance",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call({
          prompt: "Fix the flaky test in auth",
          title: "Auth repair",
          model: "gpt-5-mini",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          clientRequestId: "request-42",
        });

        expect(result).toEqual({ threadId: THREAD_ID, title: "Auth repair" });
        expect(yield* Ref.get(harness.calls)).toMatchObject([
          {
            scope: {
              threadId: PARENT_THREAD_ID,
              providerInstanceId: PROVIDER_ID,
            },
            input: {
              clientRequestId: "request-42",
              threads: [
                {
                  prompt: "Fix the flaky test in auth",
                  title: "Auth repair",
                  target: { providerInstanceId: PROVIDER_ID, model: "gpt-5-mini" },
                  runtimeMode: "approval-required",
                  interactionMode: "plan",
                },
              ],
            },
          },
        ]);
      }),
  );

  it.effect("uses the V2 title and keeps retries on the same request key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.call({
        prompt: "Fix the flaky test in auth",
        clientRequestId: "req-1",
      });
      const retry = yield* harness.call({
        prompt: "Fix the flaky test in auth",
        clientRequestId: "req-1",
      });
      expect(first).toEqual({ threadId: THREAD_ID, title: "Fix the flaky test in auth" });
      expect(retry).toEqual(first);
      expect((yield* Ref.get(harness.calls)).map(({ input }) => input.clientRequestId)).toEqual([
        "req-1",
        "req-1",
      ]);
    }),
  );

  it.effect("surfaces V2 lifecycle errors to the calling agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        failure: new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Thread creation requires an active run.",
        }),
      });
      const error = yield* harness.call({ prompt: "Do the thing" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "parent_not_active",
      });
    }),
  );
});
