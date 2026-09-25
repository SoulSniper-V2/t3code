// @effect-diagnostics preferSchemaOverJson:off - these fixtures deliberately exercise the raw provider JSON parsers.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  parseClineLegacyTaskHistory,
  parseClineLegacyUiMessages,
  parseClineMessages,
  parseClineSessionManifest,
  readClineSessionHistory,
  resolveClineDataDir,
  resolveClineSessionsDir,
} from "./ClineSessionReader.ts";

const makeTempDir = Effect.fnUntraced(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const sdkManifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    session_id: "1784094124598_rruoq",
    source: "cli",
    status: "completed",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-6",
    cwd: "/work/project/packages/app",
    workspace_root: "/work/project",
    started_at: "2026-07-15T05:42:04.609Z",
    messages_path:
      "/home/example/.cline/data/sessions/1784094124598_rruoq/1784094124598_rruoq.messages.json",
    metadata: { title: "Implement the sidebar" },
    ...overrides,
  });

describe("ClineSessionReader paths", () => {
  it("uses Cline's documented data-root precedence and session-root override", () => {
    expect(resolveClineDataDir({ CLINE_DATA_DIR: "/tmp/cline-data" }, "/home/u")).toBe(
      "/tmp/cline-data",
    );
    expect(resolveClineDataDir({ CLINE_DIR: "/tmp/cline-home" }, "/home/u")).toBe(
      "/tmp/cline-home/data",
    );
    expect(resolveClineDataDir({ HOME: "/home/env" }, "/home/u")).toBe("/home/env/.cline/data");
    const defaultDataDir = resolveClineDataDir({}, "/home/u");
    expect(defaultDataDir).toBe("/home/u/.cline/data");
    expect(resolveClineSessionsDir({}, defaultDataDir)).toBe("/home/u/.cline/data/sessions");
    expect(
      resolveClineSessionsDir({ CLINE_SESSION_DATA_DIR: "/tmp/cline-sessions" }, defaultDataDir),
    ).toBe("/tmp/cline-sessions");
  });
});

describe("parseClineSessionManifest", () => {
  it("validates the required SDK manifest fields and expected session ID", () => {
    expect(parseClineSessionManifest(sdkManifest(), "1784094124598_rruoq")).toMatchObject({
      session_id: "1784094124598_rruoq",
      cwd: "/work/project/packages/app",
      workspace_root: "/work/project",
    });
    expect(parseClineSessionManifest(sdkManifest(), "another-session")).toBeNull();
    expect(parseClineSessionManifest(sdkManifest({ cwd: "relative/project" }))).toBeNull();
    expect(parseClineSessionManifest(sdkManifest({ session_id: "../outside" }))).toBeNull();
    expect(parseClineSessionManifest(sdkManifest({ version: 2 }))).toBeNull();
  });
});

describe("parseClineMessages", () => {
  it("keeps visible text only and rejects a different session's message envelope", () => {
    const input = JSON.stringify({
      version: 1,
      sessionId: "1784094124598_rruoq",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: [
            { type: "text", text: "Please fix the failing test." },
            { type: "image", url: "file:///private/image.png" },
          ],
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: [
            { type: "thinking", text: "private reasoning" },
            { type: "tool_call", text: "run tests" },
            { type: "text", text: "I found and fixed the failing assertion." },
          ],
        },
        {
          id: "hidden-user",
          role: "user",
          metadata: { displayRole: "system" },
          content: [{ type: "text", text: "internal injected content" }],
        },
      ],
    });

    expect(parseClineMessages(input, "1784094124598_rruoq", "2026-07-15T05:42:04.609Z")).toEqual([
      {
        role: "user",
        text: "Please fix the failing test.",
        createdAt: "2026-07-15T05:42:04.609Z",
      },
      {
        role: "assistant",
        text: "I found and fixed the failing assertion.",
        createdAt: "2026-07-15T05:42:04.609Z",
      },
    ]);
    expect(parseClineMessages(input, "other-session", "2026-07-15T05:42:04.609Z")).toBeNull();
    expect(
      parseClineMessages("not json", "1784094124598_rruoq", "2026-07-15T05:42:04.609Z"),
    ).toBeNull();
  });
});

describe("legacy Cline task history", () => {
  it("validates history rows before using them", () => {
    expect(
      parseClineLegacyTaskHistory(
        JSON.stringify([
          {
            id: "1784094124598_rruoq",
            ts: 1784094124609,
            task: "Fix the sidebar spacing",
            tokensIn: 100,
            tokensOut: 40,
            totalCost: 0.02,
            cwdOnTaskInitialization: "/work/project",
          },
          { id: "bad/path", task: "not a validated history row" },
        ]),
      ),
    ).toMatchObject([
      {
        id: "1784094124598_rruoq",
        task: "Fix the sidebar spacing",
        cwdOnTaskInitialization: "/work/project",
      },
    ]);
    expect(parseClineLegacyTaskHistory("{}")).toEqual([]);
  });

  it("keeps initial prompt, user feedback, and assistant prose; drops tool and image rows", () => {
    const messages = parseClineLegacyUiMessages(
      JSON.stringify([
        { ts: 1784094124610, type: "say", say: "api_req_started", text: "request payload" },
        { ts: 1784094124611, type: "say", say: "text", text: "I will inspect the component." },
        { ts: 1784094124612, type: "say", say: "user_feedback", text: "Keep the icon aligned." },
        { ts: 1784094124613, type: "ask", ask: "tool", text: "read_file({path: 'x'})" },
        { ts: 1784094124614, type: "say", say: "text", text: "Done." },
      ]),
      "2026-07-15T05:42:04.609Z",
      "Fix the sidebar spacing",
    );

    expect(messages?.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Fix the sidebar spacing" },
      { role: "assistant", text: "I will inspect the component." },
      { role: "user", text: "Keep the icon aligned." },
      { role: "assistant", text: "Done." },
    ]);
    expect(parseClineLegacyUiMessages("not json", "2026-07-15T05:42:04.609Z")).toBeNull();
  });
});

it.layer(NodeServices.layer)("readClineSessionHistory", (it) => {
  it.effect("reads only contained SDK sessions and visible user/assistant text", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir("t3-cline-reader-");
      const dataDir = path.join(root, "cline-data");
      const workspace = path.join(root, "project");
      const outsideWorkspace = path.join(root, "other-project");
      const sessionId = "1784094124598_rruoq";
      const sessionDir = path.join(dataDir, "sessions", sessionId);
      yield* fileSystem.makeDirectory(sessionDir, { recursive: true });
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      yield* fileSystem.makeDirectory(outsideWorkspace, { recursive: true });

      yield* fileSystem.writeFileString(
        path.join(sessionDir, `${sessionId}.json`),
        sdkManifest({
          cwd: workspace,
          workspace_root: workspace,
          messages_path: path.join(sessionDir, `${sessionId}.messages.json`),
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(sessionDir, `${sessionId}.messages.json`),
        JSON.stringify({
          version: 1,
          sessionId,
          messages: [
            { id: "user-1", role: "user", content: [{ type: "text", text: "Please fix it." }] },
            {
              id: "assistant-1",
              role: "assistant",
              content: [
                { type: "tool_call", text: "private command" },
                { type: "text", text: "The issue is fixed." },
              ],
            },
            {
              id: "tool-1",
              role: "assistant",
              metadata: { displayRole: "tool" },
              content: [{ type: "text", text: "private tool output" }],
            },
          ],
        }),
      );

      const invalidSessionId = "another_session";
      const invalidSessionDir = path.join(dataDir, "sessions", invalidSessionId);
      yield* fileSystem.makeDirectory(invalidSessionDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(invalidSessionDir, `${invalidSessionId}.json`),
        sdkManifest({
          session_id: invalidSessionId,
          cwd: outsideWorkspace,
          workspace_root: workspace,
          messages_path: path.join(invalidSessionDir, `${invalidSessionId}.messages.json`),
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(invalidSessionDir, `${invalidSessionId}.messages.json`),
        JSON.stringify({ version: 1, sessionId: invalidSessionId, messages: [] }),
      );

      const sessions = yield* readClineSessionHistory({
        env: { CLINE_DATA_DIR: dataDir },
        homeDir: root,
      });
      const canonicalWorkspace = yield* fileSystem.realPath(workspace);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        source: "cline",
        format: "sdk",
        providerSessionId: sessionId,
        historyOnly: true,
        title: "Implement the sidebar",
        workspaceRoot: canonicalWorkspace,
      });
      expect(sessions[0]?.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Please fix it." },
        { role: "assistant", text: "The issue is fixed." },
      ]);
    }),
  );
});
