import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";

interface SplitThreadPickerProps {
  open: boolean;
  currentThreadRef: ScopedThreadRef;
  onOpenChange: (open: boolean) => void;
  onSelect: (threadRef: ScopedThreadRef) => void;
}

/** Search existing live chats before opening one as the companion pane. */
export function SplitThreadPicker({
  open,
  currentThreadRef,
  onOpenChange,
  onSelect,
}: SplitThreadPickerProps) {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const currentThreadKey = scopedThreadKey(currentThreadRef);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const projectNames = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const environmentNames = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const candidates = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return threads
      .filter((thread) => {
        if (thread.archivedAt !== null) return false;
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        if (scopedThreadKey(threadRef) === currentThreadKey) return false;
        const projectName = projectNames.get(`${thread.environmentId}:${thread.projectId}`) ?? "";
        const environmentName = environmentNames.get(thread.environmentId) ?? "";
        return `${thread.title} ${projectName} ${environmentName} ${thread.providerInstanceId} ${thread.branch ?? ""}`
          .toLocaleLowerCase()
          .includes(search);
      })
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [currentThreadKey, environmentNames, projectNames, query, threads]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden p-0" showCloseButton>
        <DialogTitle className="sr-only">Open a chat beside this one</DialogTitle>
        <DialogDescription className="sr-only">
          Search active chats and choose one to show in the split pane.
        </DialogDescription>
        <Command
          mode="none"
          value={query}
          onValueChange={setQuery}
          aria-label="Choose a chat to open beside this one"
        >
          <CommandInput placeholder="Search chats, projects, or environments..." />
          <CommandList className="max-h-[min(28rem,60vh)] overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {query.trim() ? "No chats match your search." : "No other active chats yet."}
              </div>
            ) : (
              candidates.map((thread) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                const projectName =
                  projectNames.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project";
                const environmentName = environmentNames.get(thread.environmentId);
                return (
                  <CommandItem
                    key={scopedThreadKey(threadRef)}
                    value={scopedThreadKey(threadRef)}
                    onClick={() => onSelect(threadRef)}
                  >
                    <MessageSquareIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{thread.title.trim() || "Untitled chat"}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {projectName}
                        {environmentName ? ` · ${environmentName}` : ""}
                      </span>
                    </span>
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
