// @effect-diagnostics preferSchemaOverJson:off - JSON strings are provider CLI boundary fixtures.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as OpenCodeSessionCli from "./OpenCodeSessionCli.ts";
import type { OpenCodeSessionListEntry } from "./OpenCodeSessionReader.ts";

const workspace = "/Users/test/project";
const createdAt = "2023-11-14T22:13:20.000Z";
const updatedAt = "2023-11-14T22:13:21.000Z";

const listedSession = (sessionId: string): OpenCodeSessionListEntry => ({
  sessionId,
  title: `Session ${sessionId}`,
  directory: workspace,
  createdAt,
  updatedAt,
});

const processOutput = (
  stdout: string,
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const exportJson = (session: OpenCodeSessionListEntry) =>
  JSON.stringify({
    info: { id: session.sessionId, directory: workspace },
    messages: [
      {
        info: { role: "user", time: { created: 1_700_000_000_000 } },
        parts: [{ type: "text", text: "Keep only this text" }],
      },
    ],
  });

const context = {
  executable: "/tools/opencode",
  environment: { PATH: "/tools:/usr/bin" },
  cwd: "/Users/test",
  workspaceRoot: workspace,
};

it.effect("lists workspace metadata without exporting session content", () => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return processOutput(
          JSON.stringify([
            {
              id: "ses_selected",
              title: "Workspace session",
              directory: workspace,
              created: 1_700_000_000_000,
              updated: 1_700_000_001_000,
            },
            {
              id: "ses_other",
              title: "Other workspace",
              directory: "/Users/test/other",
              created: 1,
              updated: 2,
            },
          ]),
        );
      }),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.listOpenCodeSessions({
      ...context,
      runner: processRunner,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sessions: [
          {
            sessionId: "ses_selected",
            title: "Workspace session",
            directory: workspace,
            createdAt,
            updatedAt,
          },
        ],
        skippedCount: 1,
        truncated: false,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/tools/opencode",
      args: ["session", "list", "--max-count", "500", "--format", "json"],
      cwd: context.cwd,
      env: context.environment,
      timeout: "15 seconds",
      maxOutputBytes: 1024 * 1024,
    });
  });
});

it.effect("uses the standard opencode executable when no custom path is set", () => {
  let command = "";
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.sync(() => {
        command = input.command;
        return processOutput("[]");
      }),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.listOpenCodeSessions({
      runner: processRunner,
      environment: context.environment,
      cwd: context.cwd,
      workspaceRoot: context.workspaceRoot,
    });
    expect(result.ok).toBe(true);
    expect(command).toBe("opencode");
  });
});

it.effect("exports only selected IDs using the listed workspace directory", () => {
  const first = listedSession("ses_first");
  const selected = listedSession("ses_selected");
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return processOutput(exportJson(selected));
      }),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.exportSelectedOpenCodeSessions({
      ...context,
      runner: processRunner,
      listedSessions: [first, selected],
      selectedSessionIds: [selected.sessionId],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sessions: [
          {
            listedSession: selected,
            importedSession: {
              sessionId: selected.sessionId,
              title: selected.title,
              directory: workspace,
              createdAt: selected.createdAt,
              updatedAt: selected.updatedAt,
              messages: [
                {
                  role: "user",
                  text: "Keep only this text",
                  createdAt,
                },
              ],
              truncatedMessageCount: 0,
            },
          },
        ],
        skippedCount: 0,
        truncated: false,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/tools/opencode",
      args: ["export", selected.sessionId],
      cwd: workspace,
      env: context.environment,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  });
});

it.effect("does not invoke the CLI when the explicit selection is empty", () => {
  let callCount = 0;
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: () =>
      Effect.sync(() => {
        callCount += 1;
        return processOutput("{}");
      }),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.exportSelectedOpenCodeSessions({
      ...context,
      runner: processRunner,
      listedSessions: [listedSession("ses_selected")],
      selectedSessionIds: [],
    });
    expect(result).toEqual({
      ok: true,
      value: { sessions: [], skippedCount: 0, truncated: false },
    });
    expect(callCount).toBe(0);
  });
});

it.effect("turns an unavailable CLI into a bounded discovery failure", () => {
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          cause: new Error("executable not found"),
        }),
      ),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.listOpenCodeSessions({
      ...context,
      runner: processRunner,
    });
    expect(result).toEqual({ ok: false, error: "command-unavailable" });
  });
});

it.effect("rejects a truncated process result rather than parsing partial JSON", () => {
  const processRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: () => Effect.succeed(processOutput("[]", { stdoutTruncated: true })),
  };

  return Effect.gen(function* () {
    const result = yield* OpenCodeSessionCli.listOpenCodeSessions({
      ...context,
      runner: processRunner,
    });
    expect(result).toEqual({ ok: false, error: "command-failed" });
  });
});
