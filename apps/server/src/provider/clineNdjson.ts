/**
 * clineNdjson — parse Cline `--json` NDJSON frames into adapter-ready events.
 *
 * Observed wire (CLI 3.0.x, `cline --json`; the docs still show the old
 * `say`/`ask` schema):
 *
 * - `hook_event` (`agent_start`, `tool_call`, …) carries no content and is
 *   always ignored.
 * - `agent_event` carries one `event` per line: `iteration_start/end`,
 *   `content_start` (text/reasoning/tool deltas), `content_update` (tool
 *   stdout chunks), `content_end` (tool results), `usage`, and terminal
 *   `done`.
 * - `run_result` is always last with the final text, aggregate usage, and
 *   the resolved model.
 * - `{"type":"error"}` lines go to stderr on failures; the adapter reads the
 *   same shape from the stderr tail.
 *
 * Unknown `event.type` values are forward-compatible and ignored.
 *
 * @module provider/clineNdjson
 */

export interface ClineUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalCostUsd: number | null;
}

export interface ClineToolOutput {
  readonly query: string;
  readonly result: string;
  readonly success: boolean;
}

export type ClineFrame =
  | { readonly kind: "ignored" }
  | { readonly kind: "textDelta"; readonly delta: string }
  | { readonly kind: "reasoningDelta"; readonly delta: string }
  | {
      readonly kind: "toolStart";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "toolUpdate";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly chunk: string;
    }
  | {
      readonly kind: "toolEnd";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: ReadonlyArray<ClineToolOutput>;
    }
  | { readonly kind: "usage"; readonly usage: ClineUsageTotals }
  | { readonly kind: "iterationEnd"; readonly hadToolCalls: boolean }
  | { readonly kind: "done"; readonly reason: string; readonly text: string }
  | {
      readonly kind: "runResult";
      readonly finishReason: string;
      readonly usage: ClineUsageTotals;
      readonly text: string;
      readonly modelId: string;
      readonly modelProvider: string;
    }
  | { readonly kind: "error"; readonly message: string };

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function costUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readUsage(value: unknown): ClineUsageTotals | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const totalCost = costUsd(record["totalCost"] ?? record["cost"]);
  return {
    inputTokens: int(record["inputTokens"]),
    outputTokens: int(record["outputTokens"]),
    cacheReadTokens: int(record["cacheReadTokens"]),
    cacheWriteTokens: int(record["cacheWriteTokens"]),
    totalCostUsd: totalCost,
  };
}

function readToolOutput(value: unknown): ReadonlyArray<ClineToolOutput> {
  if (!Array.isArray(value)) return [];
  const output: ClineToolOutput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    output.push({
      query: typeof record["query"] === "string" ? record["query"] : "",
      result: typeof record["result"] === "string" ? record["result"] : "",
      success: record["success"] === true,
    });
  }
  return output;
}

/** Render tool output for the timeline: successful stdout, else the query. */
export function renderClineToolOutput(output: ReadonlyArray<ClineToolOutput>): string {
  const rendered = output
    .map((entry) => (entry.success ? entry.result : `(${entry.query} failed)`))
    .join("")
    .trim();
  return rendered.length > 0 ? rendered : output.map((entry) => entry.query).join(", ");
}

function readAgentEvent(event: Record<string, unknown>): ClineFrame {
  const type = event["type"];
  switch (type) {
    case "iteration_start":
      return { kind: "ignored" };
    case "iteration_end":
      return { kind: "iterationEnd", hadToolCalls: event["hadToolCalls"] === true };
    case "content_start": {
      const contentType = event["contentType"];
      if (contentType === "text") {
        return typeof event["text"] === "string"
          ? { kind: "textDelta", delta: event["text"] }
          : { kind: "ignored" };
      }
      if (contentType === "reasoning") {
        return typeof event["reasoning"] === "string"
          ? { kind: "reasoningDelta", delta: event["reasoning"] }
          : { kind: "ignored" };
      }
      if (contentType === "tool") {
        return typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string"
          ? {
              kind: "toolStart",
              toolCallId: event["toolCallId"],
              toolName: event["toolName"],
              input: event["input"],
            }
          : { kind: "ignored" };
      }
      return { kind: "ignored" };
    }
    case "content_update": {
      if (event["contentType"] !== "tool") return { kind: "ignored" };
      const update = event["update"];
      const chunk =
        typeof update === "object" &&
        update !== null &&
        typeof (update as Record<string, unknown>)["chunk"] === "string"
          ? ((update as Record<string, unknown>)["chunk"] as string)
          : "";
      return typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string"
        ? {
            kind: "toolUpdate",
            toolCallId: event["toolCallId"],
            toolName: event["toolName"],
            chunk,
          }
        : { kind: "ignored" };
    }
    case "content_end":
      // Text/reasoning ends repeat the streamed deltas; only tool ends
      // carry new information (the result payload).
      if (event["contentType"] !== "tool") return { kind: "ignored" };
      return typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string"
        ? {
            kind: "toolEnd",
            toolCallId: event["toolCallId"],
            toolName: event["toolName"],
            output: readToolOutput(event["output"]),
          }
        : { kind: "ignored" };
    case "usage": {
      const usage = readUsage(event);
      return usage === undefined ? { kind: "ignored" } : { kind: "usage", usage };
    }
    case "done":
      return {
        kind: "done",
        reason: typeof event["reason"] === "string" ? event["reason"] : "",
        text: typeof event["text"] === "string" ? event["text"] : "",
      };
    default:
      return { kind: "ignored" };
  }
}

/** Parse one NDJSON line from `cline --json` stdout (or the stderr tail). */
export function parseClineNdjsonLine(line: string): ClineFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "ignored" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignored" };
  const record = parsed as Record<string, unknown>;
  switch (record["type"]) {
    case "hook_event":
      return { kind: "ignored" };
    case "agent_event": {
      const event = record["event"];
      return typeof event === "object" && event !== null
        ? readAgentEvent(event as Record<string, unknown>)
        : { kind: "ignored" };
    }
    case "run_result": {
      const usage = readUsage(record["usage"] ?? record["aggregateUsage"]);
      const model = record["model"];
      const modelRecord =
        typeof model === "object" && model !== null ? (model as Record<string, unknown>) : null;
      return {
        kind: "runResult",
        finishReason: typeof record["finishReason"] === "string" ? record["finishReason"] : "",
        usage: usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCostUsd: null,
        },
        text: typeof record["text"] === "string" ? record["text"] : "",
        modelId: typeof modelRecord?.["id"] === "string" ? (modelRecord["id"] as string) : "",
        modelProvider:
          typeof modelRecord?.["provider"] === "string" ? (modelRecord["provider"] as string) : "",
      };
    }
    case "error":
      return {
        kind: "error",
        message: typeof record["message"] === "string" ? record["message"] : "Unknown Cline error",
      };
    default:
      return { kind: "ignored" };
  }
}
