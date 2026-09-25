/**
 * Read-only discovery and parsing for Command Code's local session transcripts.
 *
 * Command Code documents one append-only JSONL transcript per session under
 * `~/.commandcode/projects/<project-slug>/`. Its public docs describe the
 * parent-linked entry tree; this reader accepts the observed v3 header and
 * message records. Its latest-appended path is only a history preview because
 * the documented format does not expose a stable persisted active-head field.
 */
import * as NodeOS from "node:os";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";

const SESSION_VERSION = 3;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TRANSCRIPTS = 500;
const MAX_PROJECT_DIRECTORIES = 2_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS_PER_TRANSCRIPT = 20_000;
const MAX_TOTAL_RECORDS = 100_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TOTAL_MESSAGE_CHARS = 64_000;

export interface CommandCodeSessionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface CommandCodeSession {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly model: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<CommandCodeSessionMessage>;
  readonly truncated: boolean;
  /** The active pointer is not present in a documented stable sidecar schema. */
  readonly branchStatus: "unverified" | "ambiguous";
  /** This reader can provide a transcript preview, never an exact active branch. */
  readonly historyOnly: true;
  /** Number of JSONL records inspected, including non-message tree entries. */
  readonly recordCount: number;
}

export interface ParseCommandCodeTranscriptOptions {
  /** If supplied, the header's cwd must identify this exact workspace path. */
  readonly expectedWorkspaceRoot?: string;
  /** Optional IDs let selected imports skip opening every other transcript. */
  readonly sessionIds?: ReadonlyArray<string>;
  /** Limits may be lowered by callers, never raised above the reader's caps. */
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly maxMessages?: number;
  readonly maxMessageChars?: number;
  readonly maxTotalMessageChars?: number;
  /** Discovery also checks the transcript filename against this header ID. */
  readonly expectedSessionId?: string;
}

export interface DiscoverCommandCodeSessionsOptions {
  /** Absolute HOME value selected by the provider instance; only standard subpaths are read. */
  readonly homePath?: string;
  /** Optional import filter; an empty list performs no transcript reads. */
  readonly sessionIds?: ReadonlyArray<string>;
  /** Restrict results to a workspace; invalid or relative paths match nothing. */
  readonly expectedWorkspaceRoot?: string;
  readonly maxTranscripts?: number;
  readonly maxTranscriptBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRecordsPerTranscript?: number;
  readonly maxTotalRecords?: number;
}

export interface CommandCodeSessionDiscoveryResult {
  readonly sessions: ReadonlyArray<
    CommandCodeSession & {
      readonly fileIdentity: CommandCodeSessionFileIdentity;
    }
  >;
  readonly truncated: boolean;
  readonly bytesRead: number;
  readonly recordsRead: number;
}

/** File identity captured from the same open descriptor used to read the transcript. */
export interface CommandCodeSessionFileIdentity {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number | null;
  readonly device: number;
  readonly inode: number | null;
  readonly birthtimeMs: number | null;
}

interface ParsedDate {
  readonly iso: string;
  readonly epochMs: number;
}

interface SessionHeader {
  readonly type: "session";
  readonly version: number;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
}

interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly visibleMessage?: CommandCodeSessionMessage;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function parseDate(value: unknown): ParsedDate | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) return undefined;
  return { epochMs, iso: DateTime.formatIso(DateTime.makeUnsafe(epochMs)) };
}

function isSafeSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function normalizedWorkspace(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return undefined;
  }
  const trimmed = value.trim();
  const canonicalSeparators = trimmed.replaceAll("\\", "/");
  if (!canonicalSeparators.startsWith("/") && !isWindowsAbsolutePath(trimmed)) return undefined;
  if (canonicalSeparators.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }
  return normalizeProjectPathForComparison(trimmed);
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value) => {
      const block = asRecord(value);
      return block?.type === "text" && typeof block.text === "string" ? [block.text.trim()] : [];
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function positiveLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function parseHeader(value: Record<string, unknown>): SessionHeader | undefined {
  if (
    value.type !== "session" ||
    value.version !== SESSION_VERSION ||
    !isSafeSessionId(value.id) ||
    typeof value.timestamp !== "string" ||
    typeof value.cwd !== "string"
  ) {
    return undefined;
  }
  return {
    type: "session",
    version: SESSION_VERSION,
    id: value.id,
    timestamp: value.timestamp,
    cwd: value.cwd,
  };
}

/**
 * Parse a bounded v3 transcript without filesystem access. Parent links select
 * the latest appended path as a history preview, preserving intervening
 * non-message nodes without exposing their contents. This is not a verified
 * active branch: the documented on-disk schema does not identify the pointer
 * moved by /tree navigation.
 */
export function parseCommandCodeTranscript(
  contents: string,
  options: ParseCommandCodeTranscriptOptions = {},
): CommandCodeSession | undefined {
  const maxBytes = positiveLimit(options.maxBytes, MAX_TRANSCRIPT_BYTES);
  if (Buffer.byteLength(contents, "utf8") > maxBytes) return undefined;

  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const maxRecords = positiveLimit(options.maxRecords, MAX_RECORDS_PER_TRANSCRIPT);
  if (lines.length < 2 || lines.length - 1 > maxRecords) return undefined;

  const headerValue = parseJsonLine(lines[0] ?? "");
  const header = headerValue && parseHeader(headerValue);
  if (!header) return undefined;
  if (options.expectedSessionId !== undefined && options.expectedSessionId !== header.id) {
    return undefined;
  }

  const workspaceRoot = normalizedWorkspace(header.cwd);
  const created = parseDate(header.timestamp);
  const expectedWorkspace =
    options.expectedWorkspaceRoot === undefined
      ? undefined
      : normalizedWorkspace(options.expectedWorkspaceRoot);
  if (
    workspaceRoot === undefined ||
    created === undefined ||
    (options.expectedWorkspaceRoot !== undefined &&
      (expectedWorkspace === undefined || expectedWorkspace !== workspaceRoot))
  ) {
    return undefined;
  }

  const nodes: TreeNode[] = [];
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const record = parseJsonLine(line);
    if (!record || typeof record.id !== "string" || record.id.length === 0) continue;
    if (record.parentId !== null && typeof record.parentId !== "string") continue;
    const timestamp = parseDate(record.timestamp);
    if (!timestamp) continue;
    if (ids.has(record.id)) return undefined;
    ids.add(record.id);

    let visibleMessage: CommandCodeSessionMessage | undefined;
    if (record.type === "message") {
      const message = asRecord(record.message);
      const role = message?.role;
      const text = visibleText(message?.content);
      if ((role === "user" || role === "assistant") && text.length > 0) {
        visibleMessage = {
          role,
          text,
          createdAt: timestamp.iso,
        };
      }
    }

    nodes.push({
      id: record.id,
      parentId: record.parentId as string | null,
      timestamp: timestamp.iso,
      ...(visibleMessage ? { visibleMessage } : {}),
    });
  }

  if (nodes.length === 0) return undefined;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderedBranch: TreeNode[] = [];
  const visited = new Set<string>();
  let current: TreeNode | undefined = nodes[nodes.length - 1];
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    orderedBranch.push(current);
    if (current.parentId === null) break;
    current = nodeById.get(current.parentId);
    if (!current) return undefined;
  }
  orderedBranch.reverse();

  const branchMessages = orderedBranch.flatMap((node) =>
    node.visibleMessage === undefined ? [] : [node.visibleMessage],
  );
  if (branchMessages.length === 0) return undefined;

  const parentIds = new Set(
    nodes.flatMap((node) => (node.parentId === null ? [] : [node.parentId])),
  );
  const leafCount = nodes.filter((node) => !parentIds.has(node.id)).length;
  const branchStatus = leafCount > 1 ? "ambiguous" : "unverified";

  const maxMessages = positiveLimit(options.maxMessages, MAX_MESSAGES);
  const maxMessageChars = positiveLimit(options.maxMessageChars, MAX_MESSAGE_CHARS);
  const maxTotalMessageChars = positiveLimit(options.maxTotalMessageChars, MAX_TOTAL_MESSAGE_CHARS);
  const firstUserIndex = branchMessages.findIndex((message) => message.role === "user");
  const selectedIndices = new Set<number>();
  if (firstUserIndex >= 0 && maxMessages > 0) selectedIndices.add(firstUserIndex);
  for (
    let index = branchMessages.length - 1;
    index >= 0 && selectedIndices.size < maxMessages;
    index--
  ) {
    selectedIndices.add(index);
  }

  let truncated = selectedIndices.size < branchMessages.length;
  let remainingChars = maxTotalMessageChars;
  const selectedMessages = Array.from(selectedIndices)
    .sort((left, right) => left - right)
    .map((index) => {
      const message = branchMessages[index];
      if (!message) return undefined;
      const allowedChars = Math.min(maxMessageChars, remainingChars);
      if (allowedChars <= 0) {
        truncated = true;
        return undefined;
      }
      const text =
        message.text.length > allowedChars
          ? `${message.text.slice(0, Math.max(0, allowedChars - 1)).trimEnd()}…`
          : message.text;
      if (text.length < message.text.length) truncated = true;
      remainingChars = Math.max(0, remainingChars - text.length);
      return { ...message, text };
    })
    .filter((message): message is CommandCodeSessionMessage => message !== undefined);

  const firstUserText = selectedMessages.find((message) => message.role === "user")?.text;
  const title = (firstUserText ?? "Command Code session").replace(/\s+/g, " ").slice(0, 120).trim();
  const updatedAt = orderedBranch.at(-1)?.timestamp ?? created.iso;
  return {
    sessionId: header.id,
    workspaceRoot,
    title: title || "Command Code session",
    model: null,
    createdAt: created.iso,
    updatedAt,
    messages: selectedMessages,
    truncated,
    branchStatus,
    historyOnly: true,
    recordCount: lines.length - 1,
  };
}

function resolveHomeDirectory(path: Path.Path): string {
  const home = process.env.HOME?.trim();
  return home && home !== "~" && path.isAbsolute(home)
    ? path.resolve(home)
    : path.resolve(NodeOS.homedir());
}

function fileSize(info: FileSystem.File.Info): number {
  return Number(ByteSize.toBigInt(info.size));
}

function fileIdentity(
  filePath: string,
  info: FileSystem.File.Info,
): CommandCodeSessionFileIdentity {
  return {
    filePath,
    size: fileSize(info),
    mtimeMs: Option.match(info.mtime, {
      onNone: () => null,
      onSome: (mtime) => mtime.getTime(),
    }),
    device: info.dev,
    inode: Option.getOrNull(info.ino),
    birthtimeMs: Option.match(info.birthtime, {
      onNone: () => null,
      onSome: (birthtime) => birthtime.getTime(),
    }),
  };
}

function sameFileIdentity(
  left: CommandCodeSessionFileIdentity,
  right: CommandCodeSessionFileIdentity,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

const readFileBounded = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  limit: number,
): Effect.fn.Return<
  { readonly contents: string; readonly identity: CommandCodeSessionFileIdentity } | undefined,
  never
> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(filePath, { flag: "r" });
      const before = yield* file.stat;
      if (before.type !== "File" || fileSize(before) > limit) return undefined;
      const beforeIdentity = fileIdentity(filePath, before);

      const buffer = new Uint8Array(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = yield* file.read(buffer.subarray(offset));
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > limit) return undefined;
      const after = yield* file.stat;
      const afterIdentity = fileIdentity(filePath, after);
      if (after.type !== "File" || !sameFileIdentity(beforeIdentity, afterIdentity))
        return undefined;
      const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.option);
      if (Option.isNone(realPath) || realPath.value !== filePath) return undefined;
      return {
        contents: new TextDecoder().decode(buffer.subarray(0, offset)),
        identity: beforeIdentity,
      };
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

interface TranscriptCandidate {
  readonly filePath: string;
  readonly filenameSessionId: string;
  readonly fileIdentity: CommandCodeSessionFileIdentity;
}

/**
 * Discover only `HOME/.commandcode/projects/<slug>/*.jsonl`. It reads no
 * settings, credentials, sidecars, project files, or alternate data roots.
 */
export const discoverCommandCodeSessions = Effect.fn("discoverCommandCodeSessions")(function* (
  options: DiscoverCommandCodeSessionsOptions = {},
): Effect.fn.Return<CommandCodeSessionDiscoveryResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const empty: CommandCodeSessionDiscoveryResult = {
    sessions: [],
    truncated: false,
    bytesRead: 0,
    recordsRead: 0,
  };
  const homeDirectory =
    options.homePath !== undefined
      ? path.isAbsolute(options.homePath)
        ? path.resolve(options.homePath)
        : ""
      : resolveHomeDirectory(path);
  if (homeDirectory.length === 0) return empty;
  const realHomeDirectory = yield* fileSystem.realPath(homeDirectory).pipe(Effect.option);
  if (Option.isNone(realHomeDirectory)) return empty;
  const projectsDirectory = path.join(homeDirectory, ".commandcode", "projects");
  const canonicalProjectsDirectory = path.join(realHomeDirectory.value, ".commandcode", "projects");
  const maxTranscripts = positiveLimit(options.maxTranscripts, MAX_TRANSCRIPTS);
  const maxTranscriptBytes = positiveLimit(options.maxTranscriptBytes, MAX_TRANSCRIPT_BYTES);
  const maxTotalBytes = positiveLimit(options.maxTotalBytes, MAX_TOTAL_TRANSCRIPT_BYTES);
  const maxRecordsPerTranscript = positiveLimit(
    options.maxRecordsPerTranscript,
    MAX_RECORDS_PER_TRANSCRIPT,
  );
  const maxTotalRecords = positiveLimit(options.maxTotalRecords, MAX_TOTAL_RECORDS);
  const selectedSessionIds =
    options.sessionIds === undefined ? undefined : new Set(options.sessionIds);
  if (selectedSessionIds?.size === 0) return empty;
  const expectedWorkspace =
    options.expectedWorkspaceRoot === undefined
      ? undefined
      : normalizedWorkspace(options.expectedWorkspaceRoot);
  if (options.expectedWorkspaceRoot !== undefined && expectedWorkspace === undefined) return empty;

  const rootRealPath = yield* fileSystem.realPath(projectsDirectory).pipe(Effect.option);
  if (Option.isNone(rootRealPath) || rootRealPath.value !== canonicalProjectsDirectory)
    return empty;
  const rootStat = yield* fileSystem.stat(projectsDirectory).pipe(Effect.option);
  if (Option.isNone(rootStat) || rootStat.value.type !== "Directory") return empty;
  const projectEntries = yield* fileSystem
    .readDirectory(projectsDirectory)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const candidates: TranscriptCandidate[] = [];
  let truncated = false;
  let directoryEntries = 0;
  let projectDirectories = 0;
  if (projectEntries.length > MAX_DIRECTORY_ENTRIES) truncated = true;
  for (const projectName of projectEntries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    directoryEntries += 1;
    const projectDirectory = path.join(projectsDirectory, projectName);
    const canonicalProjectDirectory = path.join(canonicalProjectsDirectory, projectName);
    const projectRealPath = yield* fileSystem.realPath(projectDirectory).pipe(Effect.option);
    if (Option.isNone(projectRealPath) || projectRealPath.value !== canonicalProjectDirectory)
      continue;
    const projectStat = yield* fileSystem.stat(projectDirectory).pipe(Effect.option);
    if (Option.isNone(projectStat) || projectStat.value.type !== "Directory") continue;
    if (++projectDirectories > MAX_PROJECT_DIRECTORIES) {
      truncated = true;
      break;
    }
    const transcriptEntries = yield* fileSystem
      .readDirectory(projectDirectory)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    if (transcriptEntries.length > MAX_DIRECTORY_ENTRIES - directoryEntries) truncated = true;
    for (const transcriptName of transcriptEntries.slice(
      0,
      MAX_DIRECTORY_ENTRIES - directoryEntries,
    )) {
      directoryEntries += 1;
      if (!transcriptName.endsWith(".jsonl")) continue;
      const filenameSessionId = transcriptName.slice(0, -".jsonl".length);
      if (!isSafeSessionId(filenameSessionId)) continue;
      if (selectedSessionIds !== undefined && !selectedSessionIds.has(filenameSessionId)) continue;

      const filePath = path.join(projectDirectory, transcriptName);
      const canonicalFilePath = path.join(canonicalProjectDirectory, transcriptName);
      const fileRealPath = yield* fileSystem.realPath(filePath).pipe(Effect.option);
      if (Option.isNone(fileRealPath) || fileRealPath.value !== canonicalFilePath) continue;
      const fileStat = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(fileStat) || fileStat.value.type !== "File") continue;
      candidates.push({
        filePath: canonicalFilePath,
        filenameSessionId,
        fileIdentity: fileIdentity(canonicalFilePath, fileStat.value),
      });
    }
    if (directoryEntries >= MAX_DIRECTORY_ENTRIES) break;
  }

  candidates.sort(
    (left, right) =>
      (right.fileIdentity.mtimeMs ?? 0) - (left.fileIdentity.mtimeMs ?? 0) ||
      left.filePath.localeCompare(right.filePath),
  );
  if (candidates.length > maxTranscripts) truncated = true;

  const sessions: Array<
    CommandCodeSession & {
      fileIdentity: CommandCodeSessionFileIdentity;
    }
  > = [];
  let bytesRead = 0;
  let recordsRead = 0;
  for (const candidate of candidates.slice(0, maxTranscripts)) {
    if (bytesRead >= maxTotalBytes || recordsRead >= maxTotalRecords) {
      truncated = true;
      break;
    }
    const availableBytes = Math.min(maxTranscriptBytes, maxTotalBytes - bytesRead);
    if (candidate.fileIdentity.size > availableBytes) {
      truncated = true;
      continue;
    }
    const readResult = yield* readFileBounded(fileSystem, candidate.filePath, availableBytes);
    if (!readResult) {
      truncated = true;
      continue;
    }
    const { contents, identity } = readResult;
    if (!sameFileIdentity(candidate.fileIdentity, identity)) {
      truncated = true;
      continue;
    }
    bytesRead += identity.size;
    const session = parseCommandCodeTranscript(contents, {
      expectedSessionId: candidate.filenameSessionId,
      maxBytes: availableBytes,
      maxRecords: Math.min(maxRecordsPerTranscript, maxTotalRecords - recordsRead),
    });
    if (!session) {
      truncated = true;
      continue;
    }
    recordsRead += session.recordCount;
    if (expectedWorkspace !== undefined && session.workspaceRoot !== expectedWorkspace) continue;
    sessions.push({
      ...session,
      fileIdentity: identity,
    });
  }

  return { sessions, truncated, bytesRead, recordsRead };
});
