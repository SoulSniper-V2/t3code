// @effect-diagnostics globalDate:off - Dates here are fixed fixture timestamps, not Effect clock reads.
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  parseOpenCodeSessionExport,
  parseOpenCodeSessionList,
  type OpenCodeSessionListEntry,
} from "./OpenCodeSessionReader.ts";

const workspace = "/Users/test/project";
const sessionId = "ses_abc123";

function listedSession(
  overrides: Partial<OpenCodeSessionListEntry> = {},
): OpenCodeSessionListEntry {
  return {
    sessionId,
    title: "A session",
    directory: workspace,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_001_000).toISOString(),
    ...overrides,
  };
}

function exportDocument(
  messages: ReadonlyArray<unknown>,
  overrides: { id?: string; directory?: string } = {},
): string {
  return JSON.stringify({
    info: {
      id: overrides.id ?? sessionId,
      directory: overrides.directory ?? workspace,
    },
    messages,
  });
}

function message(
  role: string,
  text: string,
  created = 1_700_000_000_000,
  extraParts: ReadonlyArray<unknown> = [],
) {
  return {
    info: { role, time: { created } },
    parts: [{ type: "text", text }, ...extraParts],
  };
}

describe("parseOpenCodeSessionList", () => {
  it("keeps only valid sessions for the requested workspace", () => {
    const result = parseOpenCodeSessionList(
      JSON.stringify([
        {
          id: sessionId,
          title: "Selected workspace",
          directory: `${workspace}/./`,
          created: 1_700_000_000_000,
          updated: 1_700_000_001_000,
        },
        {
          id: "ses_other",
          title: "Other workspace",
          directory: "/Users/test/elsewhere",
          created: 1,
          updated: 2,
        },
        { id: "bad;id", title: "Unsafe id", directory: workspace },
        { id: "ses_relative", title: "Relative directory", directory: "../project" },
      ]),
      workspace,
    );

    NodeAssert.equal(result.ok, true);
    if (!result.ok) return;
    NodeAssert.equal(result.value.sessions.length, 1);
    NodeAssert.equal(result.value.sessions[0]!.sessionId, sessionId);
    NodeAssert.equal(result.value.sessions[0]!.directory, workspace);
    NodeAssert.equal(
      result.value.sessions[0]!.createdAt,
      new Date(1_700_000_000_000).toISOString(),
    );
    NodeAssert.equal(result.value.skippedCount, 3);
  });

  it("rejects malformed JSON, non-array roots, and a relative workspace", () => {
    NodeAssert.deepEqual(parseOpenCodeSessionList("not json", workspace), {
      ok: false,
      error: "invalid-json",
    });
    NodeAssert.deepEqual(parseOpenCodeSessionList("{}", workspace), {
      ok: false,
      error: "invalid-shape",
    });
    NodeAssert.deepEqual(parseOpenCodeSessionList("[]", "relative/project"), {
      ok: false,
      error: "invalid-workspace",
    });
  });

  it("can safely list absolute workspaces before a specific project is selected", () => {
    const result = parseOpenCodeSessionList(
      JSON.stringify([
        { id: sessionId, title: "One", directory: workspace },
        { id: "ses_other", title: "Other", directory: "/Users/test/other" },
        { id: "ses_relative", title: "Relative", directory: "../other" },
      ]),
    );

    NodeAssert.equal(result.ok, true);
    if (!result.ok) return;
    NodeAssert.deepEqual(
      result.value.sessions.map((session) => session.directory),
      [workspace, "/Users/test/other"],
    );
    NodeAssert.equal(result.value.skippedCount, 1);
  });

  it("rejects an oversized list and an excessive session count", () => {
    NodeAssert.deepEqual(parseOpenCodeSessionList("x".repeat(1024 * 1024 + 1), workspace), {
      ok: false,
      error: "input-too-large",
    });
    NodeAssert.deepEqual(
      parseOpenCodeSessionList(JSON.stringify(Array.from({ length: 501 }, () => ({}))), workspace),
      { ok: false, error: "too-many-sessions" },
    );
  });
});

describe("parseOpenCodeSessionExport", () => {
  it("retains only user and assistant text, excluding tool, reasoning, ignored, and synthetic parts", () => {
    const result = parseOpenCodeSessionExport(
      exportDocument([
        message("user", "Question", 1_700_000_000_000, [
          { type: "image", url: "file:///private/image.png" },
          { type: "text", text: "synthetic", synthetic: true },
          { type: "text", text: "ignored", ignored: true },
        ]),
        {
          info: { role: "assistant", time: { created: 1_700_000_001_000 } },
          parts: [
            { type: "reasoning", text: "private chain of thought" },
            { type: "tool", name: "read", state: { output: "tool output" } },
            { type: "text", text: "Answer" },
            { type: "text", text: "Additional answer" },
          ],
        },
        message("system", "Ignore me"),
        { info: { role: "assistant", time: { created: 3 } }, parts: "not parts" },
      ]),
      listedSession(),
      workspace,
    );

    NodeAssert.equal(result.ok, true);
    if (!result.ok) return;
    NodeAssert.deepEqual(result.value.messages, [
      {
        role: "user",
        text: "Question",
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
      {
        role: "assistant",
        text: "Answer\nAdditional answer",
        createdAt: new Date(1_700_000_001_000).toISOString(),
      },
    ]);
  });

  it("rejects exports whose session ID or workspace disagrees with the list entry", () => {
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument([], { id: "ses_different" }),
        listedSession(),
        workspace,
      ),
      { ok: false, error: "export-session-mismatch" },
    );
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument([], { directory: "/tmp/other" }),
        listedSession(),
        workspace,
      ),
      { ok: false, error: "export-workspace-mismatch" },
    );
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument([]),
        listedSession({ directory: "/tmp/other" }),
        workspace,
      ),
      { ok: false, error: "workspace-mismatch" },
    );
  });

  it("rejects sanitized exports because sanitization removes importable content", () => {
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument([message("user", "[redacted:text:prt_123]")]),
        listedSession(),
        workspace,
      ),
      { ok: false, error: "sanitized-export" },
    );
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument([], { directory: "[redacted:session-directory:ses_abc123]" }),
        listedSession(),
        workspace,
      ),
      { ok: false, error: "sanitized-export" },
    );
  });

  it("bounds imported message count by keeping only the newest messages", () => {
    const result = parseOpenCodeSessionExport(
      exportDocument(
        Array.from({ length: 205 }, (_, index) => message("user", `message ${index}`, index + 1)),
      ),
      listedSession(),
      workspace,
    );

    NodeAssert.equal(result.ok, true);
    if (!result.ok) return;
    NodeAssert.equal(result.value.messages.length, 200);
    NodeAssert.equal(result.value.truncatedMessageCount, 5);
    NodeAssert.equal(result.value.messages[0]!.text, "message 5");
    NodeAssert.equal(result.value.messages.at(-1)!.text, "message 204");
  });

  it("rejects exports exceeding the byte or raw message-count budget", () => {
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport("x".repeat(32 * 1024 * 1024 + 1), listedSession(), workspace),
      { ok: false, error: "input-too-large" },
    );
    NodeAssert.deepEqual(
      parseOpenCodeSessionExport(
        exportDocument(Array.from({ length: 10_001 }, () => ({}))),
        listedSession(),
        workspace,
      ),
      { ok: false, error: "too-many-messages" },
    );
  });
});
