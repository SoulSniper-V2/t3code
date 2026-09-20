"use client";

import { memo, useMemo, useState } from "react";
import {
  WorkflowIcon,
  DraftingCompassIcon,
  Code2Icon,
  ShieldCheckIcon,
  ArrowDownIcon,
  SparklesIcon,
} from "lucide-react";
import { type ProviderInstanceId, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "~/lib/utils";

interface MultiAgentPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeInstanceId: ProviderInstanceId;
  activeModel: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  onLaunchPipeline: (
    prompt: string,
    initialInstanceId: ProviderInstanceId,
    initialModel: string,
  ) => void;
}

interface PipelineStageConfig {
  instanceId: ProviderInstanceId;
  model: string;
}

export const MultiAgentPipelineDialog = memo(function MultiAgentPipelineDialog({
  open,
  onOpenChange,
  activeInstanceId,
  activeModel,
  instanceEntries,
  modelOptionsByInstance,
  onLaunchPipeline,
}: MultiAgentPipelineDialogProps) {
  const readyInstances = useMemo(
    () => instanceEntries.filter((entry) => entry.enabled && entry.status === "ready"),
    [instanceEntries],
  );

  const [taskObjective, setTaskObjective] = useState("");

  const [architectStage, setArchitectStage] = useState<PipelineStageConfig>(() => ({
    instanceId: activeInstanceId,
    model: activeModel,
  }));

  const [coderStage, setCoderStage] = useState<PipelineStageConfig>(() => ({
    instanceId: activeInstanceId,
    model: activeModel,
  }));

  const [reviewerStage, setReviewerStage] = useState<PipelineStageConfig>(() => ({
    instanceId: activeInstanceId,
    model: activeModel,
  }));

  const renderStageSelector = (
    stageName: string,
    roleTitle: string,
    roleDescription: string,
    icon: typeof DraftingCompassIcon,
    stage: PipelineStageConfig,
    onChange: (next: PipelineStageConfig) => void,
    colorClass: string,
  ) => {
    const Icon = icon;
    const models = modelOptionsByInstance.get(stage.instanceId) ?? [];
    const currentEntry = readyInstances.find((e) => e.instanceId === stage.instanceId);

    return (
      <div className="rounded-xl border border-border/80 bg-card/60 p-3 shadow-2xs">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <div className={cn("flex size-6 items-center justify-center rounded-lg", colorClass)}>
              <Icon className="size-3.5" />
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground">
                {stageName}: {roleTitle}
              </span>
              <p className="text-[10px] text-muted-foreground">{roleDescription}</p>
            </div>
          </div>
          <Badge variant="outline" className="text-[10px] font-mono">
            {currentEntry?.displayName ?? stage.instanceId}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              Provider
            </label>
            <select
              value={stage.instanceId}
              onChange={(e) => {
                const nextId = e.target.value as ProviderInstanceId;
                const nextModels = modelOptionsByInstance.get(nextId) ?? [];
                onChange({
                  instanceId: nextId,
                  model: nextModels[0]?.slug ?? "default",
                });
              }}
              className="w-full rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-foreground focus:outline-hidden"
            >
              {readyInstances.map((inst) => (
                <option key={inst.instanceId} value={inst.instanceId}>
                  {inst.displayName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              Model
            </label>
            <select
              value={stage.model}
              onChange={(e) => onChange({ ...stage, model: e.target.value })}
              className="w-full rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-foreground focus:outline-hidden"
            >
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    );
  };

  const handleLaunch = () => {
    const objective = taskObjective.trim() || "Analyze and implement solution for the workspace";
    const archEntry = readyInstances.find((e) => e.instanceId === architectStage.instanceId);
    const codeEntry = readyInstances.find((e) => e.instanceId === coderStage.instanceId);
    const revEntry = readyInstances.find((e) => e.instanceId === reviewerStage.instanceId);

    const pipelinePrompt = `[Multi-Agent Blackboard Pipeline]
Task Objective: "${objective}"

Collaborative Pipeline Protocol:
1. Stage 1 (Architect / Plan): [${archEntry?.displayName ?? architectStage.instanceId} · ${architectStage.model}]
   - Analyze codebase conventions, constraints, and dependencies.
   - Formulate a clear, modular architecture and step-by-step implementation plan.
2. Stage 2 (Implementer / Build): [${codeEntry?.displayName ?? coderStage.instanceId} · ${coderStage.model}]
   - Follow the approved plan and write production-grade, functional code with no placeholders.
3. Stage 3 (Reviewer / Audit): [${revEntry?.displayName ?? reviewerStage.instanceId} · ${reviewerStage.model}]
   - Verify code against tests, audit edge cases, and run project verification commands.

Starting Stage 1: Please begin by thoroughly planning the solution for: ${objective}`;

    onLaunchPipeline(pipelinePrompt, architectStage.instanceId, architectStage.model);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg p-5">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <WorkflowIcon className="size-4 text-primary" />
            <DialogTitle>Multi-Agent Pipeline</DialogTitle>
          </div>
          <DialogDescription>
            Inspired by agtx's Blackboard: orchestrate specialized AI agents sequentially (Plan →
            Build → Review).
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-3 text-xs">
          {/* Task Objective */}
          <div>
            <label className="text-xs font-semibold text-foreground mb-1 block">
              Task Objective
            </label>
            <Textarea
              value={taskObjective}
              onChange={(e) => setTaskObjective(e.target.value)}
              rows={3}
              className="resize-none text-xs"
              placeholder="Describe the feature or fix for the multi-agent team to execute..."
            />
          </div>

          {/* Pipeline Stages */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-foreground">Pipeline Stages</span>

            {renderStageSelector(
              "Stage 1",
              "Architect",
              "Designs structure, edge cases, and implementation plan",
              DraftingCompassIcon,
              architectStage,
              setArchitectStage,
              "bg-purple-500/10 text-purple-500",
            )}

            <div className="flex justify-center -my-1 text-muted-foreground">
              <ArrowDownIcon className="size-3.5 opacity-60" />
            </div>

            {renderStageSelector(
              "Stage 2",
              "Implementer",
              "Writes clean, idiomatic, fully functional code",
              Code2Icon,
              coderStage,
              setCoderStage,
              "bg-blue-500/10 text-blue-500",
            )}

            <div className="flex justify-center -my-1 text-muted-foreground">
              <ArrowDownIcon className="size-3.5 opacity-60" />
            </div>

            {renderStageSelector(
              "Stage 3",
              "Auditor",
              "Verifies tests, reviews diffs, and validates quality",
              ShieldCheckIcon,
              reviewerStage,
              setReviewerStage,
              "bg-emerald-500/10 text-emerald-500",
            )}
          </div>

          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleLaunch} className="gap-1.5">
              <SparklesIcon className="size-3.5" />
              <span>Launch pipeline</span>
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
});
