import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  HopliteField,
  HopliteFold,
  QueryFeedback,
  useHopliteMutation,
  useHopliteRead,
  type HopliteTarget,
  type ReadData,
} from "./HopliteWorkspaceShared";
import { parseHopliteSpendLimit } from "./hopliteWorkspace.logic";

type ProjectProps = HopliteTarget & { readonly projectId: string };

export function HopliteEnvironmentVariables(props: ProjectProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "environmentVariables",
    projectId: props.projectId,
  });
  const { mutate, writable, busy } = useHopliteMutation(props, [AuthSettingsWriteScope]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Values are encrypted and write-only. Saving an existing name replaces its value.
      </p>
      <QueryFeedback result={result} refresh={refresh} empty={data?.envVars.length === 0} />
      {data?.envVars.map((variable) => (
        <div key={variable.key} className="flex items-center justify-between gap-2 text-xs">
          <code>{variable.key}</code>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={!writable || busy}
              onClick={() => {
                setKey(variable.key);
                setValue("");
              }}
            >
              Replace
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!writable || busy}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      type: "deleteEnvironmentVariable",
                      projectId: props.projectId,
                      key: variable.key,
                    },
                    `Delete ${variable.key} from this shared cloud project?`,
                    true,
                  )
                )
                  refresh();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}
      <form
        className="grid gap-3 rounded-md border p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await mutate(
              { type: "setEnvironmentVariable", projectId: props.projectId, key, value },
              `Save ${key} in this shared cloud project?`,
            )
          ) {
            setValue("");
            setKey("");
            refresh();
          }
        }}
      >
        <fieldset className="grid gap-3" disabled={!writable || busy}>
          <HopliteField label="Variable name" value={key} onChange={setKey} required />
          <HopliteField
            label="New secret value"
            value={value}
            onChange={setValue}
            type="password"
          />
          <div>
            <Button size="xs" type="submit" disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)}>
              Save variable
            </Button>
          </div>
        </fieldset>
      </form>
    </>
  );
}

export function HopliteMcpServers(props: ProjectProps) {
  const { result, data, refresh } = useHopliteRead(props, { type: "mcpServers" });
  const { mutate, writable, busy } = useHopliteMutation(props, [AuthSettingsWriteScope]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const validUrl = (() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  })();
  const servers = data?.servers.filter(
    (server) => !server.projectId || server.projectId === props.projectId,
  );
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Project and organization MCP servers run in Hoplite, not on this device. Existing
        configuration and credentials are not returned; edit them in Hoplite.
      </p>
      <QueryFeedback result={result} refresh={refresh} empty={servers?.length === 0} />
      {servers?.map((server) => (
        <div key={server.id} className="flex items-center justify-between gap-2 text-xs">
          <div>
            <p>{server.name}</p>
            <p className="text-muted-foreground">
              {server.projectId ? "Project" : "Organization"} ·{" "}
              {server.enabled === false ? "Disabled" : "Enabled"}
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={!writable || busy}
            onClick={async () => {
              if (
                await mutate(
                  { type: "deleteMcpServer", serverId: server.id },
                  `Remove ${server.name}${server.projectId ? " from this project" : " from the entire organization"}?`,
                  true,
                )
              )
                refresh();
            }}
          >
            Delete
          </Button>
        </div>
      ))}
      <HopliteFold title="Add project MCP server">
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await mutate(
                {
                  type: "createMcpServer",
                  settings: {
                    name: name.trim(),
                    projectId: props.projectId,
                    enabled: true,
                    config: {
                      transport: "http",
                      url,
                      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
                    },
                  },
                },
                "Add this MCP server to the cloud project? Agent runs may call its tools.",
              )
            ) {
              setToken("");
              setName("");
              setUrl("");
              refresh();
            }
          }}
        >
          <fieldset className="grid gap-3" disabled={!writable || busy}>
            <HopliteField label="Server name" value={name} onChange={setName} required />
            <HopliteField
              label="HTTPS Streamable HTTP endpoint"
              value={url}
              onChange={setUrl}
              type="url"
              required
            />
            <HopliteField
              label="Bearer token (optional, write-only)"
              value={token}
              onChange={setToken}
              type="password"
            />
            <div>
              <Button size="xs" type="submit" disabled={!name.trim() || !validUrl}>
                Add MCP server
              </Button>
            </div>
          </fieldset>
        </form>
      </HopliteFold>
    </>
  );
}

type Automation = ReadData<"automations">["automations"][number];

export function HopliteAutomations(props: ProjectProps) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "automations",
    projectId: props.projectId,
  });
  const { mutate, writable, busy } = useHopliteMutation(props);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Automations execute in Hoplite and can spend workspace credits.
      </p>
      <QueryFeedback result={result} refresh={refresh} empty={data?.automations.length === 0} />
      {data?.automations.map((automation) => (
        <div key={automation.id} className="grid gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{automation.name}</p>
            <Switch
              aria-label={`Enable ${automation.name}`}
              checked={automation.enabled}
              disabled={!writable || busy}
              onCheckedChange={async (enabled) => {
                if (
                  await mutate(
                    {
                      type: "updateAutomation",
                      projectId: props.projectId,
                      automationId: automation.id,
                      settings: { enabled },
                    },
                    enabled
                      ? `Enable ${automation.name}? Scheduled or triggered runs can incur charges.`
                      : undefined,
                  )
                )
                  refresh();
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {automation.schedule?.mode === "cron"
              ? `${automation.schedule.expression} · ${automation.schedule.timezone}`
              : automation.schedule?.mode === "interval"
                ? `Every ${automation.schedule.intervalMs / 60_000} minutes`
                : "Event-triggered"}
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!writable || busy}
              onClick={() =>
                void mutate(
                  {
                    type: "runAutomation",
                    projectId: props.projectId,
                    automationId: automation.id,
                  },
                  `Run ${automation.name} now? This can create a cloud agent run and incur charges.`,
                )
              }
            >
              Run now
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!writable || busy}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      type: "deleteAutomation",
                      projectId: props.projectId,
                      automationId: automation.id,
                    },
                    `Permanently delete ${automation.name}?`,
                    true,
                  )
                )
                  refresh();
              }}
            >
              Delete
            </Button>
          </div>
          <HopliteFold title="Edit automation">
            <AutomationEditor {...props} automation={automation} refresh={refresh} />
          </HopliteFold>
          <HopliteFold title="Recent executions">
            <AutomationExecutions {...props} automationId={automation.id} />
          </HopliteFold>
        </div>
      ))}
      <HopliteFold title="Create scheduled automation">
        <AutomationEditor {...props} refresh={refresh} />
      </HopliteFold>
      <div>
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh automations
        </Button>
      </div>
    </>
  );
}

function AutomationEditor(
  props: ProjectProps & { readonly automation?: Automation; readonly refresh: () => void },
) {
  const automation = props.automation;
  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [expression, setExpression] = useState(
    automation?.schedule?.mode === "cron" ? automation.schedule.expression : "0 9 * * 1-5",
  );
  const [timezone, setTimezone] = useState(
    automation?.schedule?.mode === "cron"
      ? automation.schedule.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [limit, setLimit] = useState(
    automation?.maxSpendPerThreadMicros == null
      ? ""
      : String(automation.maxSpendPerThreadMicros / 1_000_000),
  );
  const { mutate, writable, busy } = useHopliteMutation(props);
  const cron = !automation || automation.schedule?.mode === "cron";
  const spendLimit = parseHopliteSpendLimit(limit);
  let validTimezone = true;
  try {
    validTimezone =
      new Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone.length >
      0;
  } catch {
    validTimezone = false;
  }
  return (
    <form
      className="grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (spendLimit === undefined) return;
        const settings = { name: name.trim(), prompt, maxSpendPerThreadMicros: spendLimit };
        const schedule = {
          mode: "cron" as const,
          expression: expression.trim(),
          timezone: timezone.trim(),
        };
        const mutation = automation
          ? {
              type: "updateAutomation" as const,
              projectId: props.projectId,
              automationId: automation.id,
              settings: { ...settings, ...(cron ? { schedule } : {}) },
            }
          : {
              type: "createAutomation" as const,
              projectId: props.projectId,
              settings: { ...settings, schedule, enabled: false },
            };
        if (
          await mutate(
            mutation,
            automation
              ? "Save this shared automation? Its future runs will use the new settings."
              : "Create this scheduled automation? It will remain disabled until you enable it.",
          )
        )
          props.refresh();
      }}
    >
      <fieldset className="grid gap-3" disabled={!writable || busy}>
        <HopliteField label="Name" value={name} onChange={setName} required />
        <label className="grid gap-1 text-xs text-muted-foreground">
          Agent instructions
          <Textarea
            size="sm"
            value={prompt}
            required
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {cron ? (
          <>
            <HopliteField
              label="Cron schedule"
              value={expression}
              onChange={setExpression}
              required
            />
            <HopliteField label="Time zone" value={timezone} onChange={setTimezone} required />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            The existing interval or event trigger is preserved.
          </p>
        )}
        <HopliteField
          label="Per-thread spend limit (USD, blank for no limit)"
          value={limit}
          onChange={setLimit}
        />
        <div>
          <Button
            size="xs"
            type="submit"
            disabled={
              !name.trim() ||
              !prompt.trim() ||
              spendLimit === undefined ||
              (cron && (!expression.trim() || !validTimezone))
            }
          >
            {automation ? "Save automation" : "Create disabled automation"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AutomationExecutions(props: ProjectProps & { readonly automationId: string }) {
  const { result, data, refresh } = useHopliteRead(props, {
    type: "automationExecutions",
    projectId: props.projectId,
    automationId: props.automationId,
    limit: 20,
  });
  return (
    <>
      <QueryFeedback result={result} refresh={refresh} empty={data?.executions.length === 0} />
      {data?.executions.map((execution) => (
        <div key={execution.id} className="text-xs">
          <p>{execution.runStatus ?? execution.status}</p>
          <p className="text-muted-foreground">{execution.createdAt}</p>
        </div>
      ))}
      <div>
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh executions
        </Button>
      </div>
    </>
  );
}
