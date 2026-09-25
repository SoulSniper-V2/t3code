import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

const environmentId = EnvironmentId.make("t3-orchestration-v2-test-environment");

const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId,
  label: "Orchestration V2 test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: false },
});

/** Stable test identity and descriptor; production still requires its real environment layer. */
export const layer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor),
  }),
);
