"use client";

import { memo, useEffect, useState } from "react";
import { TargetIcon, PauseIcon, PlayIcon, XIcon, PencilIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { ThreadGoalRecord } from "~/threadGoalsStore";

interface ThreadGoalBannerProps {
  goal: ThreadGoalRecord;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onEdit?: (currentText: string) => void;
  className?: string;
}

function formatElapsed(startedAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export const ThreadGoalBanner = memo(function ThreadGoalBanner({
  goal,
  onPause,
  onResume,
  onClear,
  onEdit,
  className,
}: ThreadGoalBannerProps) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(goal.startedAt));

  useEffect(() => {
    if (goal.status === "paused") return;
    const interval = setInterval(() => {
      setElapsed(formatElapsed(goal.startedAt));
    }, 10_000);
    return () => clearInterval(interval);
  }, [goal.startedAt, goal.status]);

  const isActive = goal.status === "active";

  return (
    <div
      data-chat-thread-goal-banner="true"
      className={cn(
        "group/goal flex items-center justify-between gap-2.5 rounded-xl border border-border/80 bg-card/75 px-3 py-2 text-xs shadow-xs backdrop-blur-md transition-all",
        isActive
          ? "border-emerald-500/30 bg-emerald-500/[0.04] dark:border-emerald-500/25 dark:bg-emerald-950/[0.12]"
          : "border-amber-500/30 bg-amber-500/[0.04] dark:border-amber-500/25 dark:bg-amber-950/[0.12]",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative flex shrink-0 items-center justify-center">
          <TargetIcon
            className={cn(
              "size-4 shrink-0 transition-colors",
              isActive
                ? "text-emerald-500 dark:text-emerald-400"
                : "text-amber-500 dark:text-amber-400",
            )}
          />
          {isActive ? (
            <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                isActive
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400",
              )}
            >
              {isActive ? "Active Goal" : "Goal Paused"}
            </span>
            <span className="text-[10px] text-muted-foreground/70">· {elapsed}</span>
          </div>
          <span className="line-clamp-2 text-xs font-medium text-foreground/90">{goal.text}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isActive ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onPause}
                  className="size-6 text-muted-foreground hover:text-foreground"
                  aria-label="Pause goal"
                >
                  <PauseIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup>Pause goal</TooltipPopup>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onResume}
                  className="size-6 text-emerald-500 hover:text-emerald-600 dark:text-emerald-400"
                  aria-label="Resume goal"
                >
                  <PlayIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup>Resume goal</TooltipPopup>
          </Tooltip>
        )}

        {onEdit ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onEdit(goal.text)}
                  className="size-6 text-muted-foreground hover:text-foreground"
                  aria-label="Edit goal"
                >
                  <PencilIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup>Edit goal</TooltipPopup>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onClear}
                className="size-6 text-muted-foreground hover:text-destructive"
                aria-label="Clear goal"
              >
                <XIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup>Clear goal</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
