import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type HopliteProject,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  HopliteAutomations,
  HopliteEnvironmentVariables,
  HopliteMcpServers,
} from "./HopliteWorkspaceIntegrations";
import {
  HopliteField,
  HopliteFold,
  Metrics,
  QueryFeedback,
  micros,
  useHopliteMutation,
  useHopliteRead,
  type HopliteTarget,
} from "./HopliteWorkspaceShared";

type ProjectProps = HopliteTarget & { readonly projectId: string };

export function HopliteProjectManagement(props: ProjectProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "project",
    projectId: props.projectId,
  });
  return (
    <>
      <QueryFeedback result={result} refresh={refresh} />
      {data ? (
        <ProjectEditor
          key={data.project.updatedAt ?? data.project.id}
          {...props}
          project={data.project}
          refresh={refresh}
        />
      ) : null}
      <HopliteFold title="Repository bindings">
        <ProjectRepositories {...props} />
      </HopliteFold>
      <HopliteFold title="Environment variables">
        <HopliteEnvironmentVariables {...props} />
      </HopliteFold>
      <HopliteFold title="Automations">
        <HopliteAutomations {...props} />
      </HopliteFold>
      <HopliteFold title="MCP servers">
        <HopliteMcpServers {...props} />
      </HopliteFold>
    </>
  );
}

function ProjectEditor(
  props: ProjectProps & { readonly project: HopliteProject; readonly refresh: () => void },
) {
  const [name, setName] = useState(props.project.name);
  const [description, setDescription] = useState(props.project.description ?? "");
  const [branch, setBranch] = useState(props.project.defaultBranch ?? "");
  const [instructions, setInstructions] = useState(props.project.instructions ?? "");
  const [setup, setSetup] = useState(props.project.setupScript ?? "");
  const [run, setRun] = useState(props.project.runScript ?? "");
  const [archive, setArchive] = useState(props.project.archiveScript ?? "");
  const [port, setPort] = useState(String(props.project.previewPort ?? 3000));
  const { mutate, writable, busy } = useHopliteMutation(props, [
    AuthOrchestrationOperateScope,
    AuthSettingsWriteScope,
  ]);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await mutate(
            {
              type: "updateProject",
              projectId: props.projectId,
              settings: {
                name: name.trim(),
                description: description.trim() || null,
                defaultBranch: branch.trim() || null,
                instructions: instructions || null,
                setupScript: setup || null,
                runScript: run || null,
                archiveScript: archive || null,
                previewPort: Number(port),
              },
            },
            "Save this shared cloud project configuration? It applies to future workspace setup and runs.",
          )
        )
          props.refresh();
      }}
    >
      <fieldset disabled={!writable || busy} className="grid gap-3">
        <HopliteField label="Project name" value={name} onChange={setName} required />
        <HopliteField label="Description" value={description} onChange={setDescription} />
        <HopliteField label="Default branch" value={branch} onChange={setBranch} />
        <label className="grid gap-1 text-xs text-muted-foreground">
          Project instructions
          <Textarea
            size="sm"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Setup script
          <Textarea size="sm" value={setup} onChange={(event) => setSetup(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Preview run script
          <Textarea size="sm" value={run} onChange={(event) => setRun(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Archive script
          <Textarea
            size="sm"
            value={archive}
            onChange={(event) => setArchive(event.target.value)}
          />
        </label>
        <HopliteField
          label="Preview port (3000–9999)"
          value={port}
          onChange={setPort}
          type="number"
          required
        />
        <div>
          <Button
            size="sm"
            type="submit"
            disabled={
              !name.trim() ||
              !Number.isInteger(Number(port)) ||
              Number(port) < 3000 ||
              Number(port) > 9999
            }
          >
            Save project settings
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function ProjectRepositories(props: ProjectProps) {
  const current = useHopliteRead(props, {
    type: "projectRepositories",
    projectId: props.projectId,
  });
  const catalog = useHopliteRead(props, { type: "repositories" });
  const { mutate, writable, busy } = useHopliteMutation(props, [AuthSourceControlWriteScope]);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Manage the repositories available to this cloud project. Removing a binding affects future
        workspaces.
      </p>
      <QueryFeedback result={current.result} refresh={current.refresh} />
      <QueryFeedback result={catalog.result} refresh={catalog.refresh} />
      {current.data && catalog.data
        ? catalog.data.repositories.map((repository) => {
            const binding = current.data?.repositories?.find(
              (item) =>
                item.repositoryId === repository.id || item.repoFullName === repository.fullName,
            );
            const bindings = current.data?.repositories ?? [];
            const canPreserveBindings = bindings.every((item) => item.repositoryId !== undefined);
            return (
              <div key={repository.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="break-all">{repository.fullName}</p>
                  <p className="text-muted-foreground">
                    {binding?.branch ?? repository.defaultBranch}
                    {binding ? " · Attached" : ""}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!writable || busy || !canPreserveBindings}
                  onClick={async () => {
                    const retained = bindings
                      .filter((item) => item.repositoryId !== repository.id)
                      .flatMap((item) =>
                        item.repositoryId
                          ? [
                              {
                                repositoryId: item.repositoryId,
                                ...(item.branch ? { baseBranch: item.branch } : {}),
                              },
                            ]
                          : [],
                      );
                    if (
                      await mutate(
                        {
                          type: "setRepositories",
                          projectId: props.projectId,
                          repositories: binding
                            ? retained
                            : [
                                ...retained,
                                {
                                  repositoryId: repository.id,
                                  baseBranch: repository.defaultBranch,
                                },
                              ],
                        },
                        `${binding ? "Remove" : "Attach"} ${repository.fullName} ${binding ? "from" : "to"} this cloud project?`,
                        Boolean(binding),
                      )
                    )
                      current.refresh();
                  }}
                >
                  {binding ? "Remove" : "Attach"}
                </Button>
              </div>
            );
          })
        : null}
      {current.data?.repositories?.some((item) => !item.repositoryId) ? (
        <p className="text-xs text-muted-foreground">
          Some existing bindings lack repository IDs. Edit these in Hoplite to preserve them safely.
        </p>
      ) : null}
    </>
  );
}

export function HopliteBilling(props: HopliteTarget) {
  const canRead = useEnvironmentScope(props.environmentId, AuthDiagnosticsReadScope);
  return canRead ? (
    <BillingDetails {...props} />
  ) : (
    <p className="text-xs text-muted-foreground">
      This connection needs diagnostics read permission to view billing and usage.
    </p>
  );
}

function BillingDetails(props: HopliteTarget) {
  const plan = useHopliteRead(props, { type: "billingPlan" });
  const billing = useHopliteRead(props, { type: "billingSummary" });
  const usage = useHopliteRead(props, { type: "usage" });
  return (
    <>
      <QueryFeedback result={plan.result} refresh={plan.refresh} />
      {plan.data ? (
        <Metrics
          items={[
            ["Plan", `${plan.data.plan.plan} · ${plan.data.plan.billingInterval}`],
            ["Seats", plan.data.plan.seatCount],
            ["Workspace idle", `${plan.data.plan.sandboxIdleMinutes} minutes`],
          ]}
        />
      ) : null}
      <QueryFeedback result={billing.result} refresh={billing.refresh} />
      {billing.data ? (
        <Metrics
          items={[
            [
              "Remaining credits",
              billing.data.billing.remainingCredits?.toLocaleString() ?? "Not reported",
            ],
            [
              "Reserved credits",
              billing.data.billing.heldCredits?.toLocaleString() ?? "Not reported",
            ],
            ["Next reset", billing.data.billing.nextResetAt ?? "Not reported"],
          ]}
        />
      ) : null}
      <QueryFeedback result={usage.result} refresh={usage.refresh} />
      {usage.data ? (
        <Metrics
          items={[
            ["Organization cost", micros(usage.data.usage.totalCostMicros)],
            ["Input tokens", usage.data.usage.inputTokens?.toLocaleString() ?? "Not reported"],
            ["Output tokens", usage.data.usage.outputTokens?.toLocaleString() ?? "Not reported"],
          ]}
        />
      ) : null}
      <div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            plan.refresh();
            billing.refresh();
            usage.refresh();
          }}
        >
          Refresh billing and usage
        </Button>
      </div>
    </>
  );
}
