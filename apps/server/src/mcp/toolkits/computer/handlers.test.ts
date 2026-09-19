// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerAppsHandler, ComputerClickHandler, ComputerTypeHandler } from "./handlers.ts";

const invocationScope = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("instance-1"),
  capabilities: new Set(capabilities),
  issuedAt: Date.now(),
});

const ComputerTestLayer = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope(capabilities)).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(ComputerTestLayer(["computer"]))("ComputerHandlers (with permission)", (it) => {
  it.effect("lists running native applications or returns empty on unsupported platform", () =>
    Effect.gen(function* () {
      const res = yield* ComputerAppsHandler();
      expect(Array.isArray(res.apps)).toBe(true);
    }),
  );

  it.effect("clicks screen coordinates successfully", () =>
    Effect.gen(function* () {
      const res = yield* ComputerClickHandler({ x: 100, y: 100, button: "left" });
      expect(res.success).toBe(true);
      expect(res.x).toBe(100);
      expect(res.y).toBe(100);
    }),
  );

  it.effect("types text", () =>
    Effect.gen(function* () {
      const res = yield* ComputerTypeHandler({ text: "test" });
      expect(res.success).toBe(true);
      expect(res.charactersTyped).toBe(4);
    }),
  );
});

it.layer(ComputerTestLayer([]))("ComputerHandlers (without permission)", (it) => {
  it.effect("fails when computer capability is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(ComputerAppsHandler());
      expect(exit._tag).toBe("Failure");
    }),
  );
});
