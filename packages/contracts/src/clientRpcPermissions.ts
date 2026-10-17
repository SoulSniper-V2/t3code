import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthFilesystemWriteScope,
  AuthPreviewOperateScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { HopliteMutateInput, HopliteReadInput } from "./hoplite.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.hopliteImportThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.hopliteMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeHopliteMutation = Schema.decodeUnknownSync(HopliteMutateInput);
const decodeHopliteRead = Schema.decodeUnknownSync(HopliteReadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.hopliteRead && input !== undefined) {
    const { request } = decodeHopliteRead(input);
    return [
      request.type === "usage" ||
      request.type === "threadUsage" ||
      request.type === "billingPlan" ||
      request.type === "billingSummary"
        ? AuthDiagnosticsReadScope
        : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.hopliteMutate && input !== undefined) {
    const { mutation } = decodeHopliteMutation(input);
    switch (mutation.type) {
      case "createProject":
        return mutation.repositoryId === undefined
          ? [AuthOrchestrationOperateScope, AuthSettingsWriteScope]
          : [AuthOrchestrationOperateScope, AuthSettingsWriteScope, AuthSourceControlWriteScope];
      case "updateProject":
        return [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
      case "deleteProject":
        return [AuthOrchestrationOperateScope];
      case "setEnvironmentVariable":
      case "deleteEnvironmentVariable":
      case "createMcpServer":
      case "updateMcpServer":
      case "deleteMcpServer":
        return [AuthSettingsWriteScope];
      case "setRepositories":
        return [AuthSourceControlWriteScope];
      case "setReviewLoop":
        return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
      case "restoreCheckpoint":
      case "recoverWorkspace":
        return [AuthFilesystemWriteScope, AuthOrchestrationOperateScope];
      case "startPreview":
        return [AuthPreviewOperateScope];
      default:
        return [AuthOrchestrationOperateScope];
    }
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
