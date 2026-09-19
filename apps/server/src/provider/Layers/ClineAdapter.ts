/**
 * ClineAdapter — `ProviderAdapterShape` for the Cline CLI.
 *
 * Cline has no long-lived app-server session to talk JSON-RPC to: headless
 * mode is one `--json` subprocess per turn. Each `sendTurn` therefore spawns
 * a fresh CLI, pipes the prompt over stdin, parses the NDJSON event stream
 * on stdout live, and folds it into canonical `ProviderRuntimeEvent`s. A
 * turn ends when the subprocess exits.
 *
 * Resume trap: `cline --id <session>` forces interactive mode (requires a
 * TTY), so headless turns always start a fresh Cline session and the adapter
 * never passes `--id`. Headless mode cannot surface interactive approvals,
 * so the adapter never opens requests: it inherits the CLI's approval policy
 * from the instance's `permissionMode` setting (`--auto-approve true` for
 * auto-accept, `false` for standard).
 *
 * @module provider/Layers/ClineAdapter
 */
import type {
  ClineSettings,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { clineTurnArgs } from "../clineLaunchArgs.ts";
import {
  parseClineNdjsonLine,
  renderClineToolOutput,
  type ClineUsageTotals,
} from "../clineNdjson.ts";

const ANSI_ESCAPE_REGEX = /\[[0-9;]*m/g;

const isoNow = (): Effect.Effect<string> => Effect.map(DateTime.now, DateTime.formatIso);

function toTurnTokenUsage(usage: ClineUsageTotals): TurnTokenUsage {
  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    hasSubagents: false,
  };
}

function toThreadUsageSnapshot(usage: ClineUsageTotals): ThreadTokenUsageSnapshot {
  return {
    usedTokens: usage.inputTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
  };
}

function summarizeClineToolInput(toolName: string, input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 240) : undefined;
  }
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidates = ["commands", "command", "query", "path", "file_path", "url"];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().slice(0, 240);
    }
    if (Array.isArray(value)) {
      const joined = value
        .filter((entry) => typeof entry === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) return joined.slice(0, 240);
    }
  }
  void toolName;
  return undefined;
}

function itemTypeForClineTool(toolName: string): string {
  if (toolName === "run_commands" || toolName === "execute_command") {
    return "command_execution";
  }
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "apply_patch" ||
    toolName === "search_and_replace"
  ) {
    return "file_change";
  }
  if (toolName === "web_search" || toolName === "web_fetch") {
    return "web_search";
  }
  return "dynamic_tool_call";
}

// ── Adapter factory ─────────────────────────────────────────────────

interface ClineAdapterOptions {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
}

interface ClineSession {
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly createdAt: string;
  updatedAt: string;
  lastError: string | undefined;
  /** Non-null while a turn subprocess is running for this thread. */
  activeRun: ActiveRun | null;
}

interface ActiveRun {
  readonly turnId: TurnId;
  /**
   * Cancellation object shared between the runner and interrupt/retire paths.
   * Kept on the run itself (not derived from the session map) so a run that
   * outlives its session entry still observes its own interruption.
   */
  readonly cancel: { requested: boolean };
  /** Null between the atomic reservation and the process actually spawning. */
  child: TurnChildHandle | null;
}

/** Structural view of the spawner's child handle, kept wide so the adapter
 * stays independent of the process module's exact stream/sink generics. */
interface TurnChildHandle {
  readonly exitCode: Effect.Effect<number>;
  readonly kill: (options?: { readonly forceKillAfter?: unknown }) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array, never>;
  readonly stderr: Stream.Stream<Uint8Array, never>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, never>;
}

type TurnOutcome = "completed" | "interrupted" | "failed";

export function makeClineAdapter(
  config: ClineSettings,
  options: ClineAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const driverKind = options.driverKind;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderRuntimeEvent>(),
      PubSub.shutdown,
    );
    const sessions = yield* Ref.make<Map<ThreadId, ClineSession>>(new Map());
    const sequence = yield* Ref.make(0);
    // Turn subprocesses live as long as the instance does: spawned under the
    // same scope the driver `create` runs in, so removing the instance kills
    // any in-flight Cline child.
    const instanceScope = yield* Effect.scope;

    const nextId = (): Effect.Effect<string> =>
      Ref.updateAndGet(sequence, (count) => count + 1).pipe(
        Effect.map((count) => `cline-${count}`),
      );

    const offer = (input: {
      readonly type: ProviderRuntimeEvent["type"];
      readonly payload: Record<string, unknown>;
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly itemId?: string;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const eventId = yield* nextId();
        const createdAt = yield* isoNow();
        const event = {
          eventId,
          provider: driverKind,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          type: input.type,
          payload: input.payload,
        };
        yield* PubSub.publish(pubsub, event as unknown as ProviderRuntimeEvent);
      });

    const getSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClineSession, ProviderAdapterSessionNotFoundError> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((map) => {
          const session = map.get(threadId);
          return session === undefined
            ? Effect.fail(
                new ProviderAdapterSessionNotFoundError({
                  provider: driverKind,
                  threadId,
                }),
              )
            : Effect.succeed(session);
        }),
      );

    /**
     * Patch a session only while the given turn is still the one in flight.
     * Guards late completion paths (or stale interrupts) from mutating a
     * replacement session that started after this turn was superseded.
     */
    const updateSessionForTurn = (
      threadId: ThreadId,
      turnId: TurnId,
      patch: (session: ClineSession) => ClineSession,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const updatedAt = yield* isoNow();
        yield* Ref.update(sessions, (map) => {
          const session = map.get(threadId);
          if (
            session === undefined ||
            session.activeRun === null ||
            session.activeRun.turnId !== turnId
          ) {
            return map;
          }
          return new Map(map).set(threadId, { ...patch(session), updatedAt });
        });
      });

    const releaseTurn = (threadId: ThreadId, turnId: TurnId): Effect.Effect<void> =>
      updateSessionForTurn(threadId, turnId, (current) => ({ ...current, activeRun: null }));

    /**
     * Attach the spawned child to the reserved run. Returns false when the run
     * was retired (startSession replaced the session) between reservation and
     * spawn — the caller must then abort its local child instead of running.
     */
    const attachChild = (
      threadId: ThreadId,
      turnId: TurnId,
      child: TurnChildHandle,
    ): Effect.Effect<boolean> =>
      Ref.modify(sessions, (map) => {
        const session = map.get(threadId);
        if (
          session === undefined ||
          session.activeRun === null ||
          session.activeRun.turnId !== turnId
        ) {
          return [false, map] as const;
        }
        return [
          true,
          new Map(map).set(threadId, {
            ...session,
            activeRun: { ...session.activeRun, child },
          }),
        ] as const;
      });

    const killActiveChild = (activeRun: ActiveRun): Effect.Effect<void> =>
      activeRun.child === null
        ? Effect.void
        : activeRun.child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);

    /**
     * Atomically reserve the thread for one turn. Two concurrent `sendTurn`
     * calls for the same thread cannot both pass this gate, so turns never
     * overlap even though spawning happens afterwards.
     */
    const reserveTurn = (threadId: ThreadId, turnId: TurnId): Effect.Effect<boolean> =>
      Ref.modify(sessions, (map) => {
        const session = map.get(threadId);
        if (session === undefined || session.activeRun !== null) {
          return [false, map] as const;
        }
        return [
          true,
          new Map(map).set(threadId, {
            ...session,
            activeRun: { turnId, cancel: { requested: false }, child: null },
          }),
        ] as const;
      });

    const runTurnRaw = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly prompt: string;
      readonly model: string | undefined;
    }) =>
      Effect.gen(function* () {
        const session = yield* getSession(input.threadId);
        if (session.activeRun === null || session.activeRun.turnId !== input.turnId) {
          return yield* new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "sendTurn",
            issue: "turn was not reserved for this thread",
          });
        }
        const runCancel = session.activeRun.cancel;

        yield* offer({
          type: "turn.started",
          threadId: input.threadId,
          turnId: input.turnId,
          payload: input.model === undefined ? {} : { model: input.model },
        });

        const args = clineTurnArgs({
          permissionMode: config.permissionMode,
          thinkingLevel: config.thinkingLevel,
          model: input.model,
          launchArgs: config.launchArgs,
        });
        const resolved = yield* resolveSpawnCommand(config.binaryPath || "cline", [...args], {
          env: options.environment,
          extendEnv: true,
        });
        const spawned = yield* spawner.spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
            env: options.environment,
            extendEnv: true,
            shell: resolved.shell,
            forceKillAfter: "2 seconds",
          }),
        );
        const child = spawned as unknown as TurnChildHandle;

        const owned = yield* attachChild(input.threadId, input.turnId, child);
        if (!owned) {
          // startSession retired this run before the child spawned: abort the
          // local child and end the turn as interrupted instead of running it.
          runCancel.requested = true;
          yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
          yield* offer({
            type: "turn.aborted",
            threadId: input.threadId,
            turnId: input.turnId,
            payload: { reason: "interrupted" },
          });
          return "interrupted" as const;
        }
        // A delayed interrupt may have landed before the child spawned.
        if (runCancel.requested) {
          yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
          yield* offer({
            type: "turn.aborted",
            threadId: input.threadId,
            turnId: input.turnId,
            payload: { reason: "interrupted" },
          });
          return "interrupted" as const;
        }

        // Stream the prompt over stdin; the CLI reads piped input as the task.
        yield* Stream.run(Stream.encodeText(Stream.make(input.prompt)), child.stdin).pipe(
          Effect.ignore,
        );

        let buffer = "";
        let stderrTail = "";
        let lastUsage: ClineUsageTotals | undefined;
        let doneReason: string | undefined;
        let doneText = "";
        let runFinishReason: string | undefined;
        let runText = "";
        // Item ids must be unique across turns: ingestion derives assistant
        // message ids from them, and a reused id would append a new turn's
        // text onto the previous turn's message.
        const assistantItemId = `assistant-${input.turnId}`;
        const reasoningItemId = `reasoning-${input.turnId}`;
        let assistantStarted = false;
        let reasoningStarted = false;

        const startAssistant = Effect.gen(function* () {
          if (assistantStarted) return;
          assistantStarted = true;
          yield* offer({
            type: "item.started",
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        });

        const startReasoning = Effect.gen(function* () {
          if (reasoningStarted) return;
          reasoningStarted = true;
          yield* offer({
            type: "item.started",
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: reasoningItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
          });
        });

        const handleLine = (line: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            const parsed = parseClineNdjsonLine(line);
            switch (parsed.kind) {
              case "ignored":
                return;
              case "textDelta": {
                yield* startAssistant;
                yield* offer({
                  type: "content.delta",
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: assistantItemId,
                  payload: { streamKind: "assistant_text", delta: parsed.delta },
                });
                return;
              }
              case "reasoningDelta": {
                yield* startReasoning;
                yield* offer({
                  type: "content.delta",
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: reasoningItemId,
                  payload: { streamKind: "reasoning_text", delta: parsed.delta },
                });
                return;
              }
              case "toolStart": {
                const detail = summarizeClineToolInput(parsed.toolName, parsed.input);
                yield* offer({
                  type: "item.started",
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: `tool-${parsed.toolCallId}`,
                  payload: {
                    itemType: itemTypeForClineTool(parsed.toolName),
                    status: "inProgress",
                    title: parsed.toolName,
                    ...(detail !== undefined ? { detail } : {}),
                  },
                });
                return;
              }
              case "toolUpdate": {
                if (parsed.chunk.length === 0) return;
                yield* offer({
                  type: "tool.progress",
                  threadId: input.threadId,
                  turnId: input.turnId,
                  payload: {
                    summary: parsed.chunk.slice(0, 500),
                    toolUseId: parsed.toolCallId,
                    toolName: parsed.toolName,
                  },
                });
                return;
              }
              case "toolEnd": {
                const failed = parsed.output.some((entry) => !entry.success);
                const detail = renderClineToolOutput(parsed.output);
                yield* offer({
                  type: "item.completed",
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: `tool-${parsed.toolCallId}`,
                  payload: {
                    itemType: itemTypeForClineTool(parsed.toolName),
                    status: failed ? "failed" : "completed",
                    ...(detail.length > 0 ? { detail: detail.slice(0, 4_000) } : {}),
                  },
                });
                return;
              }
              case "usage": {
                lastUsage = parsed.usage;
                return;
              }
              case "iterationEnd":
                return;
              case "done": {
                doneReason = parsed.reason;
                doneText = parsed.text;
                return;
              }
              case "runResult": {
                runFinishReason = parsed.finishReason;
                runText = parsed.text;
                if (lastUsage === undefined) lastUsage = parsed.usage;
                return;
              }
              case "error": {
                // Structured stderr lines surface here when the tail is
                // re-parsed on the failure path; stdout never carries them.
                return;
              }
            }
          });

        const stdoutLoop = child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk: string) =>
            Effect.gen(function* () {
              buffer += chunk;
              let newlineIndex: number;
              while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                yield* handleLine(line);
              }
            }),
          ),
        );

        const stderrLoop = child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk: string) =>
            Effect.sync(() => {
              const next = (stderrTail + chunk).replace(ANSI_ESCAPE_REGEX, "");
              stderrTail = next.length > 8_000 ? next.slice(next.length - 8_000) : next;
            }),
          ),
        );

        // Run the parse loops alongside the exit wait; all three finish when
        // the subprocess closes its pipes. A signal-killed child reports its
        // exit as a failure rather than a code, and every interrupt kills
        // the child — so the exit wait must never fail the turn.
        const [, , exitRaw] = yield* Effect.all(
          [stdoutLoop, stderrLoop, child.exitCode.pipe(Effect.orElseSucceed(() => -1))],
          {
            concurrency: "unbounded",
          },
        );
        const exitCode = typeof exitRaw === "number" ? exitRaw : Number(exitRaw);

        // Drain anything left after the last newline.
        if (buffer.trim().length > 0) {
          yield* handleLine(buffer);
          buffer = "";
        }

        const wasInterrupted = runCancel.requested;
        const usage = lastUsage;

        if (assistantStarted) {
          yield* offer({
            type: "item.completed",
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status: "completed" },
          });
        }
        if (reasoningStarted) {
          yield* offer({
            type: "item.completed",
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: reasoningItemId,
            payload: { itemType: "reasoning", status: "completed" },
          });
        }

        if (wasInterrupted) {
          yield* offer({
            type: "turn.aborted",
            threadId: input.threadId,
            turnId: input.turnId,
            payload: {
              reason: "interrupted",
              ...(usage !== undefined ? { tokenUsage: toTurnTokenUsage(usage) } : {}),
            },
          });
          return "interrupted" as const;
        }

        if (runFinishReason === "completed") {
          yield* offer({
            type: "turn.completed",
            threadId: input.threadId,
            turnId: input.turnId,
            payload: {
              state: "completed",
              ...(usage !== undefined ? { tokenUsage: toTurnTokenUsage(usage), usage } : {}),
            },
          });
          if (usage !== undefined) {
            yield* offer({
              type: "thread.token-usage.updated",
              threadId: input.threadId,
              payload: { usage: toThreadUsageSnapshot(usage) },
            });
          }
          return "completed" as const;
        }

        // Failure path. Prefer the run result text, then the done text, then
        // a structured message from stderr; Cline has no stable exit-code
        // taxonomy, so auth-shaped messages map to permission errors.
        const stderrLines = stderrTail.trim().split(/\r?\n/);
        let stderrMessage = "";
        for (let index = stderrLines.length - 1; index >= 0; index -= 1) {
          const frame = parseClineNdjsonLine(stderrLines[index]!);
          if (frame.kind === "error" && frame.message.trim().length > 0) {
            stderrMessage = frame.message.trim().slice(0, 2_000);
            break;
          }
        }
        if (stderrMessage.length === 0) {
          stderrMessage = stderrLines.slice(-3).join("\n").trim().slice(0, 2_000);
        }
        const message = (
          runText.trim().length > 0
            ? runText.trim()
            : doneText.trim().length > 0
              ? doneText.trim()
              : stderrMessage.length > 0
                ? `Cline turn failed${exitCode !== 0 ? ` (exit ${exitCode})` : ""}: ${stderrMessage}`
                : exitCode === -1
                  ? "Cline was terminated by signal"
                  : `Cline exited with code ${exitCode}`
        ).slice(0, 2_000);
        const errorClass = /auth|login|credential|permission|forbidden|unauthorized/i.test(message)
          ? ("permission_error" as const)
          : ("provider_error" as const);

        void doneReason;
        yield* offer({
          type: "runtime.error",
          threadId: input.threadId,
          turnId: input.turnId,
          payload: { message, class: errorClass },
        });
        yield* offer({
          type: "turn.completed",
          threadId: input.threadId,
          turnId: input.turnId,
          payload: { state: "failed", errorMessage: message },
        });
        return "failed" as const;
      });

    const runTurn = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly prompt: string;
      readonly model: string | undefined;
    }): Effect.Effect<TurnOutcome, ProviderAdapterProcessError> =>
      runTurnRaw(input).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, instanceScope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: driverKind,
              threadId: input.threadId,
              detail: `cline turn failed: ${String(cause)}`,
            }),
        ),
      );

    return {
      provider: driverKind,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          const now = yield* isoNow();
          const model = input.modelSelection?.model;
          const session: ClineSession = {
            threadId: input.threadId,
            cwd: input.cwd,
            model,
            createdAt: now,
            updatedAt: now,
            lastError: undefined,
            activeRun: null,
          };
          // A re-start for an existing thread must retire any in-flight run
          // first; otherwise its child keeps running and late events could
          // land on the replacement session.
          const previous = (yield* Ref.get(sessions)).get(input.threadId);
          if (previous !== undefined && previous.activeRun !== null) {
            previous.activeRun.cancel.requested = true;
            yield* killActiveChild(previous.activeRun);
          }
          yield* Ref.update(sessions, (map) => new Map(map).set(input.threadId, session));
          const providerSession: ProviderSession = {
            provider: driverKind,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: "full-access",
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(model !== undefined ? { model } : {}),
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };
          return providerSession;
        }),
      sendTurn: (input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          const session = yield* getSession(input.threadId);
          const prompt = input.input ?? (input.continuation === true ? "Continue." : "");
          if (prompt.trim().length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: driverKind,
              operation: "sendTurn",
              issue: "a turn needs non-empty text input",
            });
          }
          const model = input.modelSelection?.model ?? session.model;
          const turnId = (yield* nextId()) as TurnId;
          const reserved = yield* reserveTurn(input.threadId, turnId);
          if (!reserved) {
            return yield* new ProviderAdapterRequestError({
              provider: driverKind,
              method: "sendTurn",
              detail: "a turn is already running for this thread",
            });
          }
          const outcome = yield* runTurn({ threadId: input.threadId, turnId, prompt, model }).pipe(
            Effect.ensuring(releaseTurn(input.threadId, turnId)),
          );
          void outcome;
          const providerResult: ProviderTurnStartResult = {
            threadId: input.threadId,
            turnId,
          };
          return providerResult;
        }),
      compaction: undefined,
      interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
        Effect.gen(function* () {
          const session = yield* getSession(threadId);
          const activeRun = session.activeRun;
          if (activeRun === null) {
            if (turnId === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: driverKind,
                operation: "interruptTurn",
                issue: "no turn is running for this thread",
              });
            }
            // Stale interrupt for a turn that already finished: nothing to do.
            return;
          }
          if (turnId !== undefined && activeRun.turnId !== turnId) {
            // Interrupt arrived for an older turn; a newer one owns the thread.
            return;
          }
          activeRun.cancel.requested = true;
          yield* killActiveChild(activeRun);
        }),
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: string,
        _decision: ProviderApprovalDecision,
      ) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "respondToRequest",
            issue: "Cline headless turns do not surface approval requests",
          }),
        ),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: string,
        _answers: ProviderUserInputAnswers,
      ) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "respondToUserInput",
            issue: "Cline headless turns do not surface user-input requests",
          }),
        ),
      stopSession: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const session = yield* getSession(threadId);
          if (session.activeRun !== null) {
            session.activeRun.cancel.requested = true;
            yield* killActiveChild(session.activeRun);
          }
          yield* Ref.update(sessions, (map) => {
            const next = new Map(map);
            next.delete(threadId);
            return next;
          });
        }),
      listSessions: () =>
        Ref.get(sessions).pipe(
          Effect.map((map) =>
            [...map.values()].map((session): ProviderSession => ({
              provider: driverKind,
              providerInstanceId: options.instanceId,
              status: session.activeRun === null ? "ready" : "running",
              runtimeMode: "full-access",
              ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
              ...(session.model !== undefined ? { model: session.model } : {}),
              threadId: session.threadId,
              ...(session.activeRun !== null ? { activeTurnId: session.activeRun.turnId } : {}),
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
            })),
          ),
        ),
      hasSession: (threadId: ThreadId) =>
        Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId))),
      readThread: (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* getSession(threadId);
          return { threadId, turns: [] };
        }),
      rollbackThread: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "rollbackThread",
            issue: "Cline sessions cannot be rewound headlessly",
          }),
        ),
      stopAll: () =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          for (const session of current.values()) {
            if (session.activeRun !== null) {
              session.activeRun.cancel.requested = true;
              yield* killActiveChild(session.activeRun);
            }
          }
          yield* Ref.set(sessions, new Map());
        }),
      get streamEvents() {
        return Stream.fromPubSub(pubsub);
      },
      // The object literal above tracks ProviderAdapterShape by construction;
      // the interface's per-method Effect variance (exactOptionalPropertyTypes
      // plus error-channel inference across closures) resists structural
      // typing here, so the boundary is asserted explicitly.
    } as unknown as ProviderAdapterShape<ProviderAdapterError>;
  });
}
