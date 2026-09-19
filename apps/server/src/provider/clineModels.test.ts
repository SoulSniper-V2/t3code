import { describe, expect, it } from "vite-plus/test";

import { parseClineHistoryModels } from "./clineModels.ts";

describe("parseClineHistoryModels", () => {
  it("advertises distinct models newest-first with the latest as default", () => {
    const models = parseClineHistoryModels(
      JSON.stringify([
        { sessionId: "s3", provider: "cline", model: "poolside/laguna-s-2.1:free" },
        { sessionId: "s2", provider: "cline", model: "moonshotai/kimi-k3" },
        { sessionId: "s1", provider: "cline", model: "poolside/laguna-s-2.1:free" },
      ]),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "poolside/laguna-s-2.1:free",
      "moonshotai/kimi-k3",
    ]);
    expect(models[0]).toMatchObject({
      subProvider: "cline",
      isDefault: true,
      isCustom: false,
    });
    expect(models[1]).not.toHaveProperty("isDefault");
  });

  it("skips unresolved fallback models and malformed entries", () => {
    const models = parseClineHistoryModels(
      JSON.stringify([
        { sessionId: "bad", provider: "openrouter", model: "~deepseek/deepseek-flash-latest" },
        { sessionId: "empty", provider: "cline", model: "  " },
        "not-an-entry",
        { sessionId: "good", provider: "cline", model: "anthropic/claude-opus-4-6" },
      ]),
    );

    expect(models.map((model) => model.slug)).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("returns an empty catalog for non-JSON and non-array output", () => {
    expect(parseClineHistoryModels("not json")).toEqual([]);
    expect(parseClineHistoryModels(JSON.stringify({ sessions: [] }))).toEqual([]);
  });
});
