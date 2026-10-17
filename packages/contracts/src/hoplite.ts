import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const RemoteId = Id.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const EnvironmentKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.isMaxLength(512),
);
const Text = Schema.String.check(Schema.isMaxLength(100_000));
const NullableText = Schema.NullOr(Schema.String);
const Page = {
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};
const ThreadTarget = { threadId: RemoteId };
const ProjectTarget = { projectId: RemoteId };
const Binding = { instanceId: ProviderInstanceId };
const SandboxSettings = Schema.Struct({
  defaultCpu: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  defaultMemoryGiB: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  maxCpu: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  maxMemoryGiB: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  maxDiskGiB: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  runtimeProfile: Schema.optionalKey(Schema.NullOr(Schema.Literal("docker-compose"))),
});

export const HopliteProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(NullableText),
  defaultBranch: Schema.optionalKey(NullableText),
  previewPort: Schema.optionalKey(Schema.Int),
  setupScript: Schema.optionalKey(NullableText),
  runScript: Schema.optionalKey(NullableText),
  archiveScript: Schema.optionalKey(NullableText),
  instructions: Schema.optionalKey(NullableText),
  defaultModel: Schema.optionalKey(NullableText),
  reasoningEffort: Schema.optionalKey(NullableText),
  agentSpeed: Schema.optionalKey(NullableText),
  prReviewAutofixDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  sandboxSpec: Schema.optionalKey(Schema.NullOr(SandboxSettings)),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type HopliteProject = typeof HopliteProject.Type;

export const HopliteThreadStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "blocked",
  "ready",
  "failed",
  "archived",
]);
export const HopliteThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.optionalKey(NullableText),
  status: Schema.optionalKey(HopliteThreadStatus),
  modelId: Schema.optionalKey(NullableText),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  archivedAt: Schema.optionalKey(NullableText),
  workspaceStatus: Schema.optionalKey(NullableText),
  workspaceSetupStatus: Schema.optionalKey(NullableText),
  latestRunId: Schema.optionalKey(NullableText),
  runStatus: Schema.optionalKey(NullableText),
  spendLimitMicros: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  version: Schema.optionalKey(Schema.Number),
  titleVersion: Schema.optionalKey(Schema.Number),
  archiveVersion: Schema.optionalKey(Schema.Number),
});
export type HopliteThread = typeof HopliteThread.Type;

export const HopliteListProjectsInput = Schema.Struct({ ...Binding, ...Page });
export type HopliteListProjectsInput = typeof HopliteListProjectsInput.Type;
export const HopliteListProjectsResult = Schema.Struct({
  projects: Schema.Array(HopliteProject),
  nextCursor: Schema.optionalKey(NullableText),
});
export type HopliteListProjectsResult = typeof HopliteListProjectsResult.Type;
export const HopliteListThreadsInput = Schema.Struct({
  ...Binding,
  ...Page,
  projectId: Schema.optionalKey(RemoteId),
  status: Schema.optionalKey(HopliteThreadStatus),
  archived: Schema.optionalKey(Schema.Boolean),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type HopliteListThreadsInput = typeof HopliteListThreadsInput.Type;
export const HopliteListThreadsResult = Schema.Struct({
  threads: Schema.Array(HopliteThread),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
  totalCount: Schema.Number,
});
export type HopliteListThreadsResult = typeof HopliteListThreadsResult.Type;

export const HopliteImportThreadInput = Schema.Struct({
  ...Binding,
  projectId: ProjectId,
  remoteThreadId: RemoteId,
});
export type HopliteImportThreadInput = typeof HopliteImportThreadInput.Type;
export const HopliteImportThreadResult = Schema.Struct({
  threadId: ThreadId,
  imported: Schema.Boolean,
});
export type HopliteImportThreadResult = typeof HopliteImportThreadResult.Type;

const ReadRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("project"), ...ProjectTarget }),
  Schema.Struct({ type: Schema.Literal("thread"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("repositories") }),
  Schema.Struct({ type: Schema.Literal("branches"), repositoryId: RemoteId }),
  Schema.Struct({ type: Schema.Literal("projectRepositories"), ...ProjectTarget }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    ...ThreadTarget,
    mode: Schema.optionalKey(Schema.Literals(["uncommitted", "base", "pr"])),
  }),
  Schema.Struct({ type: Schema.Literal("checkpoints"), ...ThreadTarget, ...Page }),
  Schema.Struct({ type: Schema.Literal("questions"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("workspace"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("preview"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("pullRequest"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("pullRequestComments"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("reviewLoop"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("threadUsage"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("usage") }),
  Schema.Struct({ type: Schema.Literal("billingPlan") }),
  Schema.Struct({ type: Schema.Literal("billingSummary") }),
  Schema.Struct({ type: Schema.Literal("models") }),
  Schema.Struct({ type: Schema.Literal("capabilities") }),
  Schema.Struct({ type: Schema.Literal("automations"), ...ProjectTarget }),
  Schema.Struct({ type: Schema.Literal("automationStatus"), ...ProjectTarget }),
  Schema.Struct({
    type: Schema.Literal("automationExecutions"),
    ...ProjectTarget,
    automationId: RemoteId,
    ...Page,
  }),
  Schema.Struct({ type: Schema.Literal("environmentVariables"), ...ProjectTarget }),
  Schema.Struct({ type: Schema.Literal("mcpServers") }),
  Schema.Struct({ type: Schema.Literal("operation"), operationId: RemoteId }),
]);
export const HopliteReadInput = Schema.Struct({ ...Binding, request: ReadRequest });
export type HopliteReadInput = typeof HopliteReadInput.Type;

export const HopliteProjectSettings = Schema.Struct({
  name: Schema.optionalKey(Id),
  description: Schema.optionalKey(Schema.NullOr(Text)),
  defaultBranch: Schema.optionalKey(NullableText),
  previewPort: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 3000, maximum: 9999 })),
  ),
  setupScript: Schema.optionalKey(Schema.NullOr(Text)),
  runScript: Schema.optionalKey(Schema.NullOr(Text)),
  archiveScript: Schema.optionalKey(Schema.NullOr(Text)),
  instructions: Schema.optionalKey(Schema.NullOr(Text)),
  defaultModel: Schema.optionalKey(Schema.NullOr(Id)),
  reasoningEffort: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    ),
  ),
  agentSpeed: Schema.optionalKey(Schema.NullOr(Schema.Literals(["standard", "fast"]))),
  prReviewAutofixDefault: Schema.optionalKey(Schema.Boolean),
  sandboxSpec: Schema.optionalKey(Schema.NullOr(SandboxSettings)),
});
const ProjectCreateSettings = HopliteProjectSettings.mapFields(
  ({ name: _name, sandboxSpec: _sandboxSpec, ...fields }) => fields,
);
const RepositoryInput = Schema.Struct({
  repositoryId: RemoteId,
  sourceControlConnectionId: Schema.optionalKey(RemoteId),
  baseBranch: Schema.optionalKey(NullableText),
});

const AutomationSchedule = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("cron"), expression: Id, timezone: Id }),
  Schema.Struct({
    mode: Schema.Literal("interval"),
    intervalMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
  }),
]);
const AutomationSettings = Schema.Struct({
  name: Schema.optionalKey(Id),
  prompt: Schema.optionalKey(Text),
  enabled: Schema.optionalKey(Schema.Boolean),
  modelId: Schema.optionalKey(Schema.NullOr(Id)),
  schedule: Schema.optionalKey(AutomationSchedule),
  maxSpendPerThreadMicros: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
});
const McpSettings = Schema.Struct({
  name: Id,
  projectId: Schema.optionalKey(Schema.NullOr(Id)),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.Struct({
    transport: Schema.Literals(["http", "sse"]),
    url: Schema.String.check(Schema.isMaxLength(4096)),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
});
const McpPatch = Schema.Struct({
  name: Schema.optionalKey(Id),
  projectId: Schema.optionalKey(Schema.NullOr(RemoteId)),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(
    Schema.Struct({
      transport: Schema.optionalKey(Schema.Literals(["http", "sse"])),
      url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const Mutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("createProject"),
    name: Id,
    settings: Schema.optionalKey(ProjectCreateSettings),
    repositoryId: Schema.optionalKey(Id),
    sourceControlConnectionId: Schema.optionalKey(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("updateProject"),
    ...ProjectTarget,
    settings: HopliteProjectSettings,
  }),
  Schema.Struct({ type: Schema.Literal("deleteProject"), ...ProjectTarget }),
  Schema.Struct({
    type: Schema.Literal("setRepositories"),
    ...ProjectTarget,
    repositories: Schema.Array(RepositoryInput).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    type: Schema.Literal("updateThread"),
    ...ThreadTarget,
    title: Schema.optionalKey(Schema.NullOr(Id)),
    archived: Schema.optionalKey(Schema.Boolean),
    expectedVersion: Schema.optionalKey(Schema.Int),
    expectedTitleVersion: Schema.optionalKey(Schema.Int),
    expectedArchiveVersion: Schema.optionalKey(Schema.Int),
    spendLimitMicros: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  }),
  Schema.Struct({
    type: Schema.Literal("restoreCheckpoint"),
    ...ThreadTarget,
    checkpointId: RemoteId,
  }),
  Schema.Struct({ type: Schema.Literal("recoverWorkspace"), ...ThreadTarget }),
  Schema.Struct({ type: Schema.Literal("startPreview"), ...ThreadTarget }),
  Schema.Struct({
    type: Schema.Literal("answerQuestion"),
    ...ThreadTarget,
    questionId: RemoteId,
    answers: Schema.NullOr(
      Schema.Record(
        Schema.NonEmptyString.check(Schema.isMaxLength(10000)),
        Schema.NonEmptyString.check(Schema.isMaxLength(10000)),
      ),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("setReviewLoop"),
    ...ThreadTarget,
    enabled: Schema.Boolean,
    pullRequestId: Schema.optionalKey(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("createAutomation"),
    ...ProjectTarget,
    settings: Schema.Struct({
      ...AutomationSettings.fields,
      name: Id,
      prompt: Text,
      schedule: AutomationSchedule,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("updateAutomation"),
    ...ProjectTarget,
    automationId: RemoteId,
    settings: AutomationSettings,
  }),
  Schema.Struct({
    type: Schema.Literal("deleteAutomation"),
    ...ProjectTarget,
    automationId: RemoteId,
  }),
  Schema.Struct({
    type: Schema.Literal("runAutomation"),
    ...ProjectTarget,
    automationId: RemoteId,
  }),
  Schema.Struct({
    type: Schema.Literal("setEnvironmentVariable"),
    ...ProjectTarget,
    key: EnvironmentKey,
    value: Schema.String.check(Schema.isMaxLength(32768)),
  }),
  Schema.Struct({
    type: Schema.Literal("deleteEnvironmentVariable"),
    ...ProjectTarget,
    key: EnvironmentKey,
  }),
  Schema.Struct({ type: Schema.Literal("createMcpServer"), settings: McpSettings }),
  Schema.Struct({
    type: Schema.Literal("updateMcpServer"),
    serverId: RemoteId,
    settings: McpPatch,
  }),
  Schema.Struct({ type: Schema.Literal("deleteMcpServer"), serverId: RemoteId }),
]);
export const HopliteMutateInput = Schema.Struct({
  ...Binding,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  mutation: Mutation,
});
export type HopliteMutateInput = typeof HopliteMutateInput.Type;

export class HopliteError extends Schema.TaggedError<HopliteError>()("HopliteError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "not_configured",
    "invalid_response",
    "request_failed",
    "permission_denied",
    "not_found",
    "conflict",
    "rate_limited",
    "import_failed",
    "import_too_large",
    "project_conflict",
  ]),
  status: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    if (this.reason === "import_too_large")
      return "This Hoplite transcript exceeds the import limit of 10,000 messages or 16 million characters. No thread was imported.";
    return `Hoplite ${this.operation} failed (${this.reason}).`;
  }
}

export const HopliteReadResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project"),
    data: Schema.Struct({ project: HopliteProject }),
  }),
  Schema.Struct({ type: Schema.Literal("thread"), data: Schema.Struct({ thread: HopliteThread }) }),
  Schema.Struct({
    type: Schema.Literal("repositories"),
    data: Schema.Struct({
      repositories: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          fullName: Schema.String,
          defaultBranch: Schema.String,
          private: Schema.Boolean,
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("branches"),
    data: Schema.Struct({
      branches: Schema.Array(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("projectRepositories"),
    data: Schema.Struct({
      repositories: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            repoFullName: Schema.String,
            repositoryId: Schema.optionalKey(Schema.String),
            branch: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    data: Schema.Struct({
      diff: Schema.Struct({
        threadId: Schema.String,
        mode: Schema.Literals(["uncommitted", "base", "pr"]),
        files: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            previousPath: Schema.optionalKey(Schema.String),
            state: Schema.optionalKey(
              Schema.Literals([
                "added",
                "modified",
                "deleted",
                "renamed",
                "copied",
                "unmerged",
                "unknown",
              ]),
            ),
            additions: Schema.optionalKey(Schema.Number),
            deletions: Schema.optionalKey(Schema.Number),
            patch: Schema.optionalKey(Schema.String),
            truncated: Schema.optionalKey(Schema.Boolean),
            truncatedReason: Schema.optionalKey(
              Schema.Literals(["file_too_large", "snapshot_too_large", "binary", "generated"]),
            ),
            byteSize: Schema.optionalKey(Schema.Number),
            sha: Schema.optionalKey(Schema.String),
          }),
        ),
        stats: Schema.optionalKey(
          Schema.Struct({
            files: Schema.Number,
            additions: Schema.Number,
            deletions: Schema.Number,
          }),
        ),
        source: Schema.optionalKey(Schema.String),
        effectiveMode: Schema.optionalKey(Schema.Literals(["uncommitted", "base", "pr"])),
        isFallback: Schema.optionalKey(Schema.Boolean),
        unavailableReason: Schema.optionalKey(Schema.String),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoints"),
    data: Schema.Struct({
      nextCursor: Schema.Union([Schema.String, Schema.Null]),
      checkpoints: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          threadId: Schema.String,
          runId: Schema.Union([Schema.String, Schema.Null]),
          label: Schema.Union([Schema.String, Schema.Null]),
          gitCommitSha: Schema.Union([Schema.String, Schema.Null]),
          createdAt: Schema.String,
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("questions"),
    data: Schema.Struct({
      questions: Schema.Array(
        Schema.Struct({
          questionId: Schema.String,
          runId: Schema.Union([Schema.String, Schema.Null]),
          request: Schema.Struct({
            questions: Schema.Array(
              Schema.Struct({
                header: Schema.String,
                multiSelect: Schema.Boolean,
                options: Schema.Array(
                  Schema.Struct({
                    description: Schema.String,
                    label: Schema.String,
                    preview: Schema.optionalKey(Schema.String),
                  }),
                ),
                question: Schema.String,
              }),
            ),
          }),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("workspace"),
    data: Schema.Struct({
      recovery: Schema.Struct({
        bricked: Schema.Boolean,
        canReset: Schema.Boolean,
        canRestoreSnapshot: Schema.Boolean,
        snapshotSupersededAt: Schema.optionalKey(Schema.String),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("preview"),
    data: Schema.Struct({
      preview: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        status: Schema.Literals([
          "ready",
          "unsupported",
          "reconciling",
          "blocked",
          "starting",
          "stopped",
          "crashed",
          "inactive",
        ]),
        port: Schema.optionalKey(Schema.Number),
        url: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
        expiresAt: Schema.optionalKey(Schema.String),
        oomKilled: Schema.optionalKey(Schema.Boolean),
        stopProvenance: Schema.optionalKey(
          Schema.Struct({
            initiator: Schema.Literals(["hoplite", "external", "process"]),
            source: Schema.Literals([
              "managed_stop",
              "signal",
              "process_exit",
              "workspace_archive",
              "lifecycle_reconcile",
            ]),
            phase: Schema.Literals(["starting", "post_ready"]),
            signal: Schema.optionalKey(Schema.Literals(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"])),
            exitCode: Schema.optionalKey(Schema.Number),
            occurredAt: Schema.optionalKey(Schema.String),
            trigger: Schema.optionalKey(Schema.String),
            cause: Schema.optionalKey(
              Schema.Literals([
                "workspace_archive",
                "generation_changed",
                "supervision_lost",
                "exit_unobserved",
              ]),
            ),
            resumeOnRestore: Schema.optionalKey(Schema.Boolean),
          }),
        ),
        requiredResources: Schema.optionalKey(
          Schema.Struct({
            cpu: Schema.optionalKey(Schema.Number),
            memoryGiB: Schema.optionalKey(Schema.Number),
          }),
        ),
        configuredResources: Schema.optionalKey(
          Schema.Struct({
            cpu: Schema.optionalKey(Schema.Number),
            memoryGiB: Schema.optionalKey(Schema.Number),
          }),
        ),
        verification: Schema.optionalKey(
          Schema.Struct({
            http: Schema.Struct({
              statusCode: Schema.Union([Schema.Number, Schema.Null]),
              responseTimeMs: Schema.Union([Schema.Number, Schema.Null]),
              finalUrl: Schema.Union([Schema.String, Schema.Null]),
              contentType: Schema.Union([Schema.String, Schema.Null]),
              isHtmlDocument: Schema.Boolean,
            }),
            browser: Schema.Union([
              Schema.Struct({
                available: Schema.Boolean,
                unavailableReason: Schema.optionalKey(
                  Schema.Literals(["deadline-exhausted", "service-unavailable"]),
                ),
                consoleErrorCount: Schema.Number,
                consoleErrors: Schema.Array(
                  Schema.Struct({
                    message: Schema.String,
                    stack: Schema.optionalKey(Schema.String),
                  }),
                ),
                uncaughtExceptionCount: Schema.Number,
                uncaughtExceptions: Schema.Array(
                  Schema.Struct({
                    message: Schema.String,
                    stack: Schema.optionalKey(Schema.String),
                  }),
                ),
              }),
              Schema.Null,
            ]),
            error: Schema.Union([
              Schema.Struct({
                kind: Schema.String,
                reason: Schema.String,
              }),
              Schema.Null,
            ]),
            verdict: Schema.Struct({
              status: Schema.Literals(["ready", "degraded", "broken"]),
              reason: Schema.String,
            }),
          }),
        ),
        ports: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              status: Schema.Literals([
                "ready",
                "unsupported",
                "reconciling",
                "blocked",
                "starting",
                "stopped",
                "crashed",
                "inactive",
              ]),
              port: Schema.optionalKey(Schema.Number),
              url: Schema.optionalKey(Schema.String),
              reason: Schema.optionalKey(Schema.String),
              expiresAt: Schema.optionalKey(Schema.String),
              oomKilled: Schema.optionalKey(Schema.Boolean),
              stopProvenance: Schema.optionalKey(
                Schema.Struct({
                  initiator: Schema.Literals(["hoplite", "external", "process"]),
                  source: Schema.Literals([
                    "managed_stop",
                    "signal",
                    "process_exit",
                    "workspace_archive",
                    "lifecycle_reconcile",
                  ]),
                  phase: Schema.Literals(["starting", "post_ready"]),
                  signal: Schema.optionalKey(
                    Schema.Literals(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]),
                  ),
                  exitCode: Schema.optionalKey(Schema.Number),
                  occurredAt: Schema.optionalKey(Schema.String),
                  trigger: Schema.optionalKey(Schema.String),
                  cause: Schema.optionalKey(
                    Schema.Literals([
                      "workspace_archive",
                      "generation_changed",
                      "supervision_lost",
                      "exit_unobserved",
                    ]),
                  ),
                  resumeOnRestore: Schema.optionalKey(Schema.Boolean),
                }),
              ),
              requiredResources: Schema.optionalKey(
                Schema.Struct({
                  cpu: Schema.optionalKey(Schema.Number),
                  memoryGiB: Schema.optionalKey(Schema.Number),
                }),
              ),
              configuredResources: Schema.optionalKey(
                Schema.Struct({
                  cpu: Schema.optionalKey(Schema.Number),
                  memoryGiB: Schema.optionalKey(Schema.Number),
                }),
              ),
              verification: Schema.optionalKey(
                Schema.Struct({
                  http: Schema.Struct({
                    statusCode: Schema.Union([Schema.Number, Schema.Null]),
                    responseTimeMs: Schema.Union([Schema.Number, Schema.Null]),
                    finalUrl: Schema.Union([Schema.String, Schema.Null]),
                    contentType: Schema.Union([Schema.String, Schema.Null]),
                    isHtmlDocument: Schema.Boolean,
                  }),
                  browser: Schema.Union([
                    Schema.Struct({
                      available: Schema.Boolean,
                      unavailableReason: Schema.optionalKey(
                        Schema.Literals(["deadline-exhausted", "service-unavailable"]),
                      ),
                      consoleErrorCount: Schema.Number,
                      consoleErrors: Schema.Array(
                        Schema.Struct({
                          message: Schema.String,
                          stack: Schema.optionalKey(Schema.String),
                        }),
                      ),
                      uncaughtExceptionCount: Schema.Number,
                      uncaughtExceptions: Schema.Array(
                        Schema.Struct({
                          message: Schema.String,
                          stack: Schema.optionalKey(Schema.String),
                        }),
                      ),
                    }),
                    Schema.Null,
                  ]),
                  error: Schema.Union([
                    Schema.Struct({
                      kind: Schema.String,
                      reason: Schema.String,
                    }),
                    Schema.Null,
                  ]),
                  verdict: Schema.Struct({
                    status: Schema.Literals(["ready", "degraded", "broken"]),
                    reason: Schema.String,
                  }),
                }),
              ),
            }),
          ),
        ),
        restart: Schema.optionalKey(
          Schema.Struct({
            launchId: Schema.String,
            runId: Schema.String,
            runScriptSha256: Schema.String,
          }),
        ),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("pullRequest"),
    data: Schema.Struct({
      pullRequestStatus: Schema.Struct({
        version: Schema.optionalKey(Schema.Number),
        number: Schema.Number,
        url: Schema.String,
        repoFullName: Schema.String,
        provider: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        title: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        body: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        descriptionAvailable: Schema.optionalKey(Schema.Boolean),
        state: Schema.String,
        draft: Schema.optionalKey(Schema.Boolean),
        mergeable: Schema.optionalKey(Schema.Literals(["mergeable", "conflicting", "unknown"])),
        mergeQueued: Schema.optionalKey(Schema.Boolean),
        mergeQueueRequired: Schema.optionalKey(Schema.Boolean),
        mergeQueueEstimatedMergeAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        checks: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.optionalKey(
                Schema.Union([Schema.Union([Schema.Number, Schema.String]), Schema.Null]),
              ),
              name: Schema.String,
              status: Schema.String,
              conclusion: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              startedAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              completedAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
            }),
          ),
        ),
        checksAvailable: Schema.optionalKey(Schema.Boolean),
        additions: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        deletions: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        changedFiles: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        aheadBy: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        behindBy: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        baseRef: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        headRef: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        headSha: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        allowedMergeMethods: Schema.optionalKey(
          Schema.Array(Schema.Literals(["merge", "squash", "rebase"])),
        ),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("pullRequestComments"),
    data: Schema.Struct({
      pullRequestComments: Schema.Struct({
        number: Schema.Number,
        repoFullName: Schema.String,
        commentsAvailable: Schema.optionalKey(Schema.Boolean),
        unresolvedCount: Schema.Number,
        comments: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              authorLogin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              authorAvatarUrl: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              body: Schema.String,
              createdAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              line: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
              url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              isOutdated: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
        reviewThreads: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
              line: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
              originalLine: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
              startLine: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
              diffSide: Schema.optionalKey(
                Schema.Union([Schema.Literals(["LEFT", "RIGHT"]), Schema.Null]),
              ),
              isResolved: Schema.Boolean,
              isOutdated: Schema.Boolean,
              comments: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  authorLogin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  authorAvatarUrl: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  body: Schema.String,
                  createdAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                  url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
                }),
              ),
            }),
          ),
        ),
        reviewDiff: Schema.optionalKey(
          Schema.Struct({
            headSha: Schema.String,
            baseSha: Schema.String,
            files: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                patch: Schema.String,
              }),
            ),
          }),
        ),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("reviewLoop"),
    data: Schema.Struct({
      reviewLoop: Schema.Union([
        Schema.Struct({
          id: Schema.String,
          threadId: Schema.String,
          pullRequestId: Schema.String,
          enabled: Schema.Boolean,
          autoMerge: Schema.optionalKey(Schema.Boolean),
          status: Schema.Literals([
            "disabled",
            "observing",
            "waiting_checks",
            "fixing",
            "finalizing",
            "ready",
            "blocked",
            "error",
          ]),
          disabledBy: Schema.optionalKey(
            Schema.Union([Schema.Literals(["user", "system", "transferred"]), Schema.Null]),
          ),
          headSha: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          lastProcessedHeadSha: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          lastObservedAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          waitUntil: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          lastFixRunId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          passCount: Schema.Number,
          operationalRetryCount: Schema.optionalKey(Schema.Number),
          lastErrorCode: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          lastErrorMessage: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          blockedReason: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          createdAt: Schema.optionalKey(Schema.String),
          updatedAt: Schema.optionalKey(Schema.String),
        }),
        Schema.Null,
      ]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("threadUsage"),
    data: Schema.Struct({
      usage: Schema.Struct({
        totalCostMicros: Schema.optionalKey(Schema.Number),
        spendLimitMicros: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        threadVersion: Schema.optionalKey(Schema.Number),
        llmCostMicros: Schema.optionalKey(Schema.Number),
        vmCostMicros: Schema.optionalKey(Schema.Number),
        vmCostSource: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        vmCostStatus: Schema.optionalKey(Schema.Literals(["available", "pending", "unavailable"])),
        vmCostProvenance: Schema.optionalKey(
          Schema.Union([Schema.Literals(["billed", "computed", "mixed"]), Schema.Null]),
        ),
        vmCostUpdatedAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        vmCpuSeconds: Schema.optionalKey(Schema.Number),
        vmRamGbSeconds: Schema.optionalKey(Schema.Number),
        vmDiskGbSeconds: Schema.optionalKey(Schema.Number),
        runCount: Schema.optionalKey(Schema.Number),
        usesCodexSubscription: Schema.optionalKey(Schema.Boolean),
        usesGrokSubscription: Schema.optionalKey(Schema.Boolean),
        usesClaudeCodeSubscription: Schema.optionalKey(Schema.Boolean),
        usesByok: Schema.optionalKey(Schema.Boolean),
        usesGateway: Schema.optionalKey(Schema.Boolean),
        inputTokens: Schema.optionalKey(Schema.Number),
        outputTokens: Schema.optionalKey(Schema.Number),
        latestContextTokens: Schema.optionalKey(Schema.Number),
        latestContextSource: Schema.optionalKey(
          Schema.Union([Schema.Literals(["provider", "compaction"]), Schema.Null]),
        ),
        topModel: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        runtimeMs: Schema.optionalKey(Schema.Number),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    data: Schema.Struct({
      usage: Schema.Struct({
        orgId: Schema.String,
        totalCostMicros: Schema.optionalKey(Schema.Number),
        inputTokens: Schema.optionalKey(Schema.Number),
        outputTokens: Schema.optionalKey(Schema.Number),
        events: Schema.optionalKey(Schema.Number),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("billingPlan"),
    data: Schema.Struct({
      plan: Schema.Struct({
        plan: Schema.Literals(["free", "plus", "pro", "scale"]),
        billingInterval: Schema.Literals(["monthly", "annual"]),
        sandboxIdleMinutes: Schema.Number,
        seatCount: Schema.Number,
        fallbackPlan: Schema.optionalKey(Schema.Literals(["free", "plus", "pro", "scale"])),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("billingSummary"),
    data: Schema.Struct({
      billing: Schema.Struct({
        customerId: Schema.String,
        featureId: Schema.String,
        grantedCredits: Schema.optionalKey(Schema.Number),
        remainingCredits: Schema.optionalKey(Schema.Number),
        usedCredits: Schema.optionalKey(Schema.Number),
        heldCredits: Schema.optionalKey(Schema.Number),
        available: Schema.Boolean,
        nextResetAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        includedPeriodStart: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
        includedCredits: Schema.optionalKey(Schema.Number),
        remainingIncludedCredits: Schema.optionalKey(Schema.Number),
        prepaidCredits: Schema.optionalKey(Schema.Number),
        dailyIncludedCredits: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
        remainingDailyIncludedCredits: Schema.optionalKey(
          Schema.Union([Schema.Number, Schema.Null]),
        ),
        creditsNeededToStartRun: Schema.optionalKey(Schema.Number),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("models"),
    data: Schema.Struct({
      modelConfigurationRevision: Schema.String,
      providers: Schema.Array(
        Schema.Struct({
          provider: Schema.Literals([
            "openai",
            "anthropic",
            "google",
            "xai",
            "deepseek",
            "openrouter",
          ]),
          label: Schema.String,
          defaultModelId: Schema.String,
        }),
      ),
      runConfig: Schema.Struct({
        defaultModelId: Schema.String,
        defaultReasoning: Schema.Literals([
          "off",
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
        defaultSpeed: Schema.Literals(["standard", "fast"]),
        defaultsVersion: Schema.Number,
        modelFallbackIds: Schema.Array(Schema.String),
        freePlan: Schema.optionalKey(Schema.Boolean),
        providerMappingsVersion: Schema.Number,
        reasoningOptions: Schema.Array(
          Schema.Literals(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]),
        ),
        speedOptions: Schema.Array(Schema.Literals(["standard", "fast"])),
      }),
      models: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          provider: Schema.String,
          contextVariantOf: Schema.optionalKey(Schema.String),
          compatibleModelIds: Schema.optionalKey(Schema.Array(Schema.String)),
          requiredPlan: Schema.optionalKey(Schema.Literal("pro")),
          usageMultiplier: Schema.optionalKey(Schema.Number),
          pricing: Schema.optionalKey(
            Schema.Struct({
              inputMicrosPerMTok: Schema.Number,
              outputMicrosPerMTok: Schema.Number,
            }),
          ),
          capabilities: Schema.optionalKey(
            Schema.Struct({
              contextWindowTokens: Schema.optionalKey(Schema.Number),
              reasoningLevels: Schema.Array(Schema.String),
              supportsFast: Schema.Boolean,
              supportsImages: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("capabilities"),
    data: Schema.Struct({
      principalId: Schema.String,
      orgId: Schema.String,
      projectIds: Schema.Union([Schema.Array(Schema.String), Schema.Null]),
      permissions: Schema.Union([Schema.Struct({}), Schema.Null]),
      operations: Schema.Array(
        Schema.Struct({
          operationId: Schema.String,
          method: Schema.String,
          path: Schema.String,
          permission: Schema.optionalKey(Schema.String),
          permissions: Schema.Array(Schema.String),
        }),
      ),
      availability: Schema.Struct({}),
      limits: Schema.Struct({
        eventRetentionDays: Schema.Literal(7),
        idempotencyRetentionDays: Schema.Literal(7),
        credentialLifetimeDays: Schema.Literal(90),
        credentialOverlapHours: Schema.Literal(24),
        attachmentMaxBytes: Schema.Number,
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("automations"),
    data: Schema.Struct({
      automations: Schema.Array(
        Schema.Struct({
          modelId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          id: Schema.String,
          projectId: Schema.String,
          repoFullName: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          name: Schema.String,
          enabled: Schema.Boolean,
          triggerKind: Schema.Literals(["webhook", "schedule"]),
          schedule: Schema.optionalKey(
            Schema.Union([
              Schema.Union([
                Schema.Struct({
                  mode: Schema.Literal("cron"),
                  expression: Schema.String,
                  timezone: Schema.String,
                }),
                Schema.Struct({
                  mode: Schema.Literal("interval"),
                  intervalMs: Schema.Number,
                }),
              ]),
              Schema.Null,
            ]),
          ),
          prompt: Schema.String,
          title: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          maxSpendPerThreadMicros: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
          createdAt: Schema.optionalKey(Schema.String),
          updatedAt: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("automationStatus"),
    data: Schema.Struct({
      statuses: Schema.Array(
        Schema.Struct({
          automationId: Schema.String,
          recentExecutions: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                id: Schema.String,
                status: Schema.Literals(["accepted", "thread_created", "failed"]),
                runStatus: Schema.optionalKey(
                  Schema.Union([
                    Schema.Literals([
                      "queued",
                      "running",
                      "waiting",
                      "completed",
                      "failed",
                      "cancelled",
                    ]),
                    Schema.Null,
                  ]),
                ),
                createdAt: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
          lastStatus: Schema.optionalKey(
            Schema.Union([Schema.Literals(["accepted", "thread_created", "failed"]), Schema.Null]),
          ),
          lastRunStatus: Schema.optionalKey(
            Schema.Union([
              Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
              Schema.Null,
            ]),
          ),
          lastError: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          lastExecutionAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          runs30d: Schema.Number,
          succeeded30d: Schema.Number,
          failed30d: Schema.optionalKey(Schema.Number),
          totalCostMicros: Schema.optionalKey(Schema.Number),
        }),
      ),
      totals: Schema.Struct({
        runs30d: Schema.Number,
        succeeded30d: Schema.Number,
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("automationExecutions"),
    data: Schema.Struct({
      executions: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          automationId: Schema.String,
          status: Schema.Literals(["accepted", "thread_created", "failed"]),
          threadId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          createdAt: Schema.optionalKey(Schema.String),
          updatedAt: Schema.optionalKey(Schema.String),
          runStatus: Schema.optionalKey(
            Schema.Union([
              Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
              Schema.Null,
            ]),
          ),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("environmentVariables"),
    data: Schema.Struct({
      envVars: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          updatedAt: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("mcpServers"),
    data: Schema.Struct({
      servers: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          projectId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
          name: Schema.String,
          enabled: Schema.optionalKey(Schema.Boolean),
          createdAt: Schema.optionalKey(Schema.String),
          updatedAt: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("operation"),
    data: Schema.Struct({
      operation: Schema.Struct({
        id: Schema.String,
        operation: Schema.String,
        state: Schema.Literals(["dispatched", "succeeded", "rejected", "unknown"]),
        createdAt: Schema.String,
      }),
    }),
  }),
]);
export type HopliteReadResult = typeof HopliteReadResult.Type;

export const HopliteMutateResult = Schema.Struct({
  ok: Schema.Literal(true),
  project: Schema.optionalKey(HopliteProject),
  thread: Schema.optionalKey(HopliteThread),
  operationId: Schema.optionalKey(Schema.String),
  automation: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      enabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  server: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      enabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  execution: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      status: Schema.optionalKey(Schema.String),
    }),
  ),
  operation: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, state: Schema.optionalKey(Schema.String) }),
  ),
  result: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      threadId: Schema.optionalKey(Schema.String),
      runId: Schema.optionalKey(Schema.String),
      checkpointId: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type HopliteMutateResult = typeof HopliteMutateResult.Type;
