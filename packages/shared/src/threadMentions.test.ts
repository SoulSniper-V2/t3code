import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isThreadMentionPath,
  threadIdFromThreadMentionContextId,
  threadIdFromThreadMentionPath,
  threadMentionContextIdForThreadId,
  threadMentionPathForThreadId,
} from "./threadMentions.ts";

describe("thread mention references", () => {
  it("round-trips a thread id through its visible path and persisted context id", () => {
    const threadId = ThreadId.make("thread-123");
    const contextId = threadMentionContextIdForThreadId(threadId);

    expect(contextId).not.toBeNull();
    expect(threadIdFromThreadMentionContextId(contextId!)).toBe(threadId);
    expect(threadMentionPathForThreadId(threadId)).toBe("thread://thread-123");
    expect(isThreadMentionPath("thread://thread-123")).toBe(true);
    expect(threadIdFromThreadMentionPath("thread://thread-123")).toBe(threadId);
  });

  it("rejects paths and context ids without a valid thread id", () => {
    expect(threadIdFromThreadMentionContextId("file_thread-123")).toBeNull();
    expect(threadIdFromThreadMentionContextId("thread_")).toBeNull();
    expect(threadIdFromThreadMentionPath("/workspace/file.ts")).toBeNull();
    expect(threadIdFromThreadMentionPath("thread://  ")).toBeNull();
    expect(threadMentionContextIdForThreadId(ThreadId.make("x".repeat(128)))).toBeNull();
  });
});
