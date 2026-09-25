import { describe, expect, it } from "vite-plus/test";

import { parseCommandCodeModelList, parseCommandCodeProvidersJson } from "./commandCodeModels.ts";

const SAMPLE_LIST = `Available models  ·  3 models

Open Source

deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
z-ai/glm-5.3-flash           fast, affordable GLM coding with 1M context

Anthropic

claude-sonnet-5   best combo of speed & intelligence (recommended)
`;

describe("parseCommandCodeModelList", () => {
  it("parses slugs and drops category headers", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST);
    expect(models.map((model) => model.slug)).toEqual([
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.3-flash",
      "claude-sonnet-5",
    ]);
    expect(models.every((model) => model.isCustom === false)).toBe(true);
  });

  it("marks the explicitly-default row, not the first row", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST);
    expect(models.find((model) => model.isDefault === true)?.slug).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("falls back to the first row as default when no row is marked", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST.replace("(default)", "(recommended)"));
    expect(models.find((model) => model.isDefault === true)?.slug).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("tolerates ANSI colors and windows line endings", () => {
    const models = parseCommandCodeModelList(
      "\u001b[32mdeepseek/deepseek-v4-flash\u001b[39m   hybrid-attention (default)\r\n" +
        "claude-sonnet-5   recommended\r\n",
    );
    expect(models.map((model) => model.slug)).toEqual([
      "deepseek/deepseek-v4-flash",
      "claude-sonnet-5",
    ]);
  });

  it("returns an empty list for garbage output", () => {
    expect(parseCommandCodeModelList("")).toEqual([]);
    expect(parseCommandCodeModelList("Anthropic\n\nOpen Source\n")).toEqual([]);
  });
});

describe("Command Code reasoning metadata", () => {
  it("adds the documented generic efforts only to listed reasoning-capable models", () => {
    const models = parseCommandCodeModelList(
      [
        "Available models · 2 models",
        "Open Source",
        "deepseek/deepseek-v4-flash   fast reasoning (default)",
        "vendor/plain-chat            fast",
      ].join("\n"),
    );

    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "effort",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Provider default", isDefault: true },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
        { id: "max", label: "Maximum" },
      ],
    });
    expect(models[1]?.capabilities).toBeNull();
  });

  it("uses BYOK exact levels and does not infer generic levels for a BYOK model", () => {
    const byok = parseCommandCodeProvidersJson(
      JSON.stringify({
        provider: {
          local: {
            apiKey: "this must never be returned",
            baseURL: "https://provider.example",
            models: {
              "deepseek-v4": { reasoningEfforts: ["high", "xhigh", "unknown", "high"] },
              "plain-model": { reasoning: false },
              "default-model": {},
            },
          },
          hosted: { models: { "generic-reasoner": { reasoning: true } } },
        },
      }),
    );
    const models = parseCommandCodeModelList(
      [
        "local/deepseek-v4   reasoning (default)",
        "local/plain-model   reasoning",
        "local/default-model   reasoning",
        "hosted/generic-reasoner   reasoning",
      ].join("\n"),
      byok,
    );

    expect(models.map((model) => model.capabilities?.optionDescriptors?.[0]?.type ?? null)).toEqual(
      ["select", null, null, "select"],
    );
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [{ id: "default", isDefault: true }, { id: "high" }, { id: "xhigh" }],
    });
    expect(models[3]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [
        { id: "default", isDefault: true },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
      ],
    });
    expect(JSON.stringify(byok)).not.toContain("this must never be returned");
  });

  it("ignores malformed BYOK JSON and malformed capability values", () => {
    expect(parseCommandCodeProvidersJson("not JSON").size).toBe(0);
    expect(
      parseCommandCodeProvidersJson(
        JSON.stringify({ provider: { p: { models: { m: { reasoningEfforts: "high" } } } } }),
      ).get("p/m"),
    ).toEqual([]);
  });
});
