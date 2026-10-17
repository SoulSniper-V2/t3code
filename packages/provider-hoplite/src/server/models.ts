import type { ServerProviderModel, ProviderOptionDescriptor } from "@t3tools/contracts";
import type { HopliteModelCatalog } from "../api.ts";

export function hopliteModels(catalog: HopliteModelCatalog): ReadonlyArray<ServerProviderModel> {
  return catalog.models.map((model) => {
    const options: ProviderOptionDescriptor[] = [];
    const levels = model.capabilities?.reasoningLevels ?? [];
    if (levels.length)
      options.push({
        id: "reasoningEffort",
        label: "Reasoning (new threads)",
        type: "select",
        description: "The public REST API applies reasoning only when creating a cloud thread.",
        currentValue: levels.includes(catalog.runConfig.defaultReasoning)
          ? catalog.runConfig.defaultReasoning
          : levels[0],
        options: levels.map((id) => ({ id, label: id })),
      });
    if (model.capabilities?.supportsFast)
      options.push({
        id: "speed",
        label: "Speed (new threads)",
        type: "select",
        currentValue: catalog.runConfig.defaultSpeed,
        description: "The public REST API applies speed only when creating a cloud thread.",
        options: [
          { id: "standard", label: "Standard" },
          { id: "fast", label: "Fast" },
        ],
      });
    return {
      slug: model.id,
      name: model.name,
      isDefault: model.id === catalog.runConfig.defaultModelId,
      isCustom: false,
      capabilities: { optionDescriptors: options },
    };
  });
}
