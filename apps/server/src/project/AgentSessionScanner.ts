/**
 * AgentSessionScanner - discovery of projects a user already works on.
 *
 * Claude Code and Codex both keep a per-session transcript on disk, and each
 * transcript records the directory the session ran in. Reading those `cwd`
 * values gives us the set of directories worth offering as projects during
 * onboarding, without asking the user to browse the filesystem.
 *
 * The scan is read-only and best-effort: an unreadable home, a malformed
 * transcript, or a directory that has since been deleted is skipped rather
 * than failing the scan. Project creation stays with the client, which
 * dispatches `project.create` for whichever candidates the user picks.
 *
 * @module project/AgentSessionScanner
 */
import * as NodeOS from "node:os";

import {
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ClineSettings,
  CommandCodeSettings,
  type AgentSessionSelection,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseOriginUrlFromGitConfig,
} from "@t3tools/shared/git";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClineSessionReader from "./ClineSessionReader.ts";
import * as CommandCodeSessionReader from "./CommandCodeSessionReader.ts";
import * as OpenCodeSessionCli from "./OpenCodeSessionCli.ts";
import type { OpenCodeSessionListEntry } from "./OpenCodeSessionReader.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";

/** Chunk size for full transcript reads. */
const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;
/** Small reads avoid wasting the metadata budget on long Codex instruction headers. */
const METADATA_READ_BYTES = 8 * 1024;
/** Prevent malformed transcripts from turning project discovery into a full file scan. */
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;

/**
 * Upper bound on transcripts inspected (first line read) per source.
 * Newest-first ordering means the cap drops only stale sessions when a home
 * directory is unusually large.
 */
const MAX_TRANSCRIPTS_PER_SOURCE = 5000;

/**
 * Upper bound on discovery filesystem operations per source. Newest-first
 * ordering needs mtimes before the read cap can be applied, so directory reads
 * and candidate stats share a larger budget. Once it runs out the scan stops.
 */
const MAX_DISCOVERY_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_BYTES_PER_SOURCE = 64 * 1024 * 1024;
const MAX_METADATA_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_RECORDS_PER_SOURCE = 100_000;
const MAX_METADATA_RECORDS_PER_TRANSCRIPT = 1_000;
const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Large tool results (especially screenshots) can make an otherwise ordinary
 * Codex transcript several GiB. Streaming field selection avoids allocating
 * those payloads. Raw I/O and selected history have separate budgets.
 */
const MAX_IMPORTED_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;
const MAX_IMPORT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORT_TRANSCRIPTS = 100;
const MAX_IMPORT_RECORDS = 100_000;
/** Keep local-provider history fanout bounded when several accounts are configured. */
const MAX_LOCAL_PROVIDER_HOMES = 8;
const MAX_LOCAL_PROVIDER_SESSIONS = 500;
const MAX_COMMAND_CODE_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_CODE_HISTORY_RECORDS = 100_000;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClineSettings = Schema.decodeUnknownOption(ClineSettings);
const decodeCommandCodeSettings = Schema.decodeUnknownOption(CommandCodeSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);

type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

interface AgentSessionTranscriptMetadata {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

export interface AgentSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
  /** False when the source can be imported as history but cannot be resumed natively. */
  readonly resumable?: boolean;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
    }
  | { readonly _tag: "AlreadyImported"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Duplicate"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Skipped" };

export type AgentSessionRecentThreadMode =
  | { readonly mode: "preview" }
  | { readonly mode: "import"; readonly selectedSessions?: ReadonlyArray<AgentSessionSelection> };

/** Service tag for agent session discovery. */
export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    /**
     * Discover every directory the configured Claude and Codex homes have run
     * a session in. Candidates are returned newest-first; the client decides
     * which ones to import and how far back to look. Fails with the contract
     * error directly — there is no server-local context worth wrapping.
     */
    readonly scan: Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
    readonly recentThreads: (
      workspaceRoot: string,
      completedSources?: ReadonlyArray<AgentSessionImportSource>,
      mode?: AgentSessionRecentThreadMode,
    ) => Stream.Stream<AgentSessionRecentThread, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

/** A single directory's worth of evidence from one source. */
interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
    /** Read from bounded discovery metadata, before any full transcript import. */
    readonly providerSessionId?: string | null;
  }>;
}

interface LocalThreadCandidate {
  readonly thread: AgentSessionThread;
  readonly source: AgentSessionImportSource;
  readonly workspaceRoot: string;
  readonly lastActiveAtMs: number | null;
}

interface OpenCodeSessionCandidate {
  readonly listedSession: OpenCodeSessionListEntry;
  readonly providerInstanceId: ProviderInstanceId;
  readonly source: AgentSessionImportSource;
  readonly lastActiveAtMs: number | null;
}

interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly size: number;
}

interface MetadataReadBudget {
  bytesRemaining: number;
  operationsRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

function selectMetadataTranscripts(transcripts: ReadonlyArray<TranscriptCandidate>) {
  const selected: Array<TranscriptCandidate> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0 && selected.length < MAX_TRANSCRIPTS_PER_SOURCE) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      if (selected.length === MAX_TRANSCRIPTS_PER_SOURCE) break;
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(
      (block) =>
        block.type === "text" || block.type === "input_text" || block.type === "output_text",
    )
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

/** Keep visible user and assistant text while ignoring tools, reasoning, and malformed records. */
export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  return parseAgentSessionRecords(input, records);
}

function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata,
  records: ReadonlyArray<DecodedTranscriptRecord>,
): AgentSessionThread | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId = input.source === "codex" ? "" : input.fallbackSessionId;
  let title: string | null = null;
  let model: string | null = null;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  // A Codex response item can include generated setup text beside the real
  // prompt. Suppress response-user records only when the shared turn ID and a
  // verbatim event copy prove which prompt the user submitted.
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    messages.push(message);
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of records) {
    recordIndex += 1;
    if (input.source === "claudeAgent") {
      if (
        record.isSidechain === true ||
        record.isMeta === true ||
        record.isCompactSummary === true
      ) {
        continue;
      }
      if (record.sessionId?.trim()) providerSessionId = record.sessionId.trim();
      if (record.aiTitle?.trim()) title = record.aiTitle.trim();
      const messageModel = record.message?.model?.trim();
      // Claude uses this sentinel for local error responses. It is not a
      // model ID that can be selected when the imported session resumes.
      if (messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (record.type !== "user" && record.type !== "assistant") {
        continue;
      }

      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can write the same prompt as both a response item and an event.
      // Remove only the matching response copy so mixed-format logs keep every
      // distinct user message.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (providerSessionId.trim().length === 0 || firstUserMessage === undefined) return null;
  const firstUserMessageRetained = messages.includes(firstUserMessage);
  const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
  const retainedMessages = firstUserMessageRetained
    ? visibleMessages
    : [visibleFirstUserMessage, ...visibleMessages.slice(-(MAX_IMPORTED_MESSAGES - 1))];
  const derivedTitle = visibleFirstUserMessage.text.trim().split("\n")[0]?.slice(0, 100).trim();

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: title ?? (derivedTitle && derivedTitle.length > 0 ? derivedTitle : "Imported thread"),
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
  };
}

function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  if (extractDecodedCwd(record) !== null) return true;
  if (source === "claudeAgent") {
    return (
      record.type === "user" ||
      record.type === "assistant" ||
      record.sessionId !== undefined ||
      record.aiTitle !== undefined ||
      record.message?.model !== undefined
    );
  }
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

/**
 * T3 Code runs its own agent sessions inside disposable worktrees. Their
 * transcripts look exactly like user sessions, but re-importing the app's own
 * sandboxes as projects is never right. Matches this server's configured
 * worktrees directory plus the conventional `.t3/worktrees` layout, which
 * also catches sandboxes from other T3 homes on the same machine. Separators
 * are normalized (and, on Windows, case folded) so the prefix match holds
 * there too. Callers check both the recorded spelling and its realpath so a
 * symlink into the worktrees directory cannot bypass the filter.
 */
function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

function isT3ManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.t3/worktrees/")
  );
}

/** Extract the workspace and native session ID when present in one metadata record. */
function extractTranscriptMetadata(
  line: string,
  source?: AgentSessionSource,
): { readonly cwd: string | null; readonly providerSessionId: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { cwd: null, providerSessionId: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { cwd: null, providerSessionId: null };
  }

  const record = parsed as Record<string, unknown>;
  let cwd: string | null = null;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    cwd = record.cwd;
  }
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    const nestedPayload = payload as Record<string, unknown>;
    if (
      cwd === null &&
      typeof nestedPayload.cwd === "string" &&
      nestedPayload.cwd.trim().length > 0
    ) {
      cwd = nestedPayload.cwd;
    }
  }

  let providerSessionId: string | null = null;
  if (source === "claudeAgent" && typeof record.sessionId === "string") {
    providerSessionId = record.sessionId.trim() || null;
  } else if (
    source === "codex" &&
    record.type === "session_meta" &&
    typeof payload === "object" &&
    payload !== null
  ) {
    const nestedPayload = payload as Record<string, unknown>;
    const sessionId =
      typeof nestedPayload.id === "string"
        ? nestedPayload.id
        : typeof nestedPayload.session_id === "string"
          ? nestedPayload.session_id
          : "";
    providerSessionId = sessionId.trim() || null;
  }
  return { cwd, providerSessionId };
}

function transcriptIdentity(filePath: string, stats: FileSystem.File.Info) {
  return {
    filePath,
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: stats.dev,
    inode: Option.getOrNull(stats.ino),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

function sameTranscriptIdentity(
  left: ReturnType<typeof transcriptIdentity>,
  right: ReturnType<typeof transcriptIdentity>,
): boolean {
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function agentSessionSelectionKey(selection: AgentSessionSelection): string {
  return `${selection.provider}\0${selection.providerInstanceId}\0${selection.providerSessionId}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Different project imports can arrive concurrently from multiple clients.
  // Only one transcript may hold its selected-history budget at a time.
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const baseDir = path.resolve(serverConfig.baseDir);
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  // `realPath` may resolve a system alias such as macOS `/var` to
  // `/private/var`. Compare real candidate paths against a real configured
  // worktrees root so symlinks into that directory remain excluded.
  const realWorktreesDir = yield* fileSystem
    .realPath(worktreesDir)
    .pipe(Effect.orElseSucceed(() => worktreesDir));
  // Windows filesystems are case-insensitive, so path prefix checks there
  // must case fold.
  const foldWorktreeCase = (yield* HostProcessPlatform) === "win32";
  const hostEnvironment = yield* HostProcessEnvironment;
  const homeDir = NodeOS.homedir();
  // `/private/tmp` is what macOS reports for sessions started in `/tmp`.
  const excludedProjectRoots = new Set(
    [homeDir, NodeOS.tmpdir(), "/tmp", "/private/tmp"].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );
  // Codex creates one scratch directory per conversation under
  // ~/Documents/Codex/<date>/<slug>. Neither those nor anything a user
  // unpacked into Downloads is a project.
  const excludedProjectAncestors = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents", "Codex"),
  ];

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    excludedProjectAncestors.some((ancestor) =>
      normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
        normalizeForWorktreeMatch(ancestor, foldWorktreeCase),
      ),
    ) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isT3ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase) ||
    isT3ManagedWorktree(candidatePath, realWorktreesDir, foldWorktreeCase);

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  /** Match directory aliases without assuming the host volume is case-insensitive. */
  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (
      Option.isSome(stats) &&
      Option.isSome(stats.value.ino) &&
      Number.isSafeInteger(stats.value.ino.value) &&
      stats.value.ino.value > 0
    ) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  /**
   * Git identity of a directory, or the reason it has none. Reads `.git`
   * directly instead of spawning git so a scan over hundreds of candidates
   * stays cheap. A `.git` file is a `gitdir:` pointer. When it points into a
   * `worktrees/` directory the checkout is a linked worktree, which
   * onboarding skips because its history belongs to the main checkout.
   * Submodules use the same pointer shape but live under `modules/`, and
   * are offered like any other repository.
   */
  const readGitIdentity = Effect.fn("AgentSessionScanner.readGitIdentity")(function* (
    directory: string,
  ): Effect.fn.Return<
    | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
    | { readonly _tag: "Worktree" }
    | { readonly _tag: "NotGit" }
  > {
    const gitPath = path.join(directory, ".git");
    const gitStats = yield* statOption(gitPath);
    if (Option.isNone(gitStats)) return { _tag: "NotGit" } as const;
    let gitDir = gitPath;
    if (gitStats.value.type !== "Directory") {
      const pointer = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (target === undefined || target.length === 0) return { _tag: "NotGit" } as const;
      gitDir = path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) return { _tag: "Worktree" } as const;
    }
    const configText = yield* fileSystem
      .readFileString(path.join(gitDir, "config"))
      .pipe(Effect.orElseSucceed(() => ""));
    const originUrl = parseOriginUrlFromGitConfig(configText);
    return {
      _tag: "Repository",
      git: {
        remoteKey: originUrl === null ? null : normalizeGitRemoteUrl(originUrl),
        repository: parseGitHubRepositoryNameWithOwnerFromRemoteUrl(originUrl),
      },
    } as const;
  });

  // A large history snapshot can precede session metadata. Read bounded
  // chunks until a complete record names its cwd or the safety budget ends.
  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    if (transcript.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            // Claude transcript filenames are their stable session IDs. Codex
            // rollout filenames are not, so its ID must come from session_meta.
            const fallbackProviderSessionId =
              source === "claudeAgent" ? path.basename(transcript.filePath, ".jsonl") : null;
            let providerSessionId: string | null = null;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              if (record.length === 0 || !reserveRecord()) return null;
              const metadata = extractTranscriptMetadata(record.trim(), source);
              providerSessionId ??= metadata.providerSessionId;
              return metadata.cwd === null
                ? null
                : {
                    cwd: metadata.cwd,
                    providerSessionId: providerSessionId ?? fallbackProviderSessionId,
                  };
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const metadata = extractTranscriptMetadata(line.trim(), source);
                providerSessionId ??= metadata.providerSessionId;
                if (metadata.cwd !== null) {
                  return {
                    cwd: metadata.cwd,
                    providerSessionId: providerSessionId ?? fallbackProviderSessionId,
                  };
                }
              }
            }

            if (bytesRead < transcript.size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  /**
   * Project history fields while reading, before allocating whole JSON records.
   * Check the file identity on both sides of the read. A selected-history budget
   * failure rejects the entire transcript before any imported messages persist.
   */
  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    recordLimit: number,
    source: AgentSessionSource,
  ) {
    if (expected.size > MAX_IMPORTED_TRANSCRIPT_BYTES) return null;

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))) {
              return null;
            }
            const records: Array<DecodedTranscriptRecord> = [];
            let historyBytes = 0;
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (historyBytes + recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError(
                  "Transcript selected history exceeds the 32 MiB memory budget",
                );
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;

            const finishRecord = () => {
              reader.write(decoder.decode());
              recordCount += 1;
              if (recordCount > recordLimit) return false;
              const decoded = decodeTranscriptValue(reader.finish());
              if (Option.isSome(decoded) && shouldRetainDecodedRecord(source, decoded.value)) {
                records.push(decoded.value);
                historyBytes += recordBytes;
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < expected.size) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expected.size - bytesRead),
              );
              if (Option.isNone(next)) {
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try(() => {
                let start = 0;
                while (start < next.value.byteLength) {
                  const newline = next.value.indexOf(10, start);
                  const end = newline === -1 ? next.value.byteLength : newline;
                  recordStarted = true;
                  reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                  if (newline === -1) break;
                  if (!finishRecord()) return false;
                  start = newline + 1;
                }
                return true;
              });
              if (!withinBudget) return null;
            }

            if (recordStarted && !(yield* Effect.try(finishRecord))) return null;
            return sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? { records, recordCount }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  /**
   * Resolve the Claude config directory the CLI would use, matching the
   * precedence the spawned CLI sees: the instance's `homePath` (exported as
   * `CLAUDE_CONFIG_DIR`), then a `CLAUDE_CONFIG_DIR` already in the
   * environment, then `~/.claude`.
   */
  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment));
    }
    return path.join(NodeOS.homedir(), ".claude");
  };

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      const projectDirectories = yield* readDirectory(projectsDir);
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            size: Number(stats.value.size),
          });
        }
      }
      return { transcripts, truncated };
    },
  );

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      // Date-partitioned directories sort chronologically, so walking them in
      // reverse spends each home's share of the operation budget on recent sessions.
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  size: Number(stats.value.size),
                });
              }
            }
          }
        }
      }
      return { transcripts, truncated };
    },
  );

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        lastActiveAtMs: number;
        transcripts: Array<{
          filePath: string;
          mtimeMs: number;
          providerSessionId: string | null;
        }>;
      }
    >();

    for (const transcript of transcripts) {
      const metadata = yield* readCwd(source, transcript, budget);
      if (metadata === null) continue;
      const key = `${transcript.providerInstanceId}\0${metadata.cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push({
          filePath: transcript.filePath,
          mtimeMs: transcript.mtimeMs,
          providerSessionId: metadata.providerSessionId,
        });
      } else {
        byOwnerAndCwd.set(key, {
          cwd: metadata.cwd,
          providerInstanceId: transcript.providerInstanceId,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [
            {
              filePath: transcript.filePath,
              mtimeMs: transcript.mtimeMs,
              providerSessionId: metadata.providerSessionId,
            },
          ],
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => ({
      cwd: group.cwd,
      source,
      providerInstanceId: group.providerInstanceId,
      threadCount: group.transcripts.length,
      lastActiveAtMs: group.lastActiveAtMs,
      transcripts: group.transcripts,
    }));
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw: Array<RawCandidate> = [];
    const localThreads: Array<LocalThreadCandidate> = [];
    const openCodeSessions: Array<OpenCodeSessionCandidate> = [];
    const localSessionCounts: Record<"cline" | "commandCode", number> = {
      cline: 0,
      commandCode: 0,
    };
    let truncated = false;

    const providerInstancesFor = (source: "cline" | "commandCode") => {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(
          ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
        )
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      // Preserve legacy built-in auto-discovery unless its ID is explicitly
      // configured (including an explicit disabled entry).
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const legacyInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: {
            driver: ProviderDriverKind.make(source),
            config: settings.providers[source],
          },
        };
        if (resolveProviderInstanceEnabled(legacyInstance.config)) instances.push(legacyInstance);
      }
      instances.sort(
        (left, right) => Number(left.instanceId !== source) - Number(right.instanceId !== source),
      );
      return instances;
    };

    const absoluteConfiguredPath = (value: string | undefined): string | undefined => {
      if (value === undefined || value.trim().length === 0) return undefined;
      const expanded = expandHomePath(value.trim());
      return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
    };

    const appendLocalSessions = (
      source: "cline" | "commandCode",
      providerInstanceId: ProviderInstanceId,
      sessions: ReadonlyArray<{
        readonly providerSessionId: string;
        readonly title: string;
        readonly model: string | null;
        readonly workspaceRoot: string;
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
        readonly fileIdentity:
          | ClineSessionReader.ClineSessionFileIdentity
          | CommandCodeSessionReader.CommandCodeSessionFileIdentity;
      }>,
    ) => {
      for (const session of sessions) {
        if (localSessionCounts[source] >= MAX_LOCAL_PROVIDER_SESSIONS) {
          truncated = true;
          break;
        }
        localSessionCounts[source] += 1;
        const thread: AgentSessionThread = {
          source,
          providerInstanceId,
          providerSessionId: session.providerSessionId,
          title: session.title,
          model: session.model,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.messages,
          // Both imports are read-only previews; neither exposes a stable
          // headless resume operation to T3.
          resumable: false,
        };
        const importSource: AgentSessionImportSource = {
          ...session.fileIdentity,
          provider: source,
          providerInstanceId,
          providerSessionId: session.providerSessionId,
        };
        const lastActiveAtMs = session.fileIdentity.mtimeMs ?? Date.parse(session.updatedAt);
        localThreads.push({
          thread,
          source: importSource,
          workspaceRoot: session.workspaceRoot,
          lastActiveAtMs: Number.isFinite(lastActiveAtMs) ? lastActiveAtMs : null,
        });
        raw.push({
          cwd: session.workspaceRoot,
          source,
          providerInstanceId,
          threadCount: 1,
          lastActiveAtMs: Number.isFinite(lastActiveAtMs) ? lastActiveAtMs : null,
          transcripts: [
            { filePath: session.fileIdentity.filePath, mtimeMs: session.fileIdentity.mtimeMs },
          ],
        });
      }
    };

    // Cline and Command Code are read-only transcript sources. Their history
    // readers use standard per-user homes by default, while provider instance
    // environment overrides keep separately configured accounts discoverable.
    for (const source of ["cline", "commandCode"] as const) {
      const allInstances = providerInstancesFor(source);
      const homes: Array<{
        readonly homePath: string;
        readonly providerInstanceId: ProviderInstanceId;
        readonly environment: NodeJS.ProcessEnv;
      }> = [];
      const seenRoots = new Set<string>();
      for (const { instanceId, config: instance } of allInstances) {
        const decodedSettings =
          source === "cline"
            ? decodeClineSettings(instance.config ?? {})
            : decodeCommandCodeSettings(instance.config ?? {});
        if (Option.isNone(decodedSettings)) continue;

        const configuredValue = (name: string): string | undefined => {
          const override = instance.environment?.findLast((variable) => variable.name === name);
          return override?.value ?? hostEnvironment[name];
        };
        const homePath =
          absoluteConfiguredPath(configuredValue("HOME")) ??
          absoluteConfiguredPath(configuredValue("USERPROFILE")) ??
          absoluteConfiguredPath(NodeOS.homedir());
        if (homePath === undefined) continue;

        const environment: NodeJS.ProcessEnv = { HOME: homePath };
        if (source === "cline") {
          for (const name of [
            "USERPROFILE",
            "CLINE_DATA_DIR",
            "CLINE_DIR",
            "CLINE_SESSION_DATA_DIR",
          ]) {
            const value = absoluteConfiguredPath(configuredValue(name));
            if (value !== undefined) environment[name] = value;
          }
        }
        const sessionsRoot =
          source === "cline"
            ? ClineSessionReader.resolveClineSessionsDir(
                environment,
                ClineSessionReader.resolveClineDataDir(environment, homePath),
              )
            : path.join(homePath, ".commandcode", "projects");
        const dataRootIdentity = yield* directoryIdentity(sessionsRoot);
        const rootKey = `${source}\0${dataRootIdentity}`;
        if (seenRoots.has(rootKey)) continue;
        seenRoots.add(rootKey);
        homes.push({ homePath, providerInstanceId: instanceId, environment });
      }

      if (homes.length > MAX_LOCAL_PROVIDER_HOMES) {
        truncated = true;
        homes.length = MAX_LOCAL_PROVIDER_HOMES;
      }
      const totalHomes = homes.length;
      const sessionLimitPerHome = Math.max(
        1,
        Math.floor(MAX_LOCAL_PROVIDER_SESSIONS / Math.max(1, totalHomes)),
      );
      for (const home of homes) {
        if (source === "cline") {
          const sessions = yield* ClineSessionReader.readClineSessionHistory({
            env: home.environment,
            homeDir: home.homePath,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.orElseSucceed(() => []),
          );
          if (sessions.length > sessionLimitPerHome) truncated = true;
          appendLocalSessions(
            source,
            home.providerInstanceId,
            sessions.slice(0, sessionLimitPerHome),
          );
          continue;
        }

        const sessions = yield* CommandCodeSessionReader.discoverCommandCodeSessions({
          homePath: home.homePath,
          maxTranscripts: sessionLimitPerHome,
          maxTranscriptBytes: 8 * 1024 * 1024,
          maxTotalBytes: Math.floor(MAX_COMMAND_CODE_HISTORY_BYTES / Math.max(1, totalHomes)),
          maxTotalRecords: Math.floor(MAX_COMMAND_CODE_HISTORY_RECORDS / Math.max(1, totalHomes)),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        truncated ||= sessions.truncated;
        appendLocalSessions(
          source,
          home.providerInstanceId,
          sessions.sessions.map((session) => ({
            providerSessionId: session.sessionId,
            title: session.title,
            model: session.model,
            workspaceRoot: session.workspaceRoot,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messages: session.messages,
            fileIdentity: session.fileIdentity,
          })),
        );
      }
    }

    // OpenCode exposes session metadata through its ordinary CLI. Listing is
    // metadata-only; the transcript is exported later only for selected IDs.
    const openCodeListing = yield* OpenCodeSessionCli.listOpenCodeSessions({
      runner: processRunner,
      environment: hostEnvironment,
      cwd: homeDir,
    });
    if (!openCodeListing.ok) {
      if (openCodeListing.error !== "command-unavailable") truncated = true;
    } else {
      if (openCodeListing.value.skippedCount > 0 || openCodeListing.value.truncated) {
        truncated = true;
      }
      const providerInstanceId = ProviderInstanceId.make("opencode");
      for (const listedSession of openCodeListing.value.sessions) {
        const parsedUpdatedAt =
          listedSession.updatedAt === null ? null : Date.parse(listedSession.updatedAt);
        const lastActiveAtMs =
          parsedUpdatedAt !== null && Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null;
        const source: AgentSessionImportSource = {
          provider: "opencode",
          providerInstanceId,
          providerSessionId: listedSession.sessionId,
          // OpenCode owns this history in its local store, not a public file
          // path. A stable provider URI keeps the import cursor deterministic.
          filePath: `opencode-session:${listedSession.sessionId}`,
          size: 0,
          mtimeMs: lastActiveAtMs,
          device: 0,
          inode: null,
          birthtimeMs: null,
        };
        openCodeSessions.push({ listedSession, providerInstanceId, source, lastActiveAtMs });
        raw.push({
          cwd: listedSession.directory,
          source: "opencode",
          providerInstanceId,
          threadCount: 1,
          lastActiveAtMs,
          transcripts: [],
        });
      }
    }

    for (const source of ["claudeAgent", "codex"] as const) {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(
          ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
        )
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const legacyInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: {
            driver: ProviderDriverKind.make(source),
            config: settings.providers[source],
          },
        };
        if (resolveProviderInstanceEnabled(legacyInstance.config)) {
          instances.push(legacyInstance);
        }
      }

      // A shared home contains one copy of each session. Prefer the built-in
      // instance as its owner, then keep configured order for custom accounts.
      instances.sort((left, right) => {
        const leftDefault = left.instanceId === source ? 0 : 1;
        const rightDefault = right.instanceId === source ? 0 : 1;
        return leftDefault - rightDefault;
      });
      const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
      const seenHomes = new Set<string>();
      for (const { instanceId, config: instance } of instances) {
        const homeVariable = source === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
        const environmentHome =
          instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
          hostEnvironment[homeVariable];

        let homePath: string;
        if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(config.value.homePath, environmentHome);
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            environmentHome?.trim()
              ? { ...config.value, homePath: environmentHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
        if (seenHomes.has(homeKey)) continue;
        seenHomes.add(homeKey);
        homes.push({ homePath, providerInstanceId: instanceId });
      }

      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const baseOperationBudget = Math.floor(
        MAX_DISCOVERY_OPERATIONS_PER_SOURCE / Math.max(1, homes.length),
      );
      const extraOperationBudgets = MAX_DISCOVERY_OPERATIONS_PER_SOURCE % Math.max(1, homes.length);
      for (const [index, home] of homes.entries()) {
        const operationBudget = baseOperationBudget + (index < extraOperationBudgets ? 1 : 0);
        if (operationBudget === 0) {
          truncated = true;
          continue;
        }
        const discovered = yield* source === "claudeAgent"
          ? discoverClaudeTranscripts(home.homePath, home.providerInstanceId, operationBudget)
          : discoverCodexTranscripts(home.homePath, home.providerInstanceId, operationBudget);
        truncated ||= discovered.truncated;
        transcriptCandidates.push(...discovered.transcripts);
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      if (transcriptCandidates.length > MAX_TRANSCRIPTS_PER_SOURCE) {
        truncated = true;
      }
      // Give each account a turn before taking another file from the same home.
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
        operationsRemaining: MAX_METADATA_OPERATIONS_PER_SOURCE,
        recordsRemaining: MAX_METADATA_RECORDS_PER_SOURCE,
        truncated: false,
      };
      raw.push(...(yield* groupTranscriptsByCwd(source, selectedTranscripts, metadataBudget)));
      truncated ||= metadataBudget.truncated;
    }

    return { candidates: raw, localThreads, openCodeSessions, truncated };
  });

  let cachedCandidates: ReadonlyArray<RawCandidate> | null = null;
  let cachedLocalThreads: ReadonlyArray<LocalThreadCandidate> | null = null;
  let cachedOpenCodeSessions: ReadonlyArray<OpenCodeSessionCandidate> | null = null;

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const {
      candidates: raw,
      localThreads,
      openCodeSessions,
      truncated,
    } = yield* collectCandidates();
    cachedCandidates = raw;
    cachedLocalThreads = localThreads;
    cachedOpenCodeSessions = openCodeSessions;

    // Filesystem identity merges symlinks and case aliases without collapsing
    // distinct case-sensitive directories.
    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
      }
    >();
    const directoryKeys = new Map<string, string>();
    const gitIdentities = new Map<string, AgentSessionProjectGit | null>();

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (isExcludedProjectPath(resolved)) continue;
      let key = directoryKeys.get(resolved);
      if (key === undefined) {
        const stats = yield* statOption(resolved);
        // Directories that no longer exist can't be imported.
        if (Option.isNone(stats) || stats.value.type !== "Directory") {
          directoryKeys.set(resolved, "");
          continue;
        }
        const realPath = yield* fileSystem
          .realPath(resolved)
          .pipe(Effect.orElseSucceed(() => resolved));
        // A symlink can point into the worktrees directory even when its own
        // spelling doesn't; check again with links resolved.
        if (isExcludedProjectPath(realPath)) {
          key = "";
        } else {
          const gitIdentity = yield* readGitIdentity(resolved);
          if (gitIdentity._tag === "Worktree") {
            key = "";
          } else {
            key = yield* directoryIdentity(resolved, stats.value);
            gitIdentities.set(key, gitIdentity._tag === "Repository" ? gitIdentity.git : null);
          }
        }
        directoryKeys.set(resolved, key);
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: resolved,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: gitIdentities.get(key) ?? null,
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too. A project and a transcript can name
    // different symlinks to the same directory.
    const shellSnapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof shellSnapshot.projects)[number]>();
    for (const project of shellSnapshot.projects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      // Keep the path key for missing roots and use filesystem identity for
      // aliases that resolve to the same directory.
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      candidates.push({
        path: candidatePath,
        title: path.basename(candidatePath) || candidatePath,
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    // Newest first, undated candidates last.
    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
    mode: AgentSessionRecentThreadMode = { mode: "preview" },
  ) {
    const root = path.resolve(expandHomePath(workspaceRoot));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) return Stream.empty;
    const rootIdentity = yield* directoryIdentity(root);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

    let candidates = cachedCandidates;
    let localThreads = cachedLocalThreads;
    let openCodeSessions = cachedOpenCodeSessions;
    if (candidates === null || localThreads === null || openCodeSessions === null) {
      const collected = yield* collectCandidates();
      candidates ??= collected.candidates;
      localThreads ??= collected.localThreads;
      openCodeSessions ??= collected.openCodeSessions;
      cachedCandidates = candidates;
      cachedLocalThreads = localThreads;
      cachedOpenCodeSessions = openCodeSessions;
    }
    const selectedKeys =
      mode.mode === "import" && mode.selectedSessions !== undefined
        ? new Set(mode.selectedSessions.map(agentSessionSelectionKey))
        : null;
    const isSelected = (
      provider: AgentSessionSource,
      providerInstanceId: ProviderInstanceId,
      providerSessionId: string,
    ) =>
      selectedKeys === null ||
      selectedKeys.has(`${provider}\0${providerInstanceId}\0${providerSessionId}`);

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of candidates) {
      if (candidate.source === "cline" || candidate.source === "commandCode") continue;
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

      for (const transcript of candidate.transcripts) {
        if (
          transcript.mtimeMs === null ||
          transcript.mtimeMs < cutoffMs ||
          transcript.mtimeMs > nowMs
        ) {
          continue;
        }
        // In explicit import mode, metadata is the gate to expensive history
        // reads. Unknown IDs are skipped rather than opening an unselected
        // transcript and filtering only after parsing it.
        if (
          mode.mode === "import" &&
          mode.selectedSessions !== undefined &&
          (transcript.providerSessionId == null ||
            !isSelected(
              candidate.source,
              candidate.providerInstanceId,
              transcript.providerSessionId,
            ))
        ) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    const eligibleLocalThreads: Array<LocalThreadCandidate> = [];
    for (const candidate of localThreads) {
      if (
        !isSelected(
          candidate.thread.source,
          candidate.thread.providerInstanceId,
          candidate.thread.providerSessionId,
        ) ||
        candidate.lastActiveAtMs === null ||
        candidate.lastActiveAtMs < cutoffMs ||
        candidate.lastActiveAtMs > nowMs
      ) {
        continue;
      }
      const expanded = expandHomePath(candidate.workspaceRoot.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (isExcludedProjectPath(resolved)) continue;
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;
      eligibleLocalThreads.push(candidate);
    }
    eligibleLocalThreads.sort(
      (left, right) => (right.lastActiveAtMs ?? 0) - (left.lastActiveAtMs ?? 0),
    );
    const localThreadOutcomes = Stream.fromIteratorSucceed(eligibleLocalThreads.values(), 1).pipe(
      Stream.mapEffect((candidate) =>
        Effect.gen(function* () {
          const source = candidate.source;
          const completed = completedByFile.get(`${source.providerInstanceId}\0${source.filePath}`);
          const stats = yield* statOption(source.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const currentIdentity = transcriptIdentity(source.filePath, stats.value);
          if (!sameTranscriptIdentity(source, currentIdentity)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const completedSource = completed?.find(
            (completedCandidate) =>
              completedCandidate.provider === candidate.thread.source &&
              sameTranscriptIdentity(completedCandidate, currentIdentity),
          );
          const sessionKey = `${candidate.thread.providerInstanceId}\0${candidate.thread.providerSessionId}`;
          if (completedSource !== undefined) {
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread: candidate.thread,
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );

    const eligibleOpenCodeSessions = openCodeSessions
      .filter(
        (candidate) =>
          isSelected("opencode", candidate.providerInstanceId, candidate.listedSession.sessionId) &&
          candidate.lastActiveAtMs !== null &&
          candidate.lastActiveAtMs >= cutoffMs &&
          candidate.lastActiveAtMs <= nowMs,
      )
      .filter((candidate) => {
        const workspace = expandHomePath(candidate.listedSession.directory.trim());
        return path.isAbsolute(workspace) && !isExcludedProjectPath(path.resolve(workspace));
      })
      .sort((left, right) => (right.lastActiveAtMs ?? 0) - (left.lastActiveAtMs ?? 0));
    const eligibleOpenCodeByWorkspace: Array<OpenCodeSessionCandidate> = [];
    for (const candidate of eligibleOpenCodeSessions) {
      const workspace = path.resolve(expandHomePath(candidate.listedSession.directory.trim()));
      if ((yield* directoryIdentity(workspace)) === rootIdentity) {
        eligibleOpenCodeByWorkspace.push(candidate);
      }
    }

    const openCodeOutcomes: Array<AgentSessionRecentThread> = [];
    const openCodeNeedsExport: Array<OpenCodeSessionCandidate> = [];
    for (const candidate of eligibleOpenCodeByWorkspace) {
      const source = candidate.source;
      const completed = completedByFile.get(`${source.providerInstanceId}\0${source.filePath}`);
      const completedSource = completed?.find(
        (completedCandidate) =>
          completedCandidate.provider === "opencode" &&
          sameTranscriptIdentity(completedCandidate, source),
      );
      const sessionKey = `${candidate.providerInstanceId}\0${candidate.listedSession.sessionId}`;
      if (completedSource !== undefined) {
        if (importedSessions.has(sessionKey)) continue;
        importedSessions.add(sessionKey);
        openCodeOutcomes.push({ _tag: "AlreadyImported", source: completedSource });
        continue;
      }
      if (importedSessions.has(sessionKey)) {
        openCodeOutcomes.push({ _tag: "Duplicate", source });
        continue;
      }

      const listedSession = candidate.listedSession;
      const createdAt =
        listedSession.createdAt ?? listedSession.updatedAt ?? "1970-01-01T00:00:00.000Z";
      const updatedAt = listedSession.updatedAt ?? listedSession.createdAt ?? createdAt;
      if (mode.mode === "preview") {
        importedSessions.add(sessionKey);
        openCodeOutcomes.push({
          _tag: "Importable",
          source,
          thread: {
            source: "opencode",
            providerInstanceId: candidate.providerInstanceId,
            providerSessionId: listedSession.sessionId,
            title: listedSession.title,
            model: null,
            createdAt,
            updatedAt,
            messages: [],
            resumable: true,
          },
        });
      } else {
        openCodeNeedsExport.push(candidate);
      }
    }

    if (mode.mode === "import" && openCodeNeedsExport.length > 0) {
      const groups = Map.groupBy(
        openCodeNeedsExport,
        (candidate) => candidate.listedSession.directory,
      );
      for (const [workspaceRoot, group] of groups) {
        const exported = yield* OpenCodeSessionCli.exportSelectedOpenCodeSessions({
          runner: processRunner,
          environment: hostEnvironment,
          cwd: homeDir,
          workspaceRoot,
          listedSessions: group.map((candidate) => candidate.listedSession),
          selectedSessionIds: group.map((candidate) => candidate.listedSession.sessionId),
        });
        if (!exported.ok) {
          if (mode.selectedSessions === undefined) {
            for (let skipped = 0; skipped < group.length; skipped += 1) {
              openCodeOutcomes.push({ _tag: "Skipped" });
            }
          }
          continue;
        }
        if (mode.selectedSessions === undefined) {
          for (let skipped = 0; skipped < exported.value.skippedCount; skipped += 1) {
            openCodeOutcomes.push({ _tag: "Skipped" });
          }
        }
        for (const session of exported.value.sessions) {
          const candidate = group.find(
            (entry) => entry.listedSession.sessionId === session.importedSession.sessionId,
          );
          if (candidate === undefined) continue;
          const sessionKey = `${candidate.providerInstanceId}\0${session.importedSession.sessionId}`;
          if (importedSessions.has(sessionKey)) {
            openCodeOutcomes.push({ _tag: "Duplicate", source: candidate.source });
            continue;
          }
          importedSessions.add(sessionKey);
          const createdAt =
            session.importedSession.createdAt ??
            session.importedSession.updatedAt ??
            "1970-01-01T00:00:00.000Z";
          const updatedAt =
            session.importedSession.updatedAt ?? session.importedSession.createdAt ?? createdAt;
          openCodeOutcomes.push({
            _tag: "Importable",
            source: candidate.source,
            thread: {
              source: "opencode",
              providerInstanceId: candidate.providerInstanceId,
              providerSessionId: session.importedSession.sessionId,
              title: session.importedSession.title,
              model: null,
              createdAt,
              updatedAt,
              messages: session.importedSession.messages,
              resumable: true,
            },
          });
        }
      }
    }
    const openCodeOutcomeStream = Stream.fromIteratorSucceed(openCodeOutcomes.values(), 1);

    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    let recordsRemaining = MAX_IMPORT_RECORDS;
    const providerThreadOutcomes = Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (
            completed === undefined &&
            (transcriptsRemaining === 0 || bytesRemaining === 0 || recordsRemaining === 0)
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const identity = transcriptIdentity(transcript.filePath, stats.value);
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source && sameTranscriptIdentity(source, identity),
          );
          if (completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (
            transcriptsRemaining === 0 ||
            recordsRemaining === 0 ||
            identity.size > MAX_IMPORTED_TRANSCRIPT_BYTES ||
            identity.size > bytesRemaining
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          // Reserve the whole file even if its read or parse fails.
          transcriptsRemaining -= 1;
          bytesRemaining -= identity.size;
          const snapshot = yield* readTranscript(
            transcript.filePath,
            identity,
            recordsRemaining,
            candidate.source,
          );
          if (snapshot === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          recordsRemaining -= snapshot.recordCount;

          // A stable replacement file can belong to a different project than the cached candidate.
          let snapshotCwd: string | null = null;
          for (const record of snapshot.records) {
            snapshotCwd = extractDecodedCwd(record);
            if (snapshotCwd !== null) break;
          }
          if (snapshotCwd === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const expandedCwd = expandHomePath(snapshotCwd.trim());
          if (
            !path.isAbsolute(expandedCwd) ||
            (yield* directoryIdentity(path.resolve(expandedCwd))) !== rootIdentity
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }

          const parsedThread = parseAgentSessionRecords(
            {
              source: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
              lastActiveAtMs: transcript.mtimeMs,
            },
            snapshot.records,
          );
          if (parsedThread === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          if (
            !isSelected(
              parsedThread.source,
              parsedThread.providerInstanceId,
              parsedThread.providerSessionId,
            )
          ) {
            return Option.none<AgentSessionRecentThread>();
          }

          const source: AgentSessionImportSource = {
            ...identity,
            provider: parsedThread.source,
            providerInstanceId: parsedThread.providerInstanceId,
            providerSessionId: parsedThread.providerSessionId,
          };
          const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread: parsedThread,
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
    return Stream.concat(
      Stream.concat(localThreadOutcomes, openCodeOutcomeStream),
      providerThreadOutcomes,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
    mode = { mode: "preview" },
  ) => Stream.unwrap(prepareRecentThreads(workspaceRoot, completedSources, mode));

  return AgentSessionScanner.of({ scan, recentThreads });
});

export const layer = Layer.effect(AgentSessionScanner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
