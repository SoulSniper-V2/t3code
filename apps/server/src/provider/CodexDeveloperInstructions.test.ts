import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexDeveloperInstructions", () => {
  it("provides only the selected collaboration mode", () => {
    NodeAssert.match(buildCodexDeveloperInstructions("default"), /^<collaboration_mode>/);
    NodeAssert.match(buildCodexDeveloperInstructions("plan"), /^<collaboration_mode># Plan Mode/);
    NodeAssert.doesNotMatch(buildCodexDeveloperInstructions("default"), /T3 Code/);
  });
});

describe("buildCodexAdditionalContext", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("adds runtime, orchestration, and only the attached product tools", () => {
    const context = buildCodexAdditionalContext(runtime, { browser: true, device: true });

    NodeAssert.match(
      context.t3_code_runtime.value,
      /You are running inside T3 Code through the Codex harness/,
    );
    NodeAssert.match(context.t3_code_runtime.value, /as gpt-5\.3-codex with high reasoning effort/);
    NodeAssert.match(context.t3_code_orchestration.value, /Use `delegate_task`/);
    NodeAssert.match(context.t3_code_orchestration.value, /structured object, never as JSON text/);
    NodeAssert.match(context.t3_code_tools?.value ?? "", /preview_status/);
    NodeAssert.match(context.t3_code_tools?.value ?? "", /device_open/);
  });

  it("does not mention browser or device tools when they are not attached", () => {
    const context = buildCodexAdditionalContext(runtime, { browser: false, device: false });

    NodeAssert.doesNotMatch(context.t3_code_tools?.value ?? "", /preview_status|preview_open/);
    NodeAssert.doesNotMatch(context.t3_code_tools?.value ?? "", /device_open/);
    NodeAssert.match(context.t3_code_orchestration.value, /Use `delegate_task`/);
  });

  it("tracks the model and reasoning effort supplied for each turn", () => {
    const first = buildCodexAdditionalContext({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexAdditionalContext({ model: "gpt-5.4", reasoningEffort: "high" });

    NodeAssert.notEqual(first.t3_code_runtime.value, second.t3_code_runtime.value);
  });

  it("flattens multiline runtime metadata", () => {
    const context = buildCodexAdditionalContext({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(
      context.t3_code_runtime.value,
      /as gpt 5\.3 codex with high effort reasoning effort/,
    );
    NodeAssert.doesNotMatch(context.t3_code_runtime.value, /<runtime_info>[^<]*\n/);
  });
});
