import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverCommandCodeSessions,
  parseCommandCodeTranscript,
} from "./CommandCodeSessionReader.ts";

const HEADER_TIME = "2026-09-01T10:00:00.000Z";

function jsonl(
  records: ReadonlyArray<Record<string, unknown>>,
  cwd = "/tmp/project",
  id = "session-1",
) {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: HEADER_TIME, cwd }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n");
}

function messageRecord(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant" | "system";
  readonly text?: string;
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly timestamp?: string;
}) {
  return {
    type: "message",
    id: input.id,
    parentId: input.parentId,
    timestamp: input.timestamp ?? HEADER_TIME,
    message: {
      role: input.role,
      content: input.content ?? [{ type: "text", text: input.text ?? "" }],
    },
  };
}

const makeTempDir = Effect.fnUntraced(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeSession = Effect.fnUntraced(function* (
  home: string,
  input: {
    readonly projectSlug: string;
    readonly id: string;
    readonly cwd: string;
    readonly records: ReadonlyArray<Record<string, unknown>>;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".commandcode", "projects", input.projectSlug);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const filePath = path.join(directory, `${input.id}.jsonl`);
  yield* fileSystem.writeFileString(filePath, jsonl(input.records, input.cwd, input.id));
  return filePath;
});

it.layer(NodeServices.layer)("CommandCodeSessionReader", (it) => {
  describe("parseCommandCodeTranscript", () => {
    it("follows the newest path as an explicitly history-only preview and keeps visible text only", () => {
      const transcript = jsonl([
        messageRecord({ id: "u1", parentId: null, role: "user", text: "Start the task" }),
        messageRecord({
          id: "a1",
          parentId: "u1",
          role: "assistant",
          content: [
            { type: "text", text: "Inactive branch answer" },
            { type: "tool_use", name: "bash", input: { command: "echo hidden" } },
          ],
          timestamp: "2026-09-01T10:01:00.000Z",
        }),
        messageRecord({ id: "u2", parentId: "u1", role: "user", text: "Use the other approach" }),
        {
          type: "model_change",
          id: "model-1",
          parentId: "u2",
          timestamp: "2026-09-01T10:02:00.000Z",
          model: "internal-model-metadata",
        },
        messageRecord({
          id: "a2",
          parentId: "model-1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "tool_result", content: "private tool output" },
            { type: "text", text: "Active branch answer" },
          ],
          timestamp: "2026-09-01T10:03:00.000Z",
        }),
      ]);

      const result = parseCommandCodeTranscript(transcript);

      expect(result?.messages).toEqual([
        { role: "user", text: "Start the task", createdAt: HEADER_TIME },
        { role: "user", text: "Use the other approach", createdAt: HEADER_TIME },
        { role: "assistant", text: "Active branch answer", createdAt: "2026-09-01T10:03:00.000Z" },
      ]);
      expect(result?.title).toBe("Start the task");
      expect(result?.model).toBeNull();
      expect(result?.updatedAt).toBe("2026-09-01T10:03:00.000Z");
      expect(result?.branchStatus).toBe("ambiguous");
      expect(result?.historyOnly).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private reasoning");
      expect(JSON.stringify(result)).not.toContain("private tool output");
      expect(JSON.stringify(result)).not.toContain("echo hidden");
    });

    it("marks even a single tree leaf history-only because no stable active pointer is documented", () => {
      const result = parseCommandCodeTranscript(
        jsonl([
          messageRecord({ id: "u1", parentId: null, role: "user", text: "hello" }),
          messageRecord({ id: "a1", parentId: "u1", role: "assistant", text: "there" }),
        ]),
      );

      expect(result?.branchStatus).toBe("unverified");
      expect(result?.historyOnly).toBe(true);
    });

    it("rejects unsupported headers and workspace mismatches", () => {
      const valid = jsonl([
        messageRecord({ id: "u1", parentId: null, role: "user", text: "hello" }),
      ]);
      const relativeWorkspace = jsonl(
        [messageRecord({ id: "u1", parentId: null, role: "user", text: "hello" })],
        "relative/project",
      );
      const dotSegments = jsonl(
        [messageRecord({ id: "u1", parentId: null, role: "user", text: "hello" })],
        "/tmp/project/../other",
      );
      const unsupportedVersion = valid.replace('"version":3', '"version":4');

      expect(
        parseCommandCodeTranscript(valid, { expectedWorkspaceRoot: "/tmp/other" }),
      ).toBeUndefined();
      expect(parseCommandCodeTranscript(relativeWorkspace)).toBeUndefined();
      expect(parseCommandCodeTranscript(dotSegments)).toBeUndefined();
      expect(parseCommandCodeTranscript(unsupportedVersion)).toBeUndefined();
      expect(
        parseCommandCodeTranscript(valid, { expectedSessionId: "different-id" }),
      ).toBeUndefined();
    });

    it("rejects transcripts that exceed byte or record caps and detects malformed trees", () => {
      const transcript = jsonl([
        messageRecord({ id: "u1", parentId: null, role: "user", text: "hello" }),
        messageRecord({ id: "a1", parentId: "u1", role: "assistant", text: "world" }),
      ]);
      const cycle = jsonl([
        messageRecord({ id: "u1", parentId: "a1", role: "user", text: "hello" }),
        messageRecord({ id: "a1", parentId: "u1", role: "assistant", text: "world" }),
      ]);

      expect(parseCommandCodeTranscript(transcript, { maxBytes: 1 })).toBeUndefined();
      expect(parseCommandCodeTranscript(transcript, { maxRecords: 1 })).toBeUndefined();
      expect(parseCommandCodeTranscript(cycle)).toBeUndefined();
    });

    it("bounds message count and characters while marking a partial transcript", () => {
      const transcript = jsonl([
        messageRecord({
          id: "u1",
          parentId: null,
          role: "user",
          text: "first prompt is quite long",
        }),
        messageRecord({ id: "a1", parentId: "u1", role: "assistant", text: "middle response" }),
        messageRecord({ id: "u2", parentId: "a1", role: "user", text: "latest prompt" }),
        messageRecord({ id: "a2", parentId: "u2", role: "assistant", text: "latest answer" }),
      ]);

      const result = parseCommandCodeTranscript(transcript, {
        maxMessages: 3,
        maxMessageChars: 6,
        maxTotalMessageChars: 18,
      });

      expect(result?.messages).toHaveLength(3);
      expect(result?.messages[0]?.role).toBe("user");
      expect(
        result?.messages.reduce((total, message) => total + message.text.length, 0),
      ).toBeLessThanOrEqual(18);
      expect(result?.messages.every((message) => message.text.length <= 6)).toBe(true);
      expect(result?.truncated).toBe(true);
    });
  });

  describe("discoverCommandCodeSessions", () => {
    it.effect("reads only standard HOME projects and filters by validated cwd", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3-command-code-home-");
        const workspace = path.join(home, "work", "project");
        const otherWorkspace = path.join(home, "work", "other");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        yield* fileSystem.makeDirectory(otherWorkspace, { recursive: true });
        yield* writeSession(home, {
          projectSlug: "project-slug",
          id: "session-match",
          cwd: workspace,
          records: [
            messageRecord({ id: "u1", parentId: null, role: "user", text: "right workspace" }),
          ],
        });
        yield* writeSession(home, {
          projectSlug: "other-slug",
          id: "session-other",
          cwd: otherWorkspace,
          records: [
            messageRecord({ id: "u1", parentId: null, role: "user", text: "wrong workspace" }),
          ],
        });
        const projects = path.join(home, ".commandcode", "projects");
        yield* fileSystem.makeDirectory(path.join(projects, "nested", "deeper"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(projects, "nested", "deeper", "ignored.jsonl"),
          jsonl(
            [messageRecord({ id: "u1", parentId: null, role: "user", text: "nested" })],
            workspace,
            "ignored",
          ),
        );
        yield* fileSystem.makeDirectory(path.join(home, ".commandcode", "settings"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(home, ".commandcode", "settings", "providers.json"),
          "must not be read",
        );

        vi.stubEnv("HOME", home);
        try {
          const result = yield* discoverCommandCodeSessions({ expectedWorkspaceRoot: workspace });
          expect(result.sessions).toHaveLength(1);
          expect(result.sessions[0]?.sessionId).toBe("session-match");
          expect(result.sessions[0]?.workspaceRoot).toBe(workspace);
          expect(result.sessions[0]?.fileIdentity.filePath).toContain(
            ".commandcode/projects/project-slug/",
          );
          expect(result.sessions[0]?.fileIdentity.size).toBeGreaterThan(0);
          expect(result.sessions[0]?.fileIdentity.device).toBeTypeOf("number");
          expect(result.sessions[0]?.fileIdentity.inode).toBeTypeOf("number");
          expect(result.sessions[0]?.historyOnly).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      }),
    );

    it.effect("caps total transcript bytes and skips symbolic-link transcript files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3-command-code-home-");
        const workspace = path.join(home, "project");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        const firstPath = yield* writeSession(home, {
          projectSlug: "one",
          id: "session-one",
          cwd: workspace,
          records: [messageRecord({ id: "u1", parentId: null, role: "user", text: "one" })],
        });
        yield* writeSession(home, {
          projectSlug: "two",
          id: "session-two",
          cwd: workspace,
          records: [messageRecord({ id: "u1", parentId: null, role: "user", text: "two" })],
        });
        const links = path.join(home, ".commandcode", "projects", "links");
        yield* fileSystem.makeDirectory(links, { recursive: true });
        yield* fileSystem.symlink(firstPath, path.join(links, "linked-session.jsonl"));
        const firstInfo = yield* fileSystem.stat(firstPath);
        const oneSize = Number(ByteSize.toBigInt(firstInfo.size));

        vi.stubEnv("HOME", home);
        try {
          const result = yield* discoverCommandCodeSessions({
            maxTotalBytes: oneSize,
            maxTranscripts: 10,
          });
          expect(result.bytesRead).toBeLessThanOrEqual(oneSize);
          expect(result.sessions).toHaveLength(1);
          expect(result.truncated).toBe(true);
          expect(result.sessions[0]?.sessionId).not.toBe("linked-session");
        } finally {
          vi.unstubAllEnvs();
        }
      }),
    );

    it.effect(
      "returns an empty result for an invalid workspace filter or missing projects directory",
      () =>
        Effect.gen(function* () {
          const home = yield* makeTempDir("t3-command-code-home-");
          vi.stubEnv("HOME", home);
          try {
            expect(
              yield* discoverCommandCodeSessions({ expectedWorkspaceRoot: "relative/path" }),
            ).toMatchObject({
              sessions: [],
              bytesRead: 0,
              recordsRead: 0,
            });
            expect(yield* discoverCommandCodeSessions()).toMatchObject({
              sessions: [],
              truncated: false,
            });
          } finally {
            vi.unstubAllEnvs();
          }
        }),
    );
  });
});
