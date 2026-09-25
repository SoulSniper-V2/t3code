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
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            label: "Reasoning effort",
            type: "select",
            options: expect.arrayContaining([
              { id: "default", label: "Provider default", isDefault: true },
              { id: "none", label: "None" },
              { id: "low", label: "Low" },
              { id: "xhigh", label: "Extra high" },
            ]),
          },
        ],
      },
    });
    expect(models[1]).not.toHaveProperty("isDefault");
    expect(models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "thinkingLevel",
    });
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

  it("puts the configured model first and defaults the model picker to it with empty history", () => {
    const models = parseClineHistoryModels(
      "[]",
      { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
      "high",
    );

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      slug: "anthropic/claude-sonnet-4.6",
      subProvider: "openrouter",
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            currentValue: "high",
            options: expect.arrayContaining([{ id: "high", label: "High", isDefault: true }]),
          },
        ],
      },
    });
  });

  it("marks the saved model default even when another model is newest in history", () => {
    const models = parseClineHistoryModels(
      JSON.stringify([
        { provider: "cline", model: "different/recent-model" },
        { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      ]),
      { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
    );

    expect(models.map((model) => model.slug)).toEqual([
      "different/recent-model",
      "anthropic/claude-sonnet-4.6",
    ]);
    expect(models.map((model) => model.isDefault ?? false)).toEqual([false, true]);
  });
});
