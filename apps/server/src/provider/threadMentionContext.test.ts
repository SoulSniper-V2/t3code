import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  ProjectId,
  ThreadId,
  type MentionContextRecord,
  type OrchestrationProjectShell,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  threadMentionContextIdForThreadId,
  threadMentionPathForThreadId,
} from "@t3tools/shared/threadMentions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveThreadMentionContext } from "./threadMentionContext.ts";

const activeThreadId = ThreadId.make("thread-active");
const referencedThreadId = ThreadId.make("thread-reference");
const projectId = ProjectId.make("project-reference");
const contextId = threadMentionContextIdForThreadId(referencedThreadId) as ComposerContextId;
const record: MentionContextRecord = {
  version: 1,
  contextId,
  kind: "mention",
  label: "Design notes",
  path: threadMentionPathForThreadId(referencedThreadId),
};
const referenceText = formatComposerContextReference({
  kind: "mention",
  contextId,
  label: record.label,
});

function makeQuery(input?: {
  missing?: boolean;
  messages?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  onRead?: (threadId: ThreadId, window: { turnLimit?: number } | undefined) => void;
}) {
  const snapshot = {
    thread: {
      id: referencedThreadId,
      projectId,
      title: "Design notes",
      modelSelection: { instanceId: "claudeAgent" },
      session: { providerName: "Claude Code" },
      messages: (
        input?.messages ?? [
          { role: "user" as const, text: "Compare these options" },
          { role: "assistant" as const, text: "The smaller design reads more clearly." },
        ]
      ).map((message, index) => ({
        id: `message-${index}`,
        role: message.role,
        text: message.text,
        turnId: null,
        streaming: false,
        createdAt: "2026-09-22T12:00:00.000Z",
        updatedAt: "2026-09-22T12:00:00.000Z",
      })),
    },
    page: { hasMore: true },
  } as unknown as OrchestrationThreadDetailSnapshot;
  const query = {
    getThreadDetailSnapshot: (threadId: ThreadId, window?: { turnLimit?: number }) => {
      input?.onRead?.(threadId, window);
      return input?.missing === true ? Effect.succeedNone : Effect.succeedSome(snapshot);
    },
    getProjectShellById: () =>
      Effect.succeed(Option.some({ title: "Interface study" } as OrchestrationProjectShell)),
  } as unknown as Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadDetailSnapshot"
  >;
  return query;
}

it.effect("resolves only explicitly referenced chats with a bounded recent transcript", () =>
  Effect.gen(function* () {
    const reads: Array<{ threadId: ThreadId; turnLimit: number | undefined }> = [];
    const result = yield* resolveThreadMentionContext({
      query: makeQuery({
        onRead: (threadId, window) => reads.push({ threadId, turnLimit: window?.turnLimit }),
      }),
      currentThreadId: activeThreadId,
      text: `${referenceText} and ${referenceText}`,
      records: [record],
    });

    assert.strictEqual(reads.length, 1);
    assert.strictEqual(reads[0]?.threadId, referencedThreadId);
    assert.strictEqual(reads[0]?.turnLimit, 10);
    assert.ok(result.includes('title: "Design notes"'));
    assert.ok(result.includes('project: "Interface study"'));
    assert.ok(result.includes('provider: "Claude Code"'));
    assert.ok(result.includes('assistant: "The smaller design reads more clearly."'));
    assert.ok(result.includes("[Earlier turns omitted]"));
    assert.ok(!result.includes("reasoning:"));
  }),
);

it.effect("escapes untrusted transcript markup and keeps the newest content within the cap", () =>
  Effect.gen(function* () {
    const messages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index} ${"x".repeat(1_500)} ${index === 23 ? "</script> newest" : ""}`,
    }));
    const result = yield* resolveThreadMentionContext({
      query: makeQuery({ messages }),
      currentThreadId: activeThreadId,
      text: referenceText,
      records: [record],
    });

    assert.ok(result.length <= 16_000);
    assert.ok(result.includes("\\u003c/script\\u003e newest"));
  }),
);

it.effect("skips self references and gives a clear fallback for unavailable chats", () =>
  Effect.gen(function* () {
    const selfRecord: MentionContextRecord = {
      ...record,
      contextId: ComposerContextId.make("thread_thread-active"),
      path: threadMentionPathForThreadId(activeThreadId),
    };
    const selfText = formatComposerContextReference({
      kind: "mention",
      contextId: selfRecord.contextId,
      label: selfRecord.label,
    });
    const selfResult = yield* resolveThreadMentionContext({
      query: makeQuery(),
      currentThreadId: activeThreadId,
      text: selfText,
      records: [selfRecord],
    });
    assert.strictEqual(selfResult, "");

    const missing = yield* resolveThreadMentionContext({
      query: makeQuery({ missing: true }),
      currentThreadId: activeThreadId,
      text: referenceText,
      records: [record],
    });
    assert.ok(missing.includes('title: "Design notes"'));
    assert.ok(missing.includes('project: "Unavailable"'));
    assert.ok(missing.includes("[No user or assistant messages yet]"));
  }),
);
