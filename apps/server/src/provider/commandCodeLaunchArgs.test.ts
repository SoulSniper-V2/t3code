import { describe, expect, it } from "@effect/vitest";

import { commandCodeTurnArgs } from "./commandCodeLaunchArgs.ts";

describe("commandCodeTurnArgs", () => {
  it("passes an explicitly selected effort and per-run mod path", () => {
    const args = commandCodeTurnArgs({
      permissionMode: "auto-accept",
      model: "vendor/model",
      reasoningEffort: "xhigh",
      resumeSessionId: "session-1",
      modPath: "/tmp/t3-code-mcp/mod.ts",
    });

    expect(args).toContain("--effort");
    expect(args).toContain("xhigh");
    expect(args).toContain("--mod");
    expect(args).toContain("/tmp/t3-code-mcp/mod.ts");
    expect(args).toContain("--resume");
  });

  it("leaves Command Code's effort default alone and preserves CLI rejection for selected values", () => {
    expect(
      commandCodeTurnArgs({ permissionMode: "standard", reasoningEffort: "default" }),
    ).not.toContain("--effort");
    expect(
      commandCodeTurnArgs({ permissionMode: "standard", reasoningEffort: "model-specific" }),
    ).toContain("model-specific");
  });
});
