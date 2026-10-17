import {
  AuthDiagnosticsReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthSourceControlWriteScope,
  type HopliteThread,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  HopliteField,
  HopliteFold,
  HopliteLink,
  Metrics,
  QueryFeedback,
  micros,
  useHopliteMutation,
  useHopliteRead,
  type HopliteTarget,
  type ReadData,
} from "./HopliteWorkspaceShared";

type ThreadProps = HopliteTarget & { readonly thread: HopliteThread };

export function HopliteThreadDetails(props: ThreadProps) {
  return (
    <div className="min-w-0 border-t pt-2">
      <HopliteFold title="Changes">
        <ThreadDiff {...props} />
      </HopliteFold>
      <HopliteFold title="Checkpoints">
        <ThreadCheckpoints {...props} />
      </HopliteFold>
      <HopliteFold title="Questions">
        <ThreadQuestions {...props} />
      </HopliteFold>
      <HopliteFold title="Workspace and preview">
        <ThreadWorkspace {...props} />
      </HopliteFold>
      <HopliteFold title="Pull request">
        <ThreadPullRequest {...props} />
      </HopliteFold>
      <HopliteFold title="Usage">
        <ThreadUsage {...props} />
      </HopliteFold>
    </div>
  );
}

function ThreadDiff(props: ThreadProps) {
  const [mode, setMode] = useState<"uncommitted" | "base" | "pr">("uncommitted");
  const { result, data, refresh } = useHopliteRead(props, {
    type: "diff",
    threadId: props.thread.id,
    mode,
  });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {(["uncommitted", "base", "pr"] as const).map((value) => (
          <Button
            key={value}
            size="xs"
            variant={value === mode ? "secondary" : "outline"}
            onClick={() => setMode(value)}
          >
            {value === "uncommitted"
              ? "Working changes"
              : value === "base"
                ? "Base branch"
                : "Pull request"}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <QueryFeedback result={result} refresh={refresh} empty={data?.diff.files.length === 0} />
      {data?.diff.isFallback ? (
        <p className="text-xs text-muted-foreground">
          Showing {data.diff.effectiveMode ?? "available"} changes instead.{" "}
          {data.diff.unavailableReason}
        </p>
      ) : null}
      {data?.diff.files.map((file) => (
        <details key={file.path} className="min-w-0 rounded-md border p-2">
          <summary className="cursor-pointer break-all text-xs">
            {file.path}{" "}
            <span className="text-muted-foreground">
              +{file.additions ?? 0} −{file.deletions ?? 0}
              {file.state ? ` · ${file.state}` : ""}
            </span>
          </summary>
          {file.patch ? (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre text-2xs">{file.patch}</pre>
          ) : (
            <p className="py-2 text-xs text-muted-foreground">No text patch available.</p>
          )}
          {file.truncated ? (
            <p className="text-xs text-muted-foreground">
              Incomplete patch: {file.truncatedReason ?? "size limit"}.
            </p>
          ) : null}
        </details>
      ))}
    </>
  );
}

function ThreadCheckpoints(props: ThreadProps) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<ReadonlyArray<string | undefined>>([]);
  const { data, result, refresh } = useHopliteRead(props, {
    type: "checkpoints",
    threadId: props.thread.id,
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const { mutate, writable, busy } = useHopliteMutation(props, [
    AuthFilesystemWriteScope,
    AuthOrchestrationOperateScope,
  ]);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Restores the cloud workspace, not the repository on this device. Later cloud work may be
        discarded.
      </p>
      <QueryFeedback result={result} refresh={refresh} empty={data?.checkpoints.length === 0} />
      {data?.checkpoints.map((checkpoint) => (
        <div key={checkpoint.id} className="flex items-center justify-between gap-3 text-xs">
          <div className="min-w-0">
            <p>{checkpoint.label ?? checkpoint.gitCommitSha?.slice(0, 10) ?? "Checkpoint"}</p>
            <p className="text-muted-foreground">{checkpoint.createdAt}</p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={!writable || busy}
            onClick={async () => {
              if (
                await mutate(
                  {
                    type: "restoreCheckpoint",
                    threadId: props.thread.id,
                    checkpointId: checkpoint.id,
                  },
                  "Restore this cloud checkpoint? Later cloud workspace changes may be lost.",
                  true,
                )
              )
                refresh();
            }}
          >
            Restore
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!previous.length || result.waiting}
          onClick={() => {
            setCursor(previous.at(-1));
            setPrevious(previous.slice(0, -1));
          }}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!data?.nextCursor || result.waiting}
          onClick={() => {
            if (!data?.nextCursor) return;
            setPrevious([...previous, cursor]);
            setCursor(data.nextCursor);
          }}
        >
          Next
        </Button>
        <Button size="xs" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>
    </>
  );
}

function ThreadQuestions(props: ThreadProps) {
  const { data, result, refresh } = useHopliteRead(props, {
    type: "questions",
    threadId: props.thread.id,
  });
  return (
    <>
      <QueryFeedback result={result} refresh={refresh} empty={data?.questions.length === 0} />
      {data?.questions.map((question) => (
        <QuestionForm key={question.questionId} {...props} question={question} refresh={refresh} />
      ))}
      <div>
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh questions
        </Button>
      </div>
    </>
  );
}

function QuestionForm(
  props: ThreadProps & {
    readonly question: ReadData<"questions">["questions"][number];
    readonly refresh: () => void;
  },
) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const { mutate, writable, busy } = useHopliteMutation(props);
  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await mutate({
            type: "answerQuestion",
            threadId: props.thread.id,
            questionId: props.question.questionId,
            answers,
          })
        )
          props.refresh();
      }}
    >
      {props.question.request.questions.map((question) => (
        <fieldset key={question.question} className="grid gap-2" disabled={!writable || busy}>
          <legend className="mb-2 text-xs font-medium">
            {question.header}: {question.question}
          </legend>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Button
                key={option.label}
                type="button"
                size="xs"
                variant={
                  answers[question.question]?.split(", ").includes(option.label)
                    ? "secondary"
                    : "outline"
                }
                title={option.description}
                onClick={() =>
                  setAnswers((current) => {
                    const values = (current[question.question] ?? "").split(", ").filter(Boolean);
                    return {
                      ...current,
                      [question.question]: question.multiSelect
                        ? (values.includes(option.label)
                            ? values.filter((value) => value !== option.label)
                            : [...values, option.label]
                          ).join(", ")
                        : option.label,
                    };
                  })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
          <HopliteField
            label={
              question.multiSelect
                ? "Answer (separate multiple choices with commas)"
                : "Answer or other response"
            }
            value={answers[question.question] ?? ""}
            onChange={(value) => setAnswers({ ...answers, [question.question]: value })}
            required
          />
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="xs"
          disabled={
            !writable ||
            busy ||
            props.question.request.questions.some((question) => !answers[question.question]?.trim())
          }
        >
          Send answers
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!writable || busy}
          onClick={async () => {
            if (
              await mutate(
                {
                  type: "answerQuestion",
                  threadId: props.thread.id,
                  questionId: props.question.questionId,
                  answers: null,
                },
                "Decline these questions? The agent will continue without an answer.",
              )
            )
              props.refresh();
          }}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

function ThreadWorkspace(props: ThreadProps) {
  const recovery = useHopliteRead(props, { type: "workspace", threadId: props.thread.id });
  const preview = useHopliteRead(props, { type: "preview", threadId: props.thread.id });
  const recoveryAction = useHopliteMutation(props, [
    AuthFilesystemWriteScope,
    AuthOrchestrationOperateScope,
  ]);
  const previewAction = useHopliteMutation(props, [AuthPreviewOperateScope]);
  return (
    <>
      <Metrics
        items={[
          ["Cloud workspace", props.thread.workspaceStatus ?? "Not reported"],
          ["Setup", props.thread.workspaceSetupStatus ?? "Not reported"],
        ]}
      />
      <QueryFeedback result={recovery.result} refresh={recovery.refresh} />
      {recovery.data ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {recovery.data.recovery.bricked ? "Workspace needs recovery" : "No recovery required"}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={
              !recoveryAction.writable ||
              recoveryAction.busy ||
              !recovery.data.recovery.canRestoreSnapshot
            }
            onClick={async () => {
              if (
                await recoveryAction.mutate(
                  { type: "recoverWorkspace", threadId: props.thread.id },
                  "Recover this cloud workspace from its saved snapshot?",
                  true,
                )
              )
                recovery.refresh();
            }}
          >
            Restore saved workspace
          </Button>
        </div>
      ) : null}
      <QueryFeedback result={preview.result} refresh={preview.refresh} />
      {preview.data ? (
        <>
          <Metrics
            items={[
              ["Preview", preview.data.preview.status],
              ["Port", preview.data.preview.port ?? "Not reported"],
            ]}
          />
          {preview.data.preview.reason ? (
            <p className="text-xs text-muted-foreground">{preview.data.preview.reason}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                !previewAction.writable ||
                previewAction.busy ||
                preview.data.preview.status === "unsupported"
              }
              onClick={async () => {
                if (
                  await previewAction.mutate(
                    { type: "startPreview", threadId: props.thread.id },
                    "Start this cloud preview? This can resume a workspace and incur usage.",
                  )
                )
                  preview.refresh();
              }}
            >
              Start preview
            </Button>
            <HopliteLink
              href={`https://app.hoplite.sh/threads/${encodeURIComponent(props.thread.id)}?tab=preview`}
            >
              Open preview in Hoplite
            </HopliteLink>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                preview.refresh();
                recovery.refresh();
              }}
            >
              Refresh status
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

function ThreadPullRequest(props: ThreadProps) {
  const pr = useHopliteRead(props, { type: "pullRequest", threadId: props.thread.id });
  return (
    <>
      <QueryFeedback
        result={pr.result}
        refresh={pr.refresh}
        missing="No pull request is linked to this conversation."
      />
      {pr.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <HopliteLink href={pr.data.pullRequestStatus.url}>
              PR #{pr.data.pullRequestStatus.number}
            </HopliteLink>
            <span className="text-xs text-muted-foreground">
              {pr.data.pullRequestStatus.state}
              {pr.data.pullRequestStatus.draft ? " · Draft" : ""} ·{" "}
              {pr.data.pullRequestStatus.mergeable ?? "Mergeability unknown"}
            </span>
            <Button size="xs" variant="ghost" onClick={pr.refresh}>
              Refresh
            </Button>
          </div>
          <p className="text-sm">{pr.data.pullRequestStatus.title}</p>
          {pr.data.pullRequestStatus.checksAvailable === false ? (
            <p className="text-xs text-muted-foreground">Checks are not available.</p>
          ) : (
            pr.data.pullRequestStatus.checks?.map((check) => (
              <div
                key={check.id ?? `${check.name}-${check.startedAt ?? check.url ?? "check"}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span>
                  {check.name}: {check.conclusion ?? check.status}
                </span>
                {check.url ? <HopliteLink href={check.url}>Details</HopliteLink> : null}
              </div>
            ))
          )}
          <HopliteFold title="Review comments">
            <ThreadComments {...props} />
          </HopliteFold>
          <HopliteFold title="Automatic review fixes">
            <ThreadReviewLoop {...props} />
          </HopliteFold>
        </>
      ) : null}
    </>
  );
}

function ThreadComments(props: ThreadProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "pullRequestComments",
    threadId: props.thread.id,
  });
  return (
    <>
      <QueryFeedback
        result={result}
        refresh={refresh}
        missing="No pull request comments are available for this conversation."
      />
      {data ? (
        <>
          <p className="text-xs text-muted-foreground">
            {data.pullRequestComments.unresolvedCount} unresolved review threads
          </p>
          {data.pullRequestComments.comments?.map((comment) => (
            <div key={comment.id} className="grid gap-1 rounded-md border p-2 text-xs">
              <p className="text-muted-foreground">
                {comment.authorLogin ?? "Reviewer"}
                {comment.path ? ` · ${comment.path}` : ""}
              </p>
              <p className="whitespace-pre-wrap break-words">{comment.body}</p>
              {comment.url ? (
                <div>
                  <HopliteLink href={comment.url}>Open comment</HopliteLink>
                </div>
              ) : null}
            </div>
          ))}
          {data.pullRequestComments.reviewThreads
            ?.filter((thread) => !thread.isResolved)
            .map((thread) => (
              <div key={thread.id} className="grid gap-2 rounded-md border p-2 text-xs">
                <p className="text-muted-foreground">
                  {thread.path ?? "Review thread"}
                  {thread.line ? `:${thread.line}` : ""}
                </p>
                {thread.comments.map((comment) => (
                  <p className="whitespace-pre-wrap break-words" key={comment.id}>
                    {comment.authorLogin ?? "Reviewer"}: {comment.body}
                  </p>
                ))}
              </div>
            ))}
        </>
      ) : null}
    </>
  );
}

function ThreadReviewLoop(props: ThreadProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "reviewLoop",
    threadId: props.thread.id,
  });
  const { mutate, writable, busy } = useHopliteMutation(props, [
    AuthSourceControlWriteScope,
    AuthOrchestrationOperateScope,
  ]);
  return (
    <>
      <QueryFeedback
        result={result}
        refresh={refresh}
        missing="No managed review loop is linked to this pull request."
      />
      <p className="text-xs text-muted-foreground">
        Automatic fixes can start billable runs. This does not change the existing auto-merge
        setting.
      </p>
      {data ? (
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={data.reviewLoop?.enabled ?? false}
            disabled={!writable || busy}
            onCheckedChange={async (enabled) => {
              if (
                await mutate(
                  { type: "setReviewLoop", threadId: props.thread.id, enabled },
                  enabled
                    ? "Enable automatic PR review fixes? Hoplite may start billable agent runs."
                    : undefined,
                )
              )
                refresh();
            }}
          />
          Automatic fixes · {data.reviewLoop?.status ?? "Not configured"}
        </label>
      ) : null}
    </>
  );
}

function ThreadUsage(props: ThreadProps) {
  const canRead = useEnvironmentScope(props.environmentId, AuthDiagnosticsReadScope);
  return canRead ? (
    <ThreadUsageDetails {...props} />
  ) : (
    <p className="text-xs text-muted-foreground">
      This connection needs diagnostics read permission to view usage.
    </p>
  );
}

function ThreadUsageDetails(props: ThreadProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "threadUsage",
    threadId: props.thread.id,
  });
  return (
    <>
      <QueryFeedback result={result} refresh={refresh} />
      {data ? (
        <Metrics
          items={[
            ["Total cost", micros(data.usage.totalCostMicros)],
            ["Model cost", micros(data.usage.llmCostMicros)],
            [
              "Workspace cost",
              data.usage.vmCostStatus === "pending" ? "Pending" : micros(data.usage.vmCostMicros),
            ],
            [
              "Spend limit",
              data.usage.spendLimitMicros == null
                ? "No thread limit"
                : micros(data.usage.spendLimitMicros),
            ],
            ["Input tokens", data.usage.inputTokens?.toLocaleString() ?? "Not reported"],
            ["Output tokens", data.usage.outputTokens?.toLocaleString() ?? "Not reported"],
            ["Runs", data.usage.runCount ?? "Not reported"],
            ["Model", data.usage.topModel ?? "Not reported"],
          ]}
        />
      ) : null}
      <div>
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh usage
        </Button>
      </div>
    </>
  );
}
