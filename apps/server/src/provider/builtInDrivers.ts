/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with. Every registered driver must be listed here and its environment
 * requirements satisfied by the server runtime.
 */
import { AcpRegistryDriver, type AcpRegistryDriverEnv } from "./Drivers/AcpRegistryDriver.ts";
import { AntigravityDriver, type AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { ClineDriver, type ClineDriverEnv } from "./Drivers/ClineDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { CommandCodeDriver, type CommandCodeDriverEnv } from "./Drivers/CommandCodeDriver.ts";
import { CursorDriver, type CursorDriverEnv } from "./Drivers/CursorDriver.ts";
import { GrokDriver, type GrokDriverEnv } from "./Drivers/GrokDriver.ts";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "./Drivers/OpenCodeDriver.ts";
import { PiDriver, type PiDriverEnv } from "./Drivers/PiDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | ClineDriverEnv
  | CodexDriverEnv
  | CommandCodeDriverEnv
  | CursorDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv;

/** Registry lookup is keyed by driver kind; order only affects UI tie-breaking. */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  OpenCodeDriver,
  AntigravityDriver,
  CommandCodeDriver,
  ClineDriver,
  PiDriver,
  AcpRegistryDriver,
];
