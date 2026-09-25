// @effect-diagnostics nodeBuiltinImport:off, globalDate:off - This pure parser uses path normalization and ISO conversion without Effects.
/**
 * Pure, bounded parsers for OpenCode's `session list --format json` and
 * `export <id>` output. This module deliberately does not execute the CLI or
 * persist provider output; callers may retain only the selected transcript
 * text returned by `parseOpenCodeSessionExport`.
 */
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MAX_SESSION_LIST_BYTES = 1024 * 1024;
const MAX_SESSIONS = 500;
const MAX_SESSION_ID_LENGTH = 132;
const MAX_TITLE_LENGTH = 500;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_EXPORT_MESSAGES = 10_000;
const MAX_IMPORTED_MESSAGES = 200;
const MAX_IMPORTED_TEXT_BYTES = 32 * 1024 * 1024;

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{1,128}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const SANITIZED_TEXT_PATTERN = /^\[redacted:text:[^\]]+\]$/;

export interface OpenCodeSessionListEntry {
  readonly sessionId: string;
  readonly title: string;
  /** Directory from `session list`; this is the workspace authority. */
  readonly directory: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface OpenCodeImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface OpenCodeImportedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly directory: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly messages: ReadonlyArray<OpenCodeImportedMessage>;
  /** Number of older text messages omitted to stay within the import bound. */
  readonly truncatedMessageCount: number;
}

export type OpenCodeSessionReadErrorCode =
  | "input-too-large"
  | "invalid-workspace"
  | "invalid-json"
  | "invalid-shape"
  | "too-many-sessions"
  | "invalid-session"
  | "workspace-mismatch"
  | "export-session-mismatch"
  | "export-workspace-mismatch"
  | "sanitized-export"
  | "too-many-messages"
  | "too-much-text";

export type OpenCodeSessionReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: OpenCodeSessionReadErrorCode;
      readonly detail?: string;
    };

export interface OpenCodeSessionList {
  readonly sessions: ReadonlyArray<OpenCodeSessionListEntry>;
  readonly skippedCount: number;
  /** True when the CLI/parser cap may have hidden additional sessions. */
  readonly truncated: boolean;
}

/**
 * Parse JSON from `opencode session list --format json` and retain sessions
 * whose list-provided directory is exactly the selected workspace.
 */
export function parseOpenCodeSessionList(
  stdout: string,
  workspaceRoot?: string,
): OpenCodeSessionReadResult<OpenCodeSessionList> {
  if (utf8ByteLength(stdout) > MAX_SESSION_LIST_BYTES) {
    return failure("input-too-large");
  }
  const workspace =
    workspaceRoot === undefined ? undefined : canonicalAbsoluteDirectory(workspaceRoot);
  if (workspaceRoot !== undefined && workspace === undefined) return failure("invalid-workspace");

  const parsed = parseJson(stdout);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return failure("invalid-shape");
  if (parsed.value.length > MAX_SESSIONS) return failure("too-many-sessions");

  const sessions: OpenCodeSessionListEntry[] = [];
  const seenIds = new Set<string>();
  let skippedCount = 0;

  for (const item of parsed.value) {
    if (!isRecord(item)) {
      skippedCount += 1;
      continue;
    }
    const sessionId = validSessionId(item.id);
    const directory =
      typeof item.directory === "string" ? canonicalAbsoluteDirectory(item.directory) : undefined;
    if (sessionId === undefined || directory === undefined || seenIds.has(sessionId)) {
      skippedCount += 1;
      continue;
    }
    if (workspace !== undefined && !samePath(directory, workspace)) {
      skippedCount += 1;
      continue;
    }

    seenIds.add(sessionId);
    const time = isRecord(item.time) ? item.time : undefined;
    const title =
      typeof item.title === "string" && item.title.trim().length > 0
        ? item.title.trim().slice(0, MAX_TITLE_LENGTH)
        : "Untitled OpenCode session";
    sessions.push({
      sessionId,
      title,
      directory,
      // Current `session list --format json` flattens these to top-level
      // `created`/`updated`; accept the underlying Session.Info time object as
      // well so older CLI builds remain importable.
      createdAt: timestampToIso(item.created ?? time?.created),
      updatedAt: timestampToIso(item.updated ?? time?.updated),
    });
  }

  sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return {
    ok: true,
    value: { sessions, skippedCount, truncated: parsed.value.length >= MAX_SESSIONS },
  };
}

/**
 * Parse an unsanitized `opencode export <sessionId>` JSON document.
 *
 * The workspace is authorized by the session-list entry, not by the export.
 * Export metadata is used only to reject an ID or directory mismatch. Only
 * nonempty user/assistant text parts are returned; tool, reasoning, synthetic,
 * ignored, and other part types never enter the result.
 */
export function parseOpenCodeSessionExport(
  stdout: string,
  listedSession: OpenCodeSessionListEntry,
  workspaceRoot: string,
): OpenCodeSessionReadResult<OpenCodeImportedSession> {
  if (utf8ByteLength(stdout) > MAX_EXPORT_BYTES) return failure("input-too-large");

  const expectedId = validSessionId(listedSession.sessionId);
  const listedDirectory = canonicalAbsoluteDirectory(listedSession.directory);
  const workspace = canonicalAbsoluteDirectory(workspaceRoot);
  if (expectedId === undefined) return failure("invalid-session");
  if (listedDirectory === undefined || workspace === undefined) {
    return failure("invalid-workspace");
  }
  if (!samePath(listedDirectory, workspace)) return failure("workspace-mismatch");

  const parsed = parseJson(stdout);
  if (!parsed.ok) return parsed;
  if (
    !isRecord(parsed.value) ||
    !isRecord(parsed.value.info) ||
    !Array.isArray(parsed.value.messages)
  ) {
    return failure("invalid-shape");
  }

  const exportInfo = parsed.value.info;
  if (validSessionId(exportInfo.id) !== expectedId) {
    return failure("export-session-mismatch");
  }
  // `--sanitize` redacts this path as well as transcript text. The caller
  // must request a plain export for a local, read-only import.
  if (typeof exportInfo.directory === "string" && exportInfo.directory.startsWith("[redacted:")) {
    return failure("sanitized-export");
  }
  if (typeof exportInfo.directory !== "string") return failure("invalid-shape");
  const exportedDirectory = canonicalAbsoluteDirectory(exportInfo.directory);
  if (exportedDirectory === undefined || !samePath(exportedDirectory, listedDirectory)) {
    return failure("export-workspace-mismatch");
  }
  if (parsed.value.messages.length > MAX_EXPORT_MESSAGES) return failure("too-many-messages");

  const messages: OpenCodeImportedMessage[] = [];
  let textBytes = 0;
  for (const rawMessage of parsed.value.messages) {
    if (!isRecord(rawMessage) || !isRecord(rawMessage.info)) continue;
    const role = rawMessage.info.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(rawMessage.parts)) continue;
    const createdAt = timestampToIso(
      isRecord(rawMessage.info.time) ? rawMessage.info.time.created : undefined,
    );
    if (createdAt === null) continue;

    const chunks: string[] = [];
    for (const part of rawMessage.parts) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
      if (part.synthetic === true || part.ignored === true) continue;
      if (SANITIZED_TEXT_PATTERN.test(part.text)) return failure("sanitized-export");
      if (part.text.trim().length === 0) continue;
      chunks.push(part.text);
    }
    if (chunks.length === 0) continue;

    const text = chunks.join("\n");
    textBytes += utf8ByteLength(text);
    if (textBytes > MAX_IMPORTED_TEXT_BYTES) return failure("too-much-text");
    messages.push({ role, text, createdAt });
  }

  const truncatedMessageCount = Math.max(0, messages.length - MAX_IMPORTED_MESSAGES);
  const boundedMessages = messages.slice(-MAX_IMPORTED_MESSAGES);
  return {
    ok: true,
    value: {
      sessionId: expectedId,
      title:
        typeof listedSession.title === "string"
          ? listedSession.title.slice(0, MAX_TITLE_LENGTH)
          : "Untitled OpenCode session",
      directory: listedDirectory,
      createdAt: listedSession.createdAt,
      updatedAt: listedSession.updatedAt,
      messages: boundedMessages,
      truncatedMessageCount,
    },
  };
}

function parseJson(input: string): OpenCodeSessionReadResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch {
    return failure("invalid-json");
  }
}

function validSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SESSION_ID_LENGTH) return undefined;
  return SESSION_ID_PATTERN.test(value) ? value : undefined;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const dateTime = DateTime.make(value);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : null;
}

function canonicalAbsoluteDirectory(value: string): string | undefined {
  if (value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) return undefined;
  if (isWindowsDirectoryPath(value)) return NodePath.win32.normalize(value);
  if (NodePath.posix.isAbsolute(value)) return NodePath.posix.resolve(value);
  return undefined;
}

function samePath(left: string, right: string): boolean {
  const windows = isWindowsDirectoryPath(left) || isWindowsDirectoryPath(right);
  const pathModule = windows ? NodePath.win32 : NodePath.posix;
  const normalizedLeft = trimTrailingSeparators(
    pathModule.normalize(left),
    pathModule.parse(left).root,
  );
  const normalizedRight = trimTrailingSeparators(
    pathModule.normalize(right),
    pathModule.parse(right).root,
  );
  return windows
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isWindowsDirectoryPath(value: string): boolean {
  // `path.win32.isAbsolute("/Users/name")` treats a POSIX absolute path as a
  // rooted Windows path, so require a drive or UNC prefix to select that path
  // flavor. This lets the pure parser validate paths from either host OS.
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || /^\/\/[^/]/.test(value);
}

function trimTrailingSeparators(value: string, root: string): string {
  if (value === root) return value;
  return value.replace(/[\\/]+$/, "");
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure<T = never>(
  error: OpenCodeSessionReadErrorCode,
  detail?: string,
): OpenCodeSessionReadResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}
