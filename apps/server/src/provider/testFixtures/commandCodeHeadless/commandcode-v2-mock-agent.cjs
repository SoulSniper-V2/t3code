#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const sessionId = process.env.T3_CC_V2_SESSION || "cc-v2-session-1";
const mode = process.env.T3_CC_V2_MODE || "success";
const argv = process.argv.slice(2);
const modIndex = argv.indexOf("--mod");
const modPath = modIndex >= 0 ? argv[modIndex + 1] : null;
let modSource = "";
if (modPath) {
  try {
    modSource = fs.readFileSync(modPath, "utf8");
  } catch {}
}
let prompt = "";

const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (process.env.T3_CC_V2_LOG) {
    fs.appendFileSync(
      process.env.T3_CC_V2_LOG,
      `${JSON.stringify({
        argv,
        prompt,
        modPath,
        modExistsDuringTurn: modSource.length > 0,
        modContainsAuthorization: Boolean(
          process.env.T3_CODE_MCP_AUTHORIZATION &&
          modSource.includes(process.env.T3_CODE_MCP_AUTHORIZATION),
        ),
        mcpEndpointPresent: Boolean(process.env.T3_CODE_MCP_ENDPOINT),
        mcpAuthorizationPresent: Boolean(process.env.T3_CODE_MCP_AUTHORIZATION),
      })}\n`,
    );
  }

  emit({ type: "event", event: { type: "run_start", sessionId } });
  emit({ type: "event", event: { type: "message_start" } });
  emit({ type: "event", event: { type: "text_delta", delta: "V2 says hi" } });
  if (mode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "tools") {
    emit({
      type: "event",
      event: {
        type: "tool_queued",
        toolCallId: "tool-1",
        toolName: "shell_command",
        input: { command: "pwd" },
      },
    });
    emit({
      type: "event",
      event: { type: "tool_completed", toolCallId: "tool-1", toolName: "shell_command" },
    });
  }
  emit({ type: "event", event: { type: "message_end" } });
  if (mode === "error") {
    emit({ type: "result", subtype: "error", sessionId, error: "mock provider failure" });
    process.exitCode = 10;
    return;
  }
  emit({
    type: "result",
    subtype: "success",
    sessionId,
    stopReason: "end_turn",
    usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    finalText: "V2 says hi",
  });
});
