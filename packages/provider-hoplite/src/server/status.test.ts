import type * as EffectAcpSchema from "effect-acp/compat";
import { describe, expect, it } from "vite-plus/test";

import { hopliteModelsFromConfigOptions } from "./status.ts";

// Trimmed from a real Hoplite `session/new` response.
const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "gpt-6-luna",
    options: [
      { value: "claude-opus-5-5", name: "Opus 5.5", _meta: { hoplite: { supportsFast: false } } },
      { value: "gpt-6-luna", name: "GPT-6 Luna", _meta: { hoplite: { supportsFast: true } } },
      { value: "moonshotai/kimi-k3", name: "Kimi K3", _meta: { hoplite: { supportsFast: false } } },
    ],
  },
  {
    type: "select",
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    currentValue: "medium",
    _meta: { hoplite: { defaultValue: "medium" } },
    options: [
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "xhigh", name: "xhigh" },
    ],
  },
  {
    type: "select",
    id: "speed",
    name: "Speed",
    category: "model_config",
    currentValue: "standard",
    options: [
      { value: "standard", name: "standard" },
      { value: "fast", name: "fast" },
    ],
  },
];

describe("hopliteModelsFromConfigOptions", () => {
  const models = hopliteModelsFromConfigOptions(configOptions);

  it("lists the session's models with the project default marked", () => {
    expect(
      models.map((model) => [model.slug, model.name, model.subProvider, model.isDefault]),
    ).toEqual([
      ["claude-opus-5-5", "Opus 5.5", "Anthropic", undefined],
      ["gpt-6-luna", "GPT-6 Luna", "OpenAI", true],
      ["moonshotai/kimi-k3", "Kimi K3", "Moonshot AI", undefined],
    ]);
  });

  it("keeps Hoplite's option IDs so the ACP adapter writes them back unchanged", () => {
    const luna = models.find((model) => model.slug === "gpt-6-luna");
    expect(luna?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "reasoning",
      "speed",
    ]);
    expect(luna?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "medium",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "xhigh", label: "Extra high" },
      ],
    });
  });

  it("offers the fast tier only on models that have one", () => {
    const opus = models.find((model) => model.slug === "claude-opus-5-5");
    expect(opus?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "reasoning",
    ]);
  });

  it("returns no models when the session advertises none", () => {
    expect(hopliteModelsFromConfigOptions([])).toEqual([]);
  });
});
