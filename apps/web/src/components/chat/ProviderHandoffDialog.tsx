"use client";

import { memo, useMemo, useState } from "react";
import { ArrowRightLeftIcon, CheckIcon } from "lucide-react";
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "~/lib/utils";

interface ProviderHandoffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentInstanceId: ProviderInstanceId;
  currentModel: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  onCommitHandoff: (
    targetInstanceId: ProviderInstanceId,
    targetModel: string,
    handoffInstruction: string,
  ) => void;
}

export const ProviderHandoffDialog = memo(function ProviderHandoffDialog({
  open,
  onOpenChange,
  currentInstanceId,
  currentModel,
  instanceEntries,
  modelOptionsByInstance,
  onCommitHandoff,
}: ProviderHandoffDialogProps) {
  const currentEntry = useMemo(
    () => instanceEntries.find((entry) => entry.instanceId === currentInstanceId) ?? null,
    [currentInstanceId, instanceEntries],
  );

  // Available target instances (can hand off to any other instance, or same instance with a different model)
  const candidateInstances = useMemo(
    () => instanceEntries.filter((entry) => entry.enabled && entry.status === "ready"),
    [instanceEntries],
  );

  const [selectedTargetInstanceId, setSelectedTargetInstanceId] = useState<ProviderInstanceId>(
    () => {
      const other = candidateInstances.find((entry) => entry.instanceId !== currentInstanceId);
      return other?.instanceId ?? currentInstanceId;
    },
  );

  const targetModels = useMemo(
    () => modelOptionsByInstance.get(selectedTargetInstanceId) ?? [],
    [modelOptionsByInstance, selectedTargetInstanceId],
  );

  const [selectedTargetModel, setSelectedTargetModel] = useState<string>(() => {
    return targetModels[0]?.slug ?? "default";
  });

  const selectedTargetEntry = useMemo(
    () => instanceEntries.find((entry) => entry.instanceId === selectedTargetInstanceId) ?? null,
    [instanceEntries, selectedTargetInstanceId],
  );

  const currentDisplayName = currentEntry?.displayName ?? currentInstanceId;
  const targetDisplayName = selectedTargetEntry?.displayName ?? selectedTargetInstanceId;

  const [instruction, setInstruction] = useState(() => {
    return `[Provider Handoff]
Previous agent was ${currentDisplayName} running ${currentModel}.
Please inspect git status, recent file modifications, and diffs in this workspace, then continue working toward the objective.`;
  });

  const handleSelectInstance = (id: ProviderInstanceId) => {
    setSelectedTargetInstanceId(id);
    const models = modelOptionsByInstance.get(id) ?? [];
    if (models[0]) {
      setSelectedTargetModel(models[0].slug);
    }
  };

  const handleApply = () => {
    onCommitHandoff(selectedTargetInstanceId, selectedTargetModel, instruction);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg p-5">
        <DialogHeader>
          <DialogTitle>Provider Handoff</DialogTitle>
          <DialogDescription>
            Seamlessly continue this task with another coding agent while preserving working
            directory, branch, and diff state.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-4 text-xs">
          {/* Transition diagram */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/40 p-3">
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                From
              </span>
              <span className="truncate font-medium text-foreground">{currentDisplayName}</span>
              <span className="truncate text-[11px] text-muted-foreground">{currentModel}</span>
            </div>
            <ArrowRightLeftIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col min-w-0 text-right">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                To
              </span>
              <span className="truncate font-medium text-primary">{targetDisplayName}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {selectedTargetModel}
              </span>
            </div>
          </div>

          {/* Select Target Provider Instance */}
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-foreground">Select Target Agent</span>
            <div className="grid max-h-36 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
              {candidateInstances.map((entry) => {
                const isSelected = entry.instanceId === selectedTargetInstanceId;
                return (
                  <button
                    key={entry.instanceId}
                    type="button"
                    onClick={() => handleSelectInstance(entry.instanceId)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg border p-2 text-left transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 text-foreground font-medium"
                        : "border-border/60 hover:bg-muted/60 text-muted-foreground",
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderInstanceIcon
                        driverKind={entry.driverKind}
                        displayName={entry.displayName}
                        accentColor={entry.accentColor}
                        className="size-4"
                      />
                      <span className="truncate text-xs">{entry.displayName}</span>
                    </div>
                    {isSelected ? <CheckIcon className="size-3.5 text-primary shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Select Target Model */}
          {targetModels.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="font-semibold text-foreground">Model</span>
              <select
                value={selectedTargetModel}
                onChange={(e) => setSelectedTargetModel(e.target.value)}
                className="w-full rounded-md border border-border/80 bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
              >
                {targetModels.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Handoff Recap Instruction */}
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-foreground">Handoff Prompt</span>
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              className="resize-none font-mono text-[11px]"
              placeholder="Enter handoff instructions for the incoming agent..."
            />
          </div>

          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleApply}>
              Perform handoff
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
});
