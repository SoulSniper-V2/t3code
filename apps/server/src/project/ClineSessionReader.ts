// @effect-diagnostics nodeBuiltinImport:off - Cline stores session artifacts
// under user-selected data roots; Node path helpers keep path validation pure.
/**
 * Read-only import preview for Cline's local session artifacts.
 *
 * Current CLI sessions use `<data>/sessions/<id>/<id>.json` and
 * `<data>/sessions/<id>/<id>.messages.json`. Older pre-SDK sessions use
 * `<data>/state/taskHistory.json` plus `<data>/tasks/<id>/ui_messages.json`.
 * Every JSON boundary is schema-checked, artifact paths are derived from
 * validated IDs and containment-checked, and only visible user/assistant text
 * is returned. This reader never invokes Cline or resumes a Cline session.
 *
 * @module project/ClineSessionReader
 */
import * as NodePath from "node:path";

import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MAX_SESSIONS = 500;
const MAX_LEGACY_TASKS = 500;
const MAX_BYTES_PER_ARTIFACT = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGES_PER_SESSION = 500;
const MAX_MESSAGE_TEXT_CHARS = 256_000;

const ClineManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  session_id: Schema.String,
  source: Schema.String,
  status: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  cwd: Schema.String,
  workspace_root: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.optional(Schema.String),
  messages_path: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ClineMessageBlockSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

const ClineStoredMessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(ClineMessageBlockSchema)]),
  timestamp: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ClineMessagesEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  messages: Schema.Array(Schema.Unknown),
});

const ClineLegacyHistoryItemSchema = Schema.Struct({
  id: Schema.String,
  ts: Schema.Number,
  task: Schema.String,
  tokensIn: Schema.Number,
  tokensOut: Schema.Number,
  totalCost: Schema.Number,
  cwdOnTaskInitialization: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  apiProvider: Schema.optional(Schema.String),
  isLegacy: Schema.optional(Schema.Boolean),
});

const ClineLegacyUiMessageSchema = Schema.Struct({
  ts: Schema.Number,
  type: Schema.Literals(["ask", "say"]),
  ask: Schema.optional(Schema.String),
  say: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const decodeManifest = Schema.decodeUnknownOption(ClineManifestSchema);
const decodeMessagesEnvelope = Schema.decodeUnknownOption(ClineMessagesEnvelopeSchema);
const decodeStoredMessage = Schema.decodeUnknownOption(ClineStoredMessageSchema);
const decodeLegacyHistoryItem = Schema.decodeUnknownOption(ClineLegacyHistoryItemSchema);
const decodeLegacyUiMessage = Schema.decodeUnknownOption(ClineLegacyUiMessageSchema);

export interface ClineImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ClineImportedSession {
  readonly source: "cline";
  readonly format: "sdk" | "legacy";
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ClineImportedMessage>;
  readonly historyOnly: true;
  readonly fileIdentity: ClineSessionFileIdentity;
}

export interface ClineSessionFileIdentity {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number | null;
  readonly device: number;
  readonly inode: number | null;
  readonly birthtimeMs: number | null;
}

export interface ClineReadInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

/** Cline CLI data-dir precedence: CLINE_DATA_DIR, CLINE_DIR/data, ~/.cline/data. */
export function resolveClineDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const explicitDataDir = env["CLINE_DATA_DIR"]?.trim();
  if (explicitDataDir) return NodePath.resolve(explicitDataDir);

  const configuredClineDir = env["CLINE_DIR"]?.trim();
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim() || homeDir;
  return NodePath.resolve(configuredClineDir || NodePath.join(home, ".cline"), "data");
}

/** Cline allows session artifacts to live separately from its other data. */
export function resolveClineSessionsDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const explicitSessionDir = env["CLINE_SESSION_DATA_DIR"]?.trim();
  return NodePath.resolve(explicitSessionDir || NodePath.join(dataDir, "sessions"));
}

function parseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTimestamp(value: string | undefined, fallbackMs: number): string {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  const safeFallback =
    Number.isFinite(fallbackMs) && Math.abs(fallbackMs) <= 8.64e15 ? fallbackMs : 0;
  return Number.isFinite(parsed)
    ? DateTime.formatIso(DateTime.makeUnsafe(parsed))
    : DateTime.formatIso(DateTime.makeUnsafe(safeFallback));
}

function parseTimestampMs(value: number | undefined, fallbackMs: number): string {
  const safeFallback =
    Number.isFinite(fallbackMs) && Math.abs(fallbackMs) <= 8.64e15 ? fallbackMs : 0;
  return value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(value))
    : DateTime.formatIso(DateTime.makeUnsafe(safeFallback));
}

function safeSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function metadataHidesMessage(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  if (metadata === undefined) return false;
  const displayRole = metadata["displayRole"];
  const kind = metadata["kind"];
  return (
    (typeof displayRole === "string" && displayRole !== "user" && displayRole !== "assistant") ||
    displayRole === "system" ||
    displayRole === "status" ||
    displayRole === "thinking" ||
    displayRole === "reasoning" ||
    kind === "tool" ||
    kind === "tool_call" ||
    kind === "tool_result" ||
    kind === "thinking" ||
    kind === "reasoning" ||
    kind === "recovery_notice"
  );
}

function visibleText(content: string | ReadonlyArray<typeof ClineMessageBlockSchema.Type>): string {
  if (typeof content === "string") return content.trim().slice(0, MAX_MESSAGE_TEXT_CHARS);
  return content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n")
    .trim()
    .slice(0, MAX_MESSAGE_TEXT_CHARS);
}

/** Validate and project the current SDK manifest, rejecting path-like IDs. */
export function parseClineSessionManifest(
  input: string,
  expectedSessionId?: string,
): typeof ClineManifestSchema.Type | null {
  const parsed = parseJson(input);
  if (parsed === undefined) return null;
  const decoded = decodeManifest(parsed);
  if (Option.isNone(decoded)) return null;
  const manifest = decoded.value;
  if (
    !safeSessionId(manifest.session_id) ||
    (expectedSessionId !== undefined && manifest.session_id !== expectedSessionId) ||
    !nonEmpty(manifest.source) ||
    !nonEmpty(manifest.status) ||
    !nonEmpty(manifest.provider) ||
    !nonEmpty(manifest.model) ||
    !nonEmpty(manifest.started_at) ||
    !NodePath.isAbsolute(manifest.cwd) ||
    !NodePath.isAbsolute(manifest.workspace_root) ||
    (manifest.messages_path !== undefined && !NodePath.isAbsolute(manifest.messages_path))
  ) {
    return null;
  }
  if (!Number.isFinite(Date.parse(manifest.started_at))) return null;
  return manifest;
}

/** Validate current Cline message envelope and retain text blocks only. */
export function parseClineMessages(
  input: string,
  expectedSessionId: string,
  fallbackTimestamp: string,
): ReadonlyArray<ClineImportedMessage> | null {
  const parsed = parseJson(input);
  if (parsed === undefined) return null;
  const decoded = decodeMessagesEnvelope(parsed);
  if (Option.isNone(decoded) || decoded.value.sessionId !== expectedSessionId) return null;

  const fallbackMs = Date.parse(fallbackTimestamp);
  const messages: ClineImportedMessage[] = [];
  for (const candidate of decoded.value.messages.slice(-MAX_MESSAGES_PER_SESSION)) {
    const decodedMessage = decodeStoredMessage(candidate);
    if (Option.isNone(decodedMessage)) continue;
    const message = decodedMessage.value;
    if (
      nonEmpty(message.id) === undefined ||
      (message.role !== "user" && message.role !== "assistant") ||
      metadataHidesMessage(message.metadata)
    ) {
      continue;
    }
    const text = visibleText(message.content);
    if (text.length === 0) continue;
    messages.push({
      role: message.role,
      text,
      createdAt:
        message.timestamp !== undefined
          ? parseTimestamp(message.timestamp, fallbackMs)
          : parseTimestampMs(message.ts, fallbackMs),
    });
  }
  return messages;
}

export interface ClineLegacyHistoryItem {
  readonly id: string;
  readonly ts: number;
  readonly task: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly totalCost: number;
  readonly cwdOnTaskInitialization?: string;
  readonly modelId?: string;
  readonly apiProvider?: string;
}

/** Keep only task-history rows that satisfy Cline's documented HistoryItem shape. */
export function parseClineLegacyTaskHistory(input: string): ReadonlyArray<ClineLegacyHistoryItem> {
  const parsed = parseJson(input);
  if (!Array.isArray(parsed)) return [];
  const items: ClineLegacyHistoryItem[] = [];
  for (const candidate of parsed.slice(0, MAX_LEGACY_TASKS)) {
    const decoded = decodeLegacyHistoryItem(candidate);
    if (Option.isNone(decoded)) continue;
    const item = decoded.value;
    if (
      !safeSessionId(item.id) ||
      !Number.isSafeInteger(item.ts) ||
      Math.abs(item.ts) > 8.64e15 ||
      !Number.isSafeInteger(item.tokensIn) ||
      item.tokensIn < 0 ||
      !Number.isSafeInteger(item.tokensOut) ||
      item.tokensOut < 0 ||
      !Number.isFinite(item.totalCost) ||
      item.totalCost < 0 ||
      nonEmpty(item.task) === undefined ||
      (item.cwdOnTaskInitialization !== undefined &&
        !NodePath.isAbsolute(item.cwdOnTaskInitialization))
    ) {
      continue;
    }
    items.push({
      id: item.id,
      ts: item.ts,
      task: item.task,
      tokensIn: item.tokensIn,
      tokensOut: item.tokensOut,
      totalCost: item.totalCost,
      ...(item.cwdOnTaskInitialization !== undefined
        ? { cwdOnTaskInitialization: item.cwdOnTaskInitialization }
        : {}),
      ...(item.modelId !== undefined ? { modelId: item.modelId } : {}),
      ...(item.apiProvider !== undefined ? { apiProvider: item.apiProvider } : {}),
    });
  }
  return items;
}

/** Validate legacy Cline UI rows and project only user/assistant prose. */
export function parseClineLegacyUiMessages(
  input: string,
  fallbackTimestamp: string,
  initialPrompt?: string,
): ReadonlyArray<ClineImportedMessage> | null {
  const parsed = parseJson(input);
  if (!Array.isArray(parsed)) return null;
  const fallbackMs = Date.parse(fallbackTimestamp);
  const messages: ClineImportedMessage[] = [];
  const prompt = initialPrompt === undefined ? undefined : nonEmpty(initialPrompt);
  if (prompt !== undefined) {
    messages.push({
      role: "user",
      text: prompt.slice(0, MAX_MESSAGE_TEXT_CHARS),
      createdAt: fallbackTimestamp,
    });
  }

  const messageLimit = Math.max(0, MAX_MESSAGES_PER_SESSION - (prompt === undefined ? 0 : 1));
  for (const candidate of parsed.slice(-messageLimit)) {
    const decoded = decodeLegacyUiMessage(candidate);
    if (Option.isNone(decoded)) continue;
    const row = decoded.value;
    const text = nonEmpty(row.text ?? "")?.slice(0, MAX_MESSAGE_TEXT_CHARS);
    if (text === undefined) continue;

    let role: ClineImportedMessage["role"] | undefined;
    if (row.type === "say" && (row.say === "text" || row.say === "completion_result")) {
      role = "assistant";
    } else if (row.type === "say" && row.say === "user_feedback") {
      role = "user";
    } else if (
      row.type === "ask" &&
      (row.ask === "followup" || row.ask === "plan_mode_respond" || row.ask === "act_mode_respond")
    ) {
      role = "assistant";
    }
    if (role === undefined) continue;

    const previous = messages.at(-1);
    if (previous?.role === role && previous.text.trim() === text.trim()) continue;
    messages.push({ role, text, createdAt: parseTimestampMs(row.ts, fallbackMs) });
  }
  return messages;
}

function isWithin(parent: string, child: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(parent), NodePath.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function metadataTitle(
  metadata: (typeof ClineManifestSchema.Type)["metadata"],
): string | undefined {
  const title = metadata?.["title"];
  return typeof title === "string" ? nonEmpty(title) : undefined;
}

function fileSize(info: FileSystem.File.Info): number {
  return Number(ByteSize.toBigInt(info.size));
}

function fileIdentity(filePath: string, info: FileSystem.File.Info): ClineSessionFileIdentity {
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
  left: ClineSessionFileIdentity,
  right: ClineSessionFileIdentity,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export function readClineSessionHistory(input: ClineReadInput) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveClineDataDir(input.env, input.homeDir);
    const sessionsDir = resolveClineSessionsDir(input.env, dataDir);
    const resolvedSessionsDir = yield* fileSystem
      .realPath(sessionsDir)
      .pipe(Effect.orElseSucceed(() => path.resolve(sessionsDir)));
    const results: ClineImportedSession[] = [];
    let bytesRead = 0;

    const readBoundedJson = (filePath: string, containmentRoot: string) =>
      Effect.gen(function* () {
        const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.option);
        if (Option.isNone(realPath) || !isWithin(containmentRoot, realPath.value)) return null;
        const stat = yield* fileSystem.stat(realPath.value).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "File") return null;
        const fileBytes = Number(stat.value.size);
        if (
          !Number.isSafeInteger(fileBytes) ||
          fileBytes < 0 ||
          fileBytes > MAX_BYTES_PER_ARTIFACT ||
          bytesRead + fileBytes > MAX_TOTAL_BYTES
        ) {
          return null;
        }
        const content = yield* fileSystem.readFileString(realPath.value).pipe(Effect.option);
        if (Option.isNone(content)) return null;
        bytesRead += fileBytes;
        return content.value;
      });

    const readBoundedTranscript = (filePath: string, containmentRoot: string) =>
      Effect.gen(function* () {
        const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.option);
        if (
          Option.isNone(realPath) ||
          !isWithin(containmentRoot, realPath.value) ||
          path.resolve(realPath.value) !== path.resolve(filePath)
        ) {
          return undefined;
        }

        const readResult = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(realPath.value, { flag: "r" });
            const before = yield* file.stat;
            if (before.type !== "File" || fileSize(before) > MAX_BYTES_PER_ARTIFACT) {
              return undefined;
            }
            const beforeIdentity = fileIdentity(realPath.value, before);
            const buffer = new Uint8Array(MAX_BYTES_PER_ARTIFACT + 1);
            let offset = 0;
            while (offset < buffer.length) {
              const count = yield* file.read(buffer.subarray(offset));
              if (count === 0) break;
              offset += count;
            }
            if (offset > MAX_BYTES_PER_ARTIFACT) return undefined;

            const after = yield* file.stat;
            const afterIdentity = fileIdentity(realPath.value, after);
            if (after.type !== "File" || !sameFileIdentity(beforeIdentity, afterIdentity)) {
              return undefined;
            }
            const finalPath = yield* fileSystem.realPath(filePath).pipe(Effect.option);
            if (Option.isNone(finalPath) || finalPath.value !== realPath.value) return undefined;
            if (bytesRead + beforeIdentity.size > MAX_TOTAL_BYTES) return undefined;
            return {
              contents: new TextDecoder().decode(buffer.subarray(0, offset)),
              identity: beforeIdentity,
            };
          }),
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (readResult === undefined) return undefined;
        bytesRead += readResult.identity.size;
        return readResult;
      });

    const realDataDir = yield* fileSystem
      .realPath(dataDir)
      .pipe(Effect.orElseSucceed(() => path.resolve(dataDir)));
    const sessionDirectoryNames = yield* fileSystem
      .readDirectory(resolvedSessionsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const sessionCandidates: Array<{ readonly name: string; readonly mtime: number }> = [];
    for (const name of sessionDirectoryNames) {
      if (!safeSessionId(name) || sessionCandidates.length >= MAX_SESSIONS) continue;
      const directoryPath = path.join(resolvedSessionsDir, name);
      const stats = yield* fileSystem.stat(directoryPath).pipe(Effect.option);
      if (Option.isNone(stats) || stats.value.type !== "Directory") continue;
      const mtime = Option.isSome(stats.value.mtime) ? stats.value.mtime.value.getTime() : 0;
      sessionCandidates.push({ name, mtime });
    }

    for (const candidate of sessionCandidates.toSorted((a, b) => b.mtime - a.mtime)) {
      const sessionDir = path.join(resolvedSessionsDir, candidate.name);
      const realSessionDir = yield* fileSystem.realPath(sessionDir).pipe(Effect.option);
      if (Option.isNone(realSessionDir) || !isWithin(resolvedSessionsDir, realSessionDir.value)) {
        continue;
      }
      const manifestPath = path.join(realSessionDir.value, `${candidate.name}.json`);
      const manifestText = yield* readBoundedJson(manifestPath, realSessionDir.value);
      if (manifestText === null) continue;
      const manifest = parseClineSessionManifest(manifestText, candidate.name);
      if (manifest === null) continue;

      const workspaceRootInput = path.resolve(manifest.workspace_root);
      const cwdInput = path.resolve(manifest.cwd);
      const workspaceRoot = yield* fileSystem.realPath(workspaceRootInput).pipe(Effect.option);
      const cwd = yield* fileSystem.realPath(cwdInput).pipe(Effect.option);
      if (
        Option.isNone(workspaceRoot) ||
        Option.isNone(cwd) ||
        !isWithin(workspaceRoot.value, cwd.value)
      ) {
        continue;
      }
      const workspaceStats = yield* fileSystem.stat(workspaceRoot.value).pipe(Effect.option);
      const cwdStats = yield* fileSystem.stat(cwd.value).pipe(Effect.option);
      if (
        Option.isNone(workspaceStats) ||
        workspaceStats.value.type !== "Directory" ||
        Option.isNone(cwdStats) ||
        cwdStats.value.type !== "Directory"
      ) {
        continue;
      }

      const expectedMessagesPath = path.join(
        realSessionDir.value,
        `${candidate.name}.messages.json`,
      );
      if (manifest.messages_path !== undefined) {
        const declaredMessagesPath = path.resolve(manifest.messages_path);
        const realDeclaredMessagesPath = yield* fileSystem
          .realPath(declaredMessagesPath)
          .pipe(Effect.option);
        if (
          Option.isNone(realDeclaredMessagesPath) ||
          !isWithin(realSessionDir.value, realDeclaredMessagesPath.value) ||
          path.resolve(realDeclaredMessagesPath.value) !== path.resolve(expectedMessagesPath)
        ) {
          continue;
        }
      }
      const messagesRead = yield* readBoundedTranscript(expectedMessagesPath, realSessionDir.value);
      if (messagesRead === undefined) continue;
      const createdAt = parseTimestamp(manifest.started_at, 0);
      const messages = parseClineMessages(messagesRead.contents, candidate.name, createdAt);
      if (messages === null || messages.length === 0) continue;
      const manifestEnd = parseTimestamp(
        manifest.ended_at ?? manifest.started_at,
        Date.parse(createdAt),
      );
      const firstUserText = messages.find((message) => message.role === "user")?.text;
      results.push({
        source: "cline",
        format: "sdk",
        providerSessionId: manifest.session_id,
        title: metadataTitle(manifest.metadata) ?? firstUserText?.slice(0, 160) ?? "Cline session",
        model: manifest.model,
        workspaceRoot: workspaceRoot.value,
        createdAt,
        updatedAt: manifestEnd,
        messages,
        historyOnly: true,
        fileIdentity: messagesRead.identity,
      });
    }

    const legacyHistoryPath = path.join(realDataDir, "state", "taskHistory.json");
    const legacyHistoryText = yield* readBoundedJson(legacyHistoryPath, realDataDir);
    if (legacyHistoryText !== null) {
      const legacyItems = parseClineLegacyTaskHistory(legacyHistoryText);
      for (const item of legacyItems) {
        const taskDir = path.join(realDataDir, "tasks", item.id);
        const realTaskDir = yield* fileSystem.realPath(taskDir).pipe(Effect.option);
        if (Option.isNone(realTaskDir) || !isWithin(realDataDir, realTaskDir.value)) continue;
        const uiMessagesPath = path.join(realTaskDir.value, "ui_messages.json");
        const uiMessagesRead = yield* readBoundedTranscript(uiMessagesPath, realTaskDir.value);
        if (uiMessagesRead === undefined) continue;

        const workspaceInput = item.cwdOnTaskInitialization;
        if (workspaceInput === undefined) continue;
        const workspaceRoot = yield* fileSystem
          .realPath(path.resolve(workspaceInput))
          .pipe(Effect.option);
        if (Option.isNone(workspaceRoot)) continue;
        const workspaceStats = yield* fileSystem.stat(workspaceRoot.value).pipe(Effect.option);
        if (Option.isNone(workspaceStats) || workspaceStats.value.type !== "Directory") continue;

        const createdAt = parseTimestampMs(item.ts, 0);
        const messages = parseClineLegacyUiMessages(uiMessagesRead.contents, createdAt, item.task);
        if (messages === null || messages.length === 0) continue;
        const uiStats = yield* fileSystem.stat(uiMessagesPath).pipe(Effect.option);
        const updatedAt =
          Option.isSome(uiStats) && Option.isSome(uiStats.value.mtime)
            ? uiStats.value.mtime.value.toISOString()
            : createdAt;
        results.push({
          source: "cline",
          format: "legacy",
          providerSessionId: item.id,
          title: item.task.slice(0, 160),
          model: item.modelId ?? null,
          workspaceRoot: workspaceRoot.value,
          createdAt,
          updatedAt,
          messages,
          historyOnly: true,
          fileIdentity: uiMessagesRead.identity,
        });
      }
    }

    return results.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });
}
