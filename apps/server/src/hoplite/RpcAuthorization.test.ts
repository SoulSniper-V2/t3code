import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.hopliteMutate
    > => tag !== WS_METHODS.hopliteMutate,
  ),
);

it.effect.each([
  {
    scopes: [AuthOrchestrationOperateScope, AuthSettingsWriteScope],
    mutation: { type: "createProject", name: "Cloud", repositoryId: "repository" },
    missing: AuthSourceControlWriteScope,
  },
  {
    scopes: [AuthSettingsWriteScope],
    mutation: { type: "deleteProject", projectId: "remote" },
    missing: AuthOrchestrationOperateScope,
  },
  {
    scopes: [AuthOrchestrationOperateScope],
    mutation: {
      type: "setEnvironmentVariable",
      projectId: "remote",
      key: "TOKEN",
      value: "secret",
    },
    missing: AuthSettingsWriteScope,
  },
  {
    scopes: [AuthOrchestrationOperateScope],
    mutation: { type: "startPreview", threadId: "remote" },
    missing: AuthPreviewOperateScope,
  },
  {
    scopes: [AuthSourceControlWriteScope],
    mutation: { type: "setReviewLoop", threadId: "remote", enabled: true },
    missing: AuthOrchestrationOperateScope,
  },
] as const)(
  "rejects Hoplite mutation without $missing before its handler runs",
  ({ scopes, mutation, missing }) =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.hopliteMutate, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.hopliteMutate]({
          instanceId: ProviderInstanceId.make("hoplite-work"),
          idempotencyKey: "stable-write",
          mutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: missing });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
);
