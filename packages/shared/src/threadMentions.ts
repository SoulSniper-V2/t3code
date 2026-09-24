import { ComposerContextId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const THREAD_MENTION_PATH_PREFIX = "thread://";
export const THREAD_MENTION_CONTEXT_ID_PREFIX = "thread_";

const decodeComposerContextId = Schema.decodeUnknownOption(ComposerContextId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

export function threadMentionContextIdForThreadId(threadId: ThreadId): ComposerContextId | null {
  return Option.getOrNull(
    decodeComposerContextId(`${THREAD_MENTION_CONTEXT_ID_PREFIX}${threadId}`),
  );
}

export function threadIdFromThreadMentionContextId(contextId: string): ThreadId | null {
  if (!contextId.startsWith(THREAD_MENTION_CONTEXT_ID_PREFIX)) return null;
  return Option.getOrNull(decodeThreadId(contextId.slice(THREAD_MENTION_CONTEXT_ID_PREFIX.length)));
}

export function threadMentionPathForThreadId(threadId: ThreadId): string {
  return `${THREAD_MENTION_PATH_PREFIX}${threadId}`;
}

export function isThreadMentionPath(path: string): boolean {
  return path.startsWith(THREAD_MENTION_PATH_PREFIX);
}

export function threadIdFromThreadMentionPath(path: string): ThreadId | null {
  if (!isThreadMentionPath(path)) return null;
  return Option.getOrNull(decodeThreadId(path.slice(THREAD_MENTION_PATH_PREFIX.length)));
}
