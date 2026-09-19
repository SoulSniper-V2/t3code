import { describe, expect, it } from "vite-plus/test";

import { parseClineNdjsonLine, renderClineToolOutput } from "./clineNdjson.ts";

const line = (value: unknown): string => JSON.stringify(value);

describe("parseClineNdjsonLine", () => {
  it("streams text and reasoning deltas", () => {
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: { type: "content_start", contentType: "text", text: "ok" },
        }),
      ),
    ).toEqual({ kind: "textDelta", delta: "ok" });
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: { type: "content_start", contentType: "reasoning", reasoning: "think" },
        }),
      ),
    ).toEqual({ kind: "reasoningDelta", delta: "think" });
  });

  it("tracks the tool lifecycle with stdout chunks and results", () => {
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolCallId: "call-1",
            toolName: "run_commands",
            input: { commands: "echo hi" },
          },
        }),
      ),
    ).toEqual({
      kind: "toolStart",
      toolCallId: "call-1",
      toolName: "run_commands",
      input: { commands: "echo hi" },
    });
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: {
            type: "content_update",
            contentType: "tool",
            toolCallId: "call-1",
            toolName: "run_commands",
            update: { stream: "stdout", chunk: "hi\n" },
          },
        }),
      ),
    ).toEqual({
      kind: "toolUpdate",
      toolCallId: "call-1",
      toolName: "run_commands",
      chunk: "hi\n",
    });
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolCallId: "call-1",
            toolName: "run_commands",
            output: [{ query: "echo hi", result: "hi\n", success: true }],
          },
        }),
      ),
    ).toEqual({
      kind: "toolEnd",
      toolCallId: "call-1",
      toolName: "run_commands",
      output: [{ query: "echo hi", result: "hi\n", success: true }],
    });
  });

  it("reads usage, completion, and the terminal run result", () => {
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: { type: "usage", inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
        }),
      ),
    ).toEqual({
      kind: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        totalCostUsd: null,
      },
    });
    expect(
      parseClineNdjsonLine(
        line({ type: "agent_event", event: { type: "done", reason: "completed", text: "ok" } }),
      ),
    ).toEqual({ kind: "done", reason: "completed", text: "ok" });
    const result = parseClineNdjsonLine(
      line({
        type: "run_result",
        finishReason: "completed",
        usage: { inputTokens: 10, outputTokens: 2, totalCost: 0 },
        text: "ok",
        model: { id: "poolside/laguna-s-2.1:free", provider: "cline" },
      }),
    );
    expect(result).toMatchObject({
      kind: "runResult",
      finishReason: "completed",
      text: "ok",
      modelId: "poolside/laguna-s-2.1:free",
      modelProvider: "cline",
    });
  });

  it("ignores hooks, duplicate ends, unknown frames, and bad lines", () => {
    expect(
      parseClineNdjsonLine(line({ type: "hook_event", hookEventName: "agent_start" })),
    ).toEqual({ kind: "ignored" });
    expect(
      parseClineNdjsonLine(
        line({
          type: "agent_event",
          event: { type: "content_end", contentType: "text", text: "ok" },
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(
      parseClineNdjsonLine(line({ type: "agent_event", event: { type: "future_frame" } })),
    ).toEqual({ kind: "ignored" });
    expect(parseClineNdjsonLine("not json")).toEqual({ kind: "ignored" });
  });

  it("surfaces stderr error lines", () => {
    expect(parseClineNdjsonLine(line({ type: "error", message: "No cookie auth" }))).toEqual({
      kind: "error",
      message: "No cookie auth",
    });
  });
});

describe("renderClineToolOutput", () => {
  it("prefers successful stdout and falls back to the query", () => {
    expect(renderClineToolOutput([{ query: "echo hi", result: "hi\n", success: true }])).toBe("hi");
    expect(renderClineToolOutput([{ query: "bad cmd", result: "", success: false }])).toBe(
      "(bad cmd failed)",
    );
  });
});
