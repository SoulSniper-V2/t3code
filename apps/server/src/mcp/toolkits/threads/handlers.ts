import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { ThreadsToolkit } from "./tools.ts";

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer({
  start_thread: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("threads");
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.createThreads(scope, {
        threads: [
          {
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            target: {
              providerInstanceId: scope.providerInstanceId,
              ...(input.model === undefined ? {} : { model: input.model }),
            },
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
          },
        ],
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
      });

      const created = result.threads[0];
      if (created === undefined) {
        return yield* Effect.die(new Error("Orchestrator V2 returned no thread for start_thread."));
      }
      return { threadId: created.threadId, title: created.title };
    }),
});
