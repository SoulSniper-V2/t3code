import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

/**
 * Command Code's documented headless interface has no per-turn system-prompt
 * option, so place T3's runtime context before the user's prompt on stdin.
 */
export function buildCommandCodePrompt(input: {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const runtime = buildRuntimeInstructions({
    harness: "Command Code",
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
  });
  return `${runtime}\n\n${input.prompt}`;
}
