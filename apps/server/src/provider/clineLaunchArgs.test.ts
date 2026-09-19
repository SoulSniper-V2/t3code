import { describe, expect, it } from "vite-plus/test";

import { clineTurnArgs, formatClinePrompt } from "./clineLaunchArgs.ts";

describe("formatClinePrompt", () => {
  it("appends a space to single-word prompts to satisfy Cline CLI's whitespace heuristic", () => {
    expect(formatClinePrompt("hi")).toBe("hi ");
    expect(formatClinePrompt("status")).toBe("status ");
    expect(formatClinePrompt("ok")).toBe("ok ");
  });

  it("leaves prompts with whitespace intact", () => {
    expect(formatClinePrompt("fix the tests")).toBe("fix the tests");
    expect(formatClinePrompt("hi there")).toBe("hi there");
    expect(formatClinePrompt("  hello world  ")).toBe("hello world");
  });

  it("handles empty or blank prompts gracefully", () => {
    expect(formatClinePrompt("")).toBe("Continue. ");
    expect(formatClinePrompt("   ")).toBe("Continue. ");
  });
});

describe("clineTurnArgs", () => {
  it("formats argv with auto-approve, thinking, model, and formatted prompt", () => {
    const args = clineTurnArgs({
      permissionMode: "auto-accept",
      thinkingLevel: "high",
      model: "poolside/laguna-s-2.1:free",
      prompt: "hi",
    });

    expect(args).toEqual([
      "--json",
      "--auto-approve",
      "true",
      "--thinking",
      "high",
      "--model",
      "poolside/laguna-s-2.1:free",
      "--",
      "hi ",
    ]);
  });

  it("passes auto-approve false in standard mode and omits empty thinking", () => {
    const args = clineTurnArgs({
      permissionMode: "standard",
      thinkingLevel: "",
      prompt: "review this code",
    });

    expect(args).toEqual(["--json", "--auto-approve", "false", "--", "review this code"]);
  });
});
