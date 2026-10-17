import type { HopliteMutateInput, HopliteReadInput } from "@t3tools/contracts";

const segment = (value: string) => encodeURIComponent(value);

export function readRequest(input: HopliteReadInput["request"]) {
  const query: Record<string, string> = {};
  if ("cursor" in input && input.cursor !== undefined) query.cursor = input.cursor;
  if ("limit" in input && input.limit !== undefined) query.limit = String(input.limit);
  const thread = "threadId" in input ? `/api/threads/${segment(input.threadId)}` : "";
  const project = "projectId" in input ? `/api/projects/${segment(input.projectId)}` : "";
  let path: string;
  switch (input.type) {
    case "project":
      path = project;
      break;
    case "thread":
      path = thread;
      break;
    case "repositories":
      path = "/api/source-control/github/repositories";
      break;
    case "branches":
      path = `/api/source-control/github/repositories/${segment(input.repositoryId)}/branches`;
      break;
    case "projectRepositories":
      path = `${project}/repositories`;
      break;
    case "diff":
      path = `${thread}/diff`;
      if (input.mode !== undefined) query.mode = input.mode;
      break;
    case "checkpoints":
      path = `${thread}/checkpoints`;
      break;
    case "questions":
      path = `${thread}/questions`;
      break;
    case "workspace":
      path = `${thread}/workspace/recovery`;
      break;
    case "preview":
      path = `${thread}/preview`;
      break;
    case "pullRequest":
      path = `${thread}/pr/status`;
      break;
    case "pullRequestComments":
      path = `${thread}/pr/comments`;
      break;
    case "reviewLoop":
      path = `${thread}/pr/review-loop`;
      break;
    case "threadUsage":
      path = `${thread}/usage`;
      break;
    case "usage":
      path = "/api/usage";
      break;
    case "billingPlan":
      path = "/api/billing/plan";
      break;
    case "billingSummary":
      path = "/api/billing/summary";
      break;
    case "models":
      path = "/api/model-providers";
      break;
    case "capabilities":
      path = "/api/capabilities";
      break;
    case "automations":
      path = `${project}/automations`;
      break;
    case "automationStatus":
      path = `${project}/automations/status`;
      break;
    case "automationExecutions":
      path = `${project}/automations/${segment(input.automationId)}/executions`;
      break;
    case "environmentVariables":
      path = `${project}/env-vars`;
      break;
    case "mcpServers":
      path = "/api/mcp/servers";
      break;
    case "operation":
      path = `/api/operations/${segment(input.operationId)}`;
      break;
  }
  return { path, query };
}

export function mutationRequest(input: HopliteMutateInput["mutation"]) {
  const thread = "threadId" in input ? `/api/threads/${segment(input.threadId)}` : "";
  const project = "projectId" in input ? `/api/projects/${segment(input.projectId)}` : "";
  const automation =
    "automationId" in input ? `${project}/automations/${segment(input.automationId)}` : "";
  const server = "serverId" in input ? `/api/mcp/servers/${segment(input.serverId)}` : "";
  switch (input.type) {
    case "createProject":
      return {
        method: "POST",
        path: "/api/projects",
        body: {
          ...input.settings,
          name: input.name,
          repositoryId: input.repositoryId,
          sourceControlConnectionId: input.sourceControlConnectionId,
        },
      } as const;
    case "updateProject":
      return { method: "PATCH", path: project, body: input.settings } as const;
    case "deleteProject":
      return { method: "DELETE", path: project } as const;
    case "setRepositories":
      return {
        method: "PUT",
        path: `${project}/repositories`,
        body: { repositories: input.repositories },
      } as const;
    case "updateThread": {
      const { type: _type, threadId: _threadId, ...body } = input;
      return { method: "PATCH", path: thread, body } as const;
    }
    case "restoreCheckpoint":
      return {
        method: "POST",
        path: `${thread}/checkpoints/${segment(input.checkpointId)}/restore`,
        body: {},
      } as const;
    case "recoverWorkspace":
      return {
        method: "POST",
        path: `${thread}/workspace/recovery`,
        body: { action: "restore_snapshot" },
      } as const;
    case "startPreview":
      return { method: "POST", path: `${thread}/preview/start` } as const;
    case "answerQuestion": {
      return {
        method: "POST",
        path: `${thread}/questions/${segment(input.questionId)}`,
        body: { answers: input.answers },
      } as const;
    }
    case "setReviewLoop":
      return {
        method: "PATCH",
        path: `${thread}/pr/review-loop`,
        body: { enabled: input.enabled, pullRequestId: input.pullRequestId, autoMerge: false },
      } as const;
    case "createAutomation":
      return {
        method: "POST",
        path: `${project}/automations`,
        body: {
          ...input.settings,
          triggerKind: "schedule",
          enabled: input.settings.enabled ?? false,
        },
      } as const;
    case "updateAutomation":
      return { method: "PATCH", path: automation, body: input.settings } as const;
    case "deleteAutomation":
      return { method: "DELETE", path: automation } as const;
    case "runAutomation":
      return { method: "POST", path: `${automation}/run`, body: {} } as const;
    case "setEnvironmentVariable":
      return {
        method: "PUT",
        path: `${project}/env-vars/${segment(input.key)}`,
        body: { value: input.value },
      } as const;
    case "deleteEnvironmentVariable":
      return { method: "DELETE", path: `${project}/env-vars/${segment(input.key)}` } as const;
    case "createMcpServer":
      return { method: "POST", path: "/api/mcp/servers", body: input.settings } as const;
    case "updateMcpServer":
      return { method: "PATCH", path: server, body: input.settings } as const;
    case "deleteMcpServer":
      return { method: "DELETE", path: server } as const;
  }
}
