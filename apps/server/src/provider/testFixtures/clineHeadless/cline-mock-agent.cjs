#!/usr/bin/env node
/**
 * cline-mock-agent.cjs — scriptable stand-in for `cline --json`.
 *
 * Reads the piped prompt, then emits the same NDJSON frame family the real
 * CLI emits, so adapter tests can run without an installed Cline.
 * Behavior knobs (env):
 *   T3_MOCK_ARGV_LOG  path to write the received argv as JSON
 *   T3_MOCK_HANG=1    stop emitting after the first text chunk and hold
 *                     the process open until killed (interrupt tests)
 */
"use strict";

const fs = require("node:fs");

const argvLogPath = process.env.T3_MOCK_ARGV_LOG;
const hang = process.env.T3_MOCK_HANG === "1";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (argvLogPath) {
    fs.writeFileSync(argvLogPath, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  }

  const usage = {
    inputTokens: 5925,
    outputTokens: 2,
    cacheReadTokens: 192,
    cacheWriteTokens: 0,
    totalCost: 0,
  };
  const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

  emit({ ts: Date.now(), type: "hook_event", hookEventName: "agent_start" });
  emit({ ts: Date.now(), type: "agent_event", event: { type: "iteration_start", iteration: 1 } });
  emit({
    ts: Date.now(),
    type: "agent_event",
    event: { type: "content_start", contentType: "text", text: "Hola" },
  });

  if (hang) {
    // Keep the process alive briefly: emit nothing more until the test kills
    // us. If the kill does not reach the node process, this bounds the wait.
    process.stdout.write("", () => {
      setTimeout(() => {
        process.exit(0);
      }, 4_000);
    });
    return;
  }

  emit({
    ts: Date.now(),
    type: "agent_event",
    event: {
      type: "content_start",
      contentType: "tool",
      toolCallId: "call-1",
      toolName: "run_commands",
      input: { commands: "echo mundo" },
    },
  });
  emit({
    ts: Date.now(),
    type: "agent_event",
    event: {
      type: "content_end",
      contentType: "tool",
      toolCallId: "call-1",
      toolName: "run_commands",
      output: [{ query: "echo mundo", result: "mundo\n", success: true }],
    },
  });
  emit({ ts: Date.now(), type: "agent_event", event: { type: "usage", ...usage } });
  emit({
    ts: Date.now(),
    type: "agent_event",
    event: { type: "iteration_end", iteration: 1, hadToolCalls: true, toolCallCount: 1 },
  });
  emit({
    ts: Date.now(),
    type: "agent_event",
    event: { type: "done", reason: "completed", text: "Hola, mundo", iterations: 1, usage },
  });
  emit({
    ts: Date.now(),
    type: "run_result",
    finishReason: "completed",
    iterations: 1,
    usage,
    aggregateUsage: usage,
    durationMs: 10,
    text: "Hola, mundo",
    model: { id: "poolside/laguna-s-2.1:free", provider: "cline" },
  });
});
