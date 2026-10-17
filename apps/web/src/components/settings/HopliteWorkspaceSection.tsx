import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type HopliteThread,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { hopliteEnvironment } from "../../state/hoplite";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";
import { HopliteProjectManagement, HopliteBilling } from "./HopliteProjectManagement";
import { HopliteThreadDetails } from "./HopliteThreadDetails";
import {
  HopliteFold,
  HopliteLink,
  QueryFeedback,
  type HopliteTarget,
} from "./HopliteWorkspaceShared";

export interface HopliteLocalProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export function HopliteWorkspaceSection(
  props: HopliteTarget & {
    readonly projects: ReadonlyArray<HopliteLocalProject>;
    readonly liveProvider: ServerProvider | undefined;
    readonly configuredProjectId?: string;
    readonly canConfigure: boolean;
    readonly onSelectProject: (projectId: string) => void;
  },
) {
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  return (
    <SettingsSection title="Hoplite cloud workspace">
      <div className="px-3 py-2 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Browse managed cloud workspaces. Importing a conversation does not copy its repository or
          sandbox files onto this device.
        </p>
        {canRead && props.liveProvider?.auth.status === "authenticated" ? (
          <HopliteFold title="Manage cloud workspace">
            <WorkspaceBrowser {...props} />
          </HopliteFold>
        ) : (
          <p className="py-3 text-xs text-muted-foreground">
            Sign in to Hoplite with an authorized connection to browse this workspace.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function WorkspaceBrowser(
  props: HopliteTarget & {
    readonly projects: ReadonlyArray<HopliteLocalProject>;
    readonly configuredProjectId?: string;
    readonly canConfigure: boolean;
    readonly onSelectProject: (projectId: string) => void;
  },
) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<ReadonlyArray<string | undefined>>([]);
  const [selected, setSelected] = useState(props.configuredProjectId ?? "");
  const query = hopliteEnvironment.projects({
    environmentId: props.environmentId,
    input: { instanceId: props.instanceId, limit: 20, ...(cursor ? { cursor } : {}) },
  });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const page = result._tag === "Success" ? result.value : undefined;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Cloud projects</h3>
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <QueryFeedback result={result} refresh={refresh} empty={page?.projects.length === 0} />
      <div className="grid gap-2">
        {page?.projects.map((project) => (
          <div
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border p-3"
            key={project.id}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{project.name}</p>
              <p className="text-xs text-muted-foreground">
                {project.description ?? project.defaultBranch ?? project.id}
              </p>
            </div>
            <Button
              size="xs"
              variant={selected === project.id ? "secondary" : "outline"}
              onClick={() => setSelected(project.id)}
            >
              {selected === project.id ? "Selected" : "Browse"}
            </Button>
          </div>
        ))}
      </div>
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
          disabled={!page?.nextCursor || result.waiting}
          onClick={() => {
            if (!page?.nextCursor) return;
            setPrevious([...previous, cursor]);
            setCursor(page.nextCursor);
          }}
        >
          Next
        </Button>
      </div>
      {selected ? (
        <div className="grid gap-2 border-t pt-3" key={selected}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Cloud project:{" "}
              {page?.projects.find((project) => project.id === selected)?.name ?? selected}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={
                props.readOnly || !props.canConfigure || selected === props.configuredProjectId
              }
              onClick={() => props.onSelectProject(selected)}
            >
              Use for new conversations
            </Button>
          </div>
          <ThreadBrowser {...props} remoteProjectId={selected} />
          <HopliteFold title="Project settings and integrations">
            <HopliteProjectManagement {...props} projectId={selected} />
          </HopliteFold>
        </div>
      ) : null}
      <HopliteFold title="Organization billing and usage">
        <HopliteBilling {...props} />
      </HopliteFold>
    </>
  );
}

function ThreadBrowser(
  props: HopliteTarget & {
    readonly remoteProjectId: string;
    readonly projects: ReadonlyArray<HopliteLocalProject>;
  },
) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<ReadonlyArray<string | undefined>>([]);
  const [thread, setThread] = useState<HopliteThread | null>(null);
  const [destination, setDestination] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [importing, setImporting] = useState<string | null>(null);
  const canImport = useAtomValue(
    hopliteEnvironment.importThread.permissionAtom(props.environmentId),
  );
  const importThread = useAtomCommand(hopliteEnvironment.importThread);
  const atom = hopliteEnvironment.threads({
    environmentId: props.environmentId,
    input: {
      instanceId: props.instanceId,
      projectId: props.remoteProjectId,
      q: query,
      archived,
      limit: 20,
      ...(cursor ? { cursor } : {}),
    },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const page = result._tag === "Success" ? result.value : undefined;
  const resetPage = () => {
    setCursor(undefined);
    setPrevious([]);
    setThread(null);
  };
  const importRemote = async (remoteThread: HopliteThread) => {
    if (!destination || props.readOnly || !canImport || importing) return;
    setImporting(remoteThread.id);
    try {
      const response = await importThread({
        environmentId: props.environmentId,
        input: {
          instanceId: props.instanceId,
          projectId: destination,
          remoteThreadId: remoteThread.id,
        },
      });
      if (response._tag === "Success")
        toastManager.add({
          type: "success",
          title: response.value.imported
            ? "Cloud conversation imported"
            : "Conversation already imported",
        });
    } finally {
      setImporting(null);
    }
  };
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          resetPage();
          setQuery(search.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            size="sm"
            aria-label="Search cloud conversations"
            placeholder="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button size="sm" variant="outline" type="submit">
          Search
        </Button>
        <Button size="sm" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </form>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={archived}
          onCheckedChange={(value) => {
            resetPage();
            setArchived(value);
          }}
        />
        Archived conversations
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        <span>Import into local T3 project</span>
        <Select
          value={destination ?? ""}
          onValueChange={(value) =>
            setDestination(props.projects.find((project) => project.id === value)?.id ?? null)
          }
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Select a local project" />
          </SelectTrigger>
          <SelectPopup>
            {props.projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      {!props.projects.length ? (
        <p className="text-xs text-muted-foreground">
          Add a local T3 project before importing a cloud conversation.
        </p>
      ) : null}
      <QueryFeedback result={result} refresh={refresh} empty={page?.threads.length === 0} />
      <div className="grid gap-2">
        {page?.threads.map((item) => (
          <div key={item.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {item.title ?? "Untitled conversation"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.status ?? "Unknown"} · {item.modelId ?? "Default model"}
                  {item.runStatus ? ` · Run ${item.runStatus}` : ""}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={props.readOnly || !canImport || !destination || importing !== null}
                onClick={() => void importRemote(item)}
              >
                {importing === item.id ? "Importing…" : "Import"}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setThread(thread?.id === item.id ? null : item)}
              >
                {thread?.id === item.id ? "Hide details" : "Cloud details"}
              </Button>
              <HopliteLink href={`https://app.hoplite.sh/threads/${encodeURIComponent(item.id)}`}>
                Open in Hoplite
              </HopliteLink>
            </div>
            {thread?.id === item.id ? <HopliteThreadDetails {...props} thread={item} /> : null}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!previous.length || result.waiting}
          onClick={() => {
            setThread(null);
            setCursor(previous.at(-1));
            setPrevious(previous.slice(0, -1));
          }}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!page?.nextCursor || result.waiting}
          onClick={() => {
            if (!page?.nextCursor) return;
            setThread(null);
            setPrevious([...previous, cursor]);
            setCursor(page.nextCursor);
          }}
        >
          Next
        </Button>
        {page ? (
          <span className="text-xs text-muted-foreground">{page.totalCount} conversations</span>
        ) : null}
      </div>
    </>
  );
}
