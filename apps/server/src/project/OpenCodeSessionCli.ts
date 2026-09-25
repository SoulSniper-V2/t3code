/** Bounded, read-only process boundary for importing OpenCode sessions. */
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import {
  parseOpenCodeSessionExport,
  parseOpenCodeSessionList,
  type OpenCodeImportedSession,
  type OpenCodeSessionList,
  type OpenCodeSessionListEntry,
  type OpenCodeSessionReadResult,
} from "./OpenCodeSessionReader.ts";

export const OPENCODE_SESSION_LIST_MAX_COUNT = 500;
export const OPENCODE_SESSION_LIST_MAX_OUTPUT_BYTES = 1024 * 1024;
export const OPENCODE_SESSION_EXPORT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const OPENCODE_SESSION_EXPORT_MAX_COUNT = 100;
export const OPENCODE_SESSION_EXPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const OPENCODE_CLI_TIMEOUT = "15 seconds";

export interface OpenCodeSessionCliContext {
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  /** Defaults to `opencode`; callers should use the ordinary hydrated PATH. */
  readonly executable?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly workspaceRoot?: string;
}

export interface OpenCodeSessionExport {
  readonly listedSession: OpenCodeSessionListEntry;
  readonly importedSession: OpenCodeImportedSession;
}

export interface OpenCodeSessionExportBatch {
  readonly sessions: ReadonlyArray<OpenCodeSessionExport>;
  readonly skippedCount: number;
  readonly truncated: boolean;
}

export type OpenCodeSessionCliResult<T> =
  | OpenCodeSessionReadResult<T>
  | {
      readonly ok: false;
      readonly error: "command-unavailable" | "command-failed";
    };

/** List session metadata only. This never exports or reads conversation history. */
export function listOpenCodeSessions(
  input: OpenCodeSessionCliContext,
): Effect.Effect<OpenCodeSessionCliResult<OpenCodeSessionList>> {
  return Effect.gen(function* () {
    const output = yield* runCli({
      ...input,
      args: [
        "session",
        "list",
        "--max-count",
        String(OPENCODE_SESSION_LIST_MAX_COUNT),
        "--format",
        "json",
      ],
      maxOutputBytes: OPENCODE_SESSION_LIST_MAX_OUTPUT_BYTES,
    });
    if (output === null) return { ok: false, error: "command-unavailable" } as const;
    if (!successfulJsonOutput(output)) return { ok: false, error: "command-failed" } as const;

    return parseOpenCodeSessionList(output.stdout, input.workspaceRoot);
  });
}

/**
 * Export at most the selected sessions. Omitted IDs mean legacy import-all;
 * an empty ID list means export none. Exports are sequential and discarded
 * immediately after parsing, so raw provider JSON is never retained here.
 */
export function exportSelectedOpenCodeSessions(
  input: OpenCodeSessionCliContext & {
    readonly workspaceRoot: string;
    readonly listedSessions: ReadonlyArray<OpenCodeSessionListEntry>;
    readonly selectedSessionIds?: ReadonlyArray<string>;
  },
): Effect.Effect<OpenCodeSessionCliResult<OpenCodeSessionExportBatch>> {
  return Effect.gen(function* () {
    const selectedIds =
      input.selectedSessionIds === undefined ? undefined : new Set(input.selectedSessionIds);
    const selected = input.listedSessions.filter(
      (session) => selectedIds === undefined || selectedIds.has(session.sessionId),
    );
    const bounded = selected.slice(0, OPENCODE_SESSION_EXPORT_MAX_COUNT);
    const sessions: OpenCodeSessionExport[] = [];
    let skippedCount = selected.length - bounded.length;
    let totalBytes = 0;
    let truncated = selected.length > bounded.length;

    for (let index = 0; index < bounded.length; index += 1) {
      const listedSession = bounded[index]!;
      const output = yield* runCli({
        ...input,
        cwd: listedSession.directory,
        args: ["export", listedSession.sessionId],
        maxOutputBytes: OPENCODE_SESSION_EXPORT_MAX_OUTPUT_BYTES,
      });
      if (output === null) {
        if (sessions.length === 0) return { ok: false, error: "command-unavailable" } as const;
        skippedCount += bounded.length - index;
        truncated = true;
        break;
      }
      if (!successfulJsonOutput(output)) {
        skippedCount += 1;
        continue;
      }

      const outputBytes = Buffer.byteLength(output.stdout, "utf8");
      if (totalBytes + outputBytes > OPENCODE_SESSION_EXPORT_MAX_TOTAL_BYTES) {
        skippedCount += bounded.length - index;
        truncated = true;
        break;
      }
      const parsed = parseOpenCodeSessionExport(output.stdout, listedSession, input.workspaceRoot);
      if (!parsed.ok) {
        skippedCount += 1;
        if (parsed.error === "input-too-large" || parsed.error === "too-much-text") {
          truncated = true;
        }
        continue;
      }

      totalBytes += outputBytes;
      sessions.push({ listedSession, importedSession: parsed.value });
    }

    return {
      ok: true,
      value: { sessions, skippedCount, truncated },
    } as const;
  });
}

function runCli(
  input: OpenCodeSessionCliContext & {
    readonly args: ReadonlyArray<string>;
    readonly maxOutputBytes: number;
  },
) {
  return input.runner
    .run({
      command: input.executable ?? "opencode",
      args: input.args,
      cwd: input.cwd,
      env: input.environment,
      timeout: OPENCODE_CLI_TIMEOUT,
      maxOutputBytes: input.maxOutputBytes,
    })
    .pipe(
      Effect.result,
      Effect.map((result) => (result._tag === "Success" ? result.success : null)),
    );
}

function successfulJsonOutput(output: {
  readonly stdout: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
}): boolean {
  return (
    output.code === 0 && !output.timedOut && !output.stdoutTruncated && !output.stdoutInvalidUtf8
  );
}
