"use client";

import { memo, useMemo } from "react";
import {
  CompassIcon,
  LayersIcon,
  CheckCircle2Icon,
  SparklesIcon,
  ExternalLinkIcon,
  XIcon,
  FileCodeIcon,
  DatabaseIcon,
  PaletteIcon,
  TestTubeIcon,
  FileTextIcon,
  ArrowRightIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export interface WalkthroughDiffFile {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly status?: "added" | "deleted" | "modified" | string;
}

interface DiffChangesWalkthroughProps {
  files: ReadonlyArray<WalkthroughDiffFile>;
  onSelectFile?: (path: string) => void;
  onSendToAgent?: (prompt: string) => void;
  onClose: () => void;
  className?: string;
}

interface WalkthroughStep {
  readonly id: string;
  readonly title: string;
  readonly category: "contracts" | "backend" | "frontend" | "tests" | "docs";
  readonly description: string;
  readonly icon: typeof LayersIcon;
  readonly files: WalkthroughDiffFile[];
}

function classifyFile(path: string): "contracts" | "backend" | "frontend" | "tests" | "docs" {
  const lower = path.toLowerCase();
  if (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("/tests/") ||
    lower.includes("/testfixtures/")
  ) {
    return "tests";
  }
  if (
    lower.endsWith(".md") ||
    lower.includes("/docs/") ||
    lower.includes("readme") ||
    lower.includes("changelog")
  ) {
    return "docs";
  }
  if (
    lower.includes("contracts/") ||
    lower.includes("schema") ||
    lower.includes(".sql") ||
    lower.includes("types.ts")
  ) {
    return "contracts";
  }
  if (
    lower.includes("apps/web/") ||
    lower.includes("apps/mobile/") ||
    lower.includes("components/") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".css")
  ) {
    return "frontend";
  }
  return "backend";
}

export const DiffChangesWalkthrough = memo(function DiffChangesWalkthrough({
  files,
  onSelectFile,
  onSendToAgent,
  onClose,
  className,
}: DiffChangesWalkthroughProps) {
  const steps = useMemo<WalkthroughStep[]>(() => {
    const buckets: Record<WalkthroughStep["category"], WalkthroughDiffFile[]> = {
      contracts: [],
      backend: [],
      frontend: [],
      tests: [],
      docs: [],
    };

    for (const file of files) {
      const cat = classifyFile(file.path);
      buckets[cat].push(file);
    }

    const result: WalkthroughStep[] = [];
    if (buckets.contracts.length > 0) {
      result.push({
        id: "contracts",
        category: "contracts",
        title: "1. Data Contracts & Interfaces",
        description: "Foundational schemas, types, and protocol boundaries governing the changes.",
        icon: DatabaseIcon,
        files: buckets.contracts,
      });
    }
    if (buckets.backend.length > 0) {
      result.push({
        id: "backend",
        category: "backend",
        title: `${result.length + 1}. Server, Runtime & Drivers`,
        description: "Core logic, adapters, subprocess management, and execution engines.",
        icon: FileCodeIcon,
        files: buckets.backend,
      });
    }
    if (buckets.frontend.length > 0) {
      result.push({
        id: "frontend",
        category: "frontend",
        title: `${result.length + 1}. UI Surfaces & Interactions`,
        description:
          "Components, toolbar actions, dialogs, visual feedback, and responsive layout.",
        icon: PaletteIcon,
        files: buckets.frontend,
      });
    }
    if (buckets.tests.length > 0) {
      result.push({
        id: "tests",
        category: "tests",
        title: `${result.length + 1}. Automated Tests & Fixtures`,
        description: "Behavioral test suites, mock agents, and regression verification.",
        icon: TestTubeIcon,
        files: buckets.tests,
      });
    }
    if (buckets.docs.length > 0) {
      result.push({
        id: "docs",
        category: "docs",
        title: `${result.length + 1}. Documentation & Release Notes`,
        description: "Architectural decisions, protocol traps, guides, and user manuals.",
        icon: FileTextIcon,
        files: buckets.docs,
      });
    }

    return result;
  }, [files]);

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  const handleAskAgent = () => {
    if (!onSendToAgent) return;
    const fileList = files.map((f) => f.path).join(", ");
    onSendToAgent(
      `Please provide a comprehensive architectural walkthrough of these changes (${files.length} files: ${fileList}). Explain: 1) The motivation and high-level structure, 2) The step-by-step flow from contracts to UI, and 3) Any potential edge cases or regressions to watch out for.`,
    );
  };

  return (
    <div
      data-changes-walkthrough="true"
      className={cn(
        "flex h-full flex-col overflow-hidden border-l border-border/80 bg-background/95 backdrop-blur-md",
        className,
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CompassIcon className="size-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">Changes Walkthrough</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-mono">
            {files.length} {files.length === 1 ? "file" : "files"}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {onSendToAgent ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleAskAgent}
                    className="h-6 gap-1 px-2 text-[11px] text-primary hover:text-primary hover:bg-primary/10"
                  >
                    <SparklesIcon className="size-3" />
                    <span>Explain in chat</span>
                  </Button>
                }
              />
              <TooltipPopup>Ask agent for a detailed architectural walkthrough</TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="size-6 text-muted-foreground hover:text-foreground"
            aria-label="Close walkthrough"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Summary Banner */}
      <div className="border-b border-border/50 bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
        <span>Organized into </span>
        <strong className="text-foreground">{steps.length} logical review steps</strong>
        <span> · </span>
        <span className="text-emerald-600 dark:text-emerald-400 font-mono font-medium">
          +{totalAdditions}
        </span>
        <span> / </span>
        <span className="text-rose-600 dark:text-rose-400 font-mono font-medium">
          -{totalDeletions}
        </span>
      </div>

      {/* Steps List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 [scrollbar-width:thin]">
        {steps.map((step) => {
          const Icon = step.icon;
          const stepAdditions = step.files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
          const stepDeletions = step.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

          return (
            <div
              key={step.id}
              className="rounded-xl border border-border/70 bg-card/60 p-3 shadow-2xs transition-all hover:border-border"
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-3.5" />
                  </div>
                  <span className="text-xs font-semibold text-foreground">{step.title}</span>
                </div>
                <div className="flex items-center gap-1 font-mono text-[10px]">
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    +{stepAdditions}
                  </span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-rose-600 dark:text-rose-400 font-medium">
                    -{stepDeletions}
                  </span>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed mb-2.5">
                {step.description}
              </p>

              <div className="space-y-1">
                {step.files.map((file) => {
                  const fileName = file.path.split("/").pop() ?? file.path;
                  const dirPath = file.path.slice(0, file.path.length - fileName.length);

                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => onSelectFile?.(file.path)}
                      className="group/file flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/80"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-foreground group-hover/file:text-primary font-mono text-[11px]">
                          {fileName}
                        </span>
                        {dirPath ? (
                          <span className="truncate text-[10px] text-muted-foreground/70">
                            {dirPath}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {file.additions !== undefined ? (
                          <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                            +{file.additions}
                          </span>
                        ) : null}
                        {file.deletions !== undefined ? (
                          <span className="font-mono text-[10px] text-rose-600 dark:text-rose-400">
                            -{file.deletions}
                          </span>
                        ) : null}
                        <ArrowRightIcon className="size-3 text-muted-foreground opacity-0 group-hover/file:opacity-100 transition-opacity" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
