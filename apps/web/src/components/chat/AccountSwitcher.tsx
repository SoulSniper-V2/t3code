"use client";

import { memo, useMemo, useState } from "react";
import { UserCheckIcon, UsersIcon, PlusIcon, CheckIcon } from "lucide-react";
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";

interface AccountSwitcherProps {
  activeInstanceId: ProviderInstanceId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  onSelectInstance: (instanceId: ProviderInstanceId) => void;
  onOpenAddAccount?: () => void;
  size?: "sm" | "xs";
  className?: string;
}

export const AccountSwitcher = memo(function AccountSwitcher({
  activeInstanceId,
  instanceEntries,
  onSelectInstance,
  onOpenAddAccount,
  size = "sm",
  className,
}: AccountSwitcherProps) {
  const [open, setOpen] = useState(false);

  const activeEntry = useMemo(
    () => instanceEntries.find((entry) => entry.instanceId === activeInstanceId) ?? null,
    [activeInstanceId, instanceEntries],
  );

  // Group instances by driver kind so multiple accounts of the same driver are grouped together
  const accountsByDriver = useMemo(() => {
    const groups = new Map<ProviderDriverKind, ProviderInstanceEntry[]>();
    for (const entry of instanceEntries) {
      const list = groups.get(entry.driverKind) ?? [];
      list.push(entry);
      groups.set(entry.driverKind, list);
    }
    return groups;
  }, [instanceEntries]);

  const hasMultipleAccounts = instanceEntries.length > 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size={size === "xs" ? "xs" : "sm"}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
                    className,
                  )}
                  aria-label="Hot-swap active AI account"
                >
                  <UsersIcon className="size-3.5 opacity-70" />
                  <span className="max-w-28 truncate">{activeEntry?.displayName ?? "Account"}</span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup>
          {hasMultipleAccounts ? "Hot-swap active provider account" : "Manage AI provider accounts"}
        </TooltipPopup>
      </Tooltip>

      <PopoverPopup className="w-64 p-2" sideOffset={6} align="start">
        <div className="mb-2 flex items-center justify-between border-b border-border/60 pb-1.5 px-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <UserCheckIcon className="size-3.5 text-primary" />
            <span>AI Accounts</span>
          </div>
          {onOpenAddAccount ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOpen(false);
                onOpenAddAccount();
              }}
            >
              <PlusIcon className="size-3" />
              <span>Add account</span>
            </Button>
          ) : null}
        </div>

        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]">
          {Array.from(accountsByDriver.entries()).map(([driverKind, accounts]) => {
            const driverTitle = PROVIDER_DISPLAY_NAMES[driverKind] ?? driverKind;
            return (
              <div key={driverKind} className="flex flex-col gap-0.5">
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {driverTitle}
                </span>
                {accounts.map((account) => {
                  const isSelected = account.instanceId === activeInstanceId;
                  const showBadge = shouldShowInstanceBadge(account, instanceEntries);
                  return (
                    <button
                      key={account.instanceId}
                      type="button"
                      onClick={() => {
                        onSelectInstance(account.instanceId);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        isSelected
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-foreground hover:bg-muted/80",
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <ProviderInstanceIcon
                          driverKind={account.driverKind}
                          displayName={account.displayName}
                          accentColor={account.accentColor}
                          showBadge={showBadge}
                          className="size-4"
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">{account.displayName}</span>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {account.instanceId}
                          </span>
                        </div>
                      </div>
                      {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
