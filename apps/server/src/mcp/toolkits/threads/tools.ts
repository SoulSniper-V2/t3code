import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestratorMcpService.OrchestratorMcpService,
];

export const StartThreadInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(200_000)).annotate({
    description:
      "The first user message of the new thread. It must stand on its own: the new agent cannot see this conversation.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Thread title. Omit to let T3 Code generate one from the prompt.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model id on this thread's provider. Defaults to this thread's model. The provider is never changed.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({ description: "Permission mode. Defaults to this thread's mode." }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description: "default or plan. Defaults to this thread's mode.",
    }),
  ),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description:
        "Stable id you choose for this call. A retry with the same id lands on the same thread with the same first turn instead of starting a second one.",
    }),
  ),
});
export type StartThreadInput = typeof StartThreadInput.Type;

export const StartThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
});
export type StartThreadResult = typeof StartThreadResult.Type;

export const StartThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);
export type StartThreadToolError = typeof StartThreadToolError.Type;

export const StartThreadTool = Tool.make("start_thread", {
  description:
    "Start a new top-level T3 Code conversation in this thread's project and send it a first message. It inherits this thread's provider, checkout, and worktree; the model and modes can be overridden within the caller's permissions. This creates a separate conversation, not a delegated subagent. The new thread is linked to this run and can be inspected through the thread tools. Use it only when the user asks for a separate conversation or ongoing work. Two threads editing one checkout can collide, so split work by files.",
  parameters: StartThreadInput,
  success: StartThreadResult,
  failure: StartThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a T3 Code thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(StartThreadTool);
