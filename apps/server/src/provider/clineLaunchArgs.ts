/**
 * clineLaunchArgs — argv builders for headless Cline runs.
 *
 * Headless mode activates when stdout is redirected or `--json` is passed;
 * the prompt itself is always piped over stdin so long prompts never hit
 * argv length limits. Tool approvals are a launch flag (`--auto-approve`),
 * not a runtime conversation: auto-accept passes `true` explicitly while
 * standard passes `false` and the run stops at approvals.
 *
 * Resume trap: `cline --id <session>` forces interactive mode (requires a
 * TTY) in every CLI version probed, so headless turns always start a fresh
 * Cline session. The adapter therefore never passes `--id`.
 *
 * @module provider/clineLaunchArgs
 */
import type { ClinePermissionMode, ClineThinkingLevel } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const CLINE_VERSION_ARGS = ["--version"] as const;
export const CLINE_HISTORY_ARGS = ["history", "--json", "--limit", "50"] as const;

export interface ClineTurnArgsInput {
  readonly permissionMode: ClinePermissionMode;
  /** Reasoning effort. Omitted when blank so the provider default applies. */
  readonly thinkingLevel?: ClineThinkingLevel | undefined;
  /** Model id passed as `--model`. Omitted when blank. */
  readonly model?: string | undefined;
  /** Provider id passed as `--provider`. Omitted when blank. */
  readonly provider?: string | undefined;
  /** Extra user-provided CLI arguments, tokenized. */
  readonly launchArgs?: string | undefined;
  /** Prompt text. Passed as a positional CLI argument after `--`. */
  readonly prompt?: string | undefined;
}

/** Build the argv for one headless turn. */
export function clineTurnArgs(input: ClineTurnArgsInput): ReadonlyArray<string> {
  const args: string[] = [
    "--json",
    "--auto-approve",
    input.permissionMode === "auto-accept" ? "true" : "false",
  ];
  const thinking = input.thinkingLevel?.trim() ?? "";
  if (thinking.length > 0) {
    args.push("--thinking", thinking);
  }
  if (input.model !== undefined && input.model.trim().length > 0) {
    args.push("--model", input.model.trim());
  }
  if (input.provider !== undefined && input.provider.trim().length > 0) {
    args.push("--provider", input.provider.trim());
  }
  args.push(...tokenizeCliArgs(input.launchArgs));
  if (input.prompt !== undefined && input.prompt.length > 0) {
    args.push("--", input.prompt);
  }
  return args;
}
