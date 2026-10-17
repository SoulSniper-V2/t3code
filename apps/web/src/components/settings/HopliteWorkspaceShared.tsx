import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type HopliteMutateInput,
  type HopliteReadInput,
  type HopliteReadResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { ensureLocalApi } from "../../localApi";
import { hopliteEnvironment } from "../../state/hoplite";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSessionState } from "../../state/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { isHopliteResourceMissing } from "./hopliteWorkspace.logic";

export interface HopliteTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}

export type ReadRequest = HopliteReadInput["request"];
export type ReadData<K extends HopliteReadResult["type"]> = Extract<
  HopliteReadResult,
  { type: K }
>["data"];

export function useHopliteRead<const R extends ReadRequest>(target: HopliteTarget, request: R) {
  const atom = hopliteEnvironment.read({
    environmentId: target.environmentId,
    input: { instanceId: target.instanceId, request },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const data: ReadData<R["type"]> | undefined =
    result._tag === "Success" && result.value.type === request.type
      ? (result.value.data as ReadData<R["type"]>)
      : undefined;
  return { result, refresh, data };
}

export function useHopliteMutation(
  target: HopliteTarget,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
) {
  const session = useEnvironmentSessionState(target.environmentId);
  const allowed =
    !session.hasError &&
    session.data !== null &&
    scopes.every((scope) => sessionGrantsScope(session.data!, scope));
  const command = useAtomCommand(hopliteEnvironment.mutate);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const writable = allowed && !target.readOnly;
  const mutate = async (
    mutation: HopliteMutateInput["mutation"],
    confirmation?: string,
    destructive = false,
  ) => {
    if (!writable || active.current) return false;
    active.current = true;
    setBusy(true);
    try {
      if (
        confirmation &&
        !(await ensureLocalApi().dialogs.confirm(confirmation, {
          variant: destructive ? "destructive" : "default",
        }))
      )
        return false;
      const result = await command({
        environmentId: target.environmentId,
        input: { instanceId: target.instanceId, idempotencyKey: randomUUID(), mutation },
      });
      if (result._tag !== "Success") return false;
      toastManager.add({ type: "success", title: "Hoplite change accepted" });
      return true;
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { mutate, writable, busy };
}

export function HopliteFold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2 py-2">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} aria-expanded={open}>
          {open ? "−" : "+"} {title}
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        {open ? <div className="grid min-w-0 gap-3 pb-4">{children}</div> : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function QueryFeedback({
  result,
  refresh,
  empty,
  missing,
}: {
  result: {
    readonly _tag: string;
    readonly waiting?: boolean;
    readonly cause?: Cause.Cause<unknown>;
  };
  refresh: () => void;
  empty?: boolean;
  missing?: string;
}) {
  if (result._tag === "Initial")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading from Hoplite…
      </p>
    );
  if (result._tag === "Failure" && result.cause && missing) {
    const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause));
    if (isHopliteResourceMissing(failure))
      return <p className="text-xs text-muted-foreground">{missing}</p>;
  }
  if (result._tag === "Failure")
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Could not load this resource. Check the connection and your Hoplite permissions.
        </span>
        <Button size="xs" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  if (empty) return <p className="text-xs text-muted-foreground">Nothing here yet.</p>;
  return null;
}

export function HopliteField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        size="sm"
        value={value}
        type={type}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={type === "password" ? "new-password" : "off"}
      />
    </label>
  );
}

export function HopliteLink({ href, children }: { href: string; children: ReactNode }) {
  let safe = false;
  try {
    safe = new URL(href).protocol === "https:";
  } catch {
    safe = false;
  }
  return safe ? (
    <Button
      size="xs"
      variant="outline"
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
    >
      {children}
    </Button>
  ) : null;
}

export function micros(value: number | null | undefined) {
  return value == null
    ? "Not reported"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value / 1_000_000);
}

export function Metrics({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
