import { createHopliteEnvironmentAtoms } from "@t3tools/client-runtime/state/hoplite";
import { connectionAtomRuntime } from "../connection/runtime";

export const hopliteEnvironment = createHopliteEnvironmentAtoms(connectionAtomRuntime);
