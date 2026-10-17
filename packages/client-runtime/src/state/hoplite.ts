import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHopliteEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    projects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hoplite:projects",
      tag: WS_METHODS.hopliteListProjects,
      staleTimeMs: 10_000,
    }),
    threads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hoplite:threads",
      tag: WS_METHODS.hopliteListThreads,
      staleTimeMs: 5_000,
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hoplite:read",
      tag: WS_METHODS.hopliteRead,
      staleTimeMs: 5_000,
    }),
    importThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite:import",
      tag: WS_METHODS.hopliteImportThread,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite:mutate",
      tag: WS_METHODS.hopliteMutate,
    }),
  };
}
