import { describe, expect, it } from "@effect/vitest";

import { buildCommandCodePrompt } from "./commandCodePrompt.ts";

describe("buildCommandCodePrompt", () => {
  it("prepends T3 runtime identity and selected model context to the user prompt", () => {
    const prompt = buildCommandCodePrompt({
      prompt: "Please inspect this project.",
      model: "vendor/model-x",
      reasoningEffort: "high",
    });

    expect(prompt).toContain(
      "You are running inside T3 Code through the Command Code harness, as vendor/model-x with high reasoning effort.",
    );
    expect(prompt).toContain("<pull_request_linking>");
    expect(prompt.endsWith("\n\nPlease inspect this project.")).toBe(true);
  });

  it("does not invent model or effort details when they are not selected", () => {
    const prompt = buildCommandCodePrompt({ prompt: "Continue." });

    expect(prompt).toContain("through the Command Code harness.");
    expect(prompt).not.toContain("as undefined");
    expect(prompt).not.toContain("reasoning effort");
    expect(prompt.endsWith("\n\nContinue.")).toBe(true);
  });
});
