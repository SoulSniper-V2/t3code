/**
 * clineModels — combine the current provider/model setting and
 * `cline history --json` into the snapshot's model list.
 *
 * Cline has no model-catalog command. The currently configured model from
 * `providers.json` is therefore the default; recent history fills in other
 * models. Entries with a `~`-prefixed model never resolved a real model and
 * are skipped. Every advertised model carries the CLI-supported reasoning
 * choices, while an unset per-thread choice still falls back to Cline's
 * provider setting.
 *
 * @module provider/clineModels
 */
import {
  CLINE_THINKING_LEVELS,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";

export const CLINE_THINKING_OPTION_ID = "thinkingLevel";
export const CLINE_PROVIDER_DEFAULT_THINKING_VALUE = "default";

export interface ClineConfiguredModel {
  readonly providerId: string;
  readonly modelId: string;
}

/** The composer can override the CLI's provider-level thinking setting. */
export function clineThinkingOptionDescriptor(
  currentValue: string | undefined,
): ProviderOptionDescriptor {
  const effectiveValue =
    currentValue !== undefined && currentValue.length > 0
      ? currentValue
      : CLINE_PROVIDER_DEFAULT_THINKING_VALUE;
  const options = CLINE_THINKING_LEVELS.map(({ value, label }) => ({
    id: value.length > 0 ? value : CLINE_PROVIDER_DEFAULT_THINKING_VALUE,
    label,
    ...(effectiveValue === (value.length > 0 ? value : CLINE_PROVIDER_DEFAULT_THINKING_VALUE)
      ? { isDefault: true }
      : {}),
  }));
  const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    id: CLINE_THINKING_OPTION_ID,
    label: "Reasoning effort",
    type: "select",
    options,
    currentValue: effectiveValue,
  };
  return descriptor;
}

/** Unresolved fallback models are prefixed with `~` (failed runs). */
export function isUnresolvedClineModel(model: string): boolean {
  return model.startsWith("~");
}

interface ClineHistoryEntry {
  readonly provider?: unknown;
  readonly model?: unknown;
}

/** Parse one `cline history --json` document into advertised models. */
export function parseClineHistoryModels(
  output: string,
  configuredModel?: ClineConfiguredModel | undefined,
  thinkingLevel?: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { provider, model } = entry as ClineHistoryEntry;
    if (typeof model !== "string" || model.trim().length === 0) continue;
    const slug = model.trim();
    if (isUnresolvedClineModel(slug) || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      ...(configuredModel?.modelId === slug
        ? { subProvider: configuredModel.providerId }
        : typeof provider === "string" && provider.trim().length > 0
          ? { subProvider: provider.trim() }
          : {}),
      isCustom: false,
      capabilities: { optionDescriptors: [clineThinkingOptionDescriptor(thinkingLevel)] },
      ...(configuredModel !== undefined
        ? configuredModel.modelId === slug
          ? { isDefault: true }
          : {}
        : models.length === 0
          ? { isDefault: true }
          : {}),
    });
  }

  if (
    configuredModel !== undefined &&
    !isUnresolvedClineModel(configuredModel.modelId) &&
    !seen.has(configuredModel.modelId)
  ) {
    models.unshift({
      slug: configuredModel.modelId,
      name: configuredModel.modelId,
      subProvider: configuredModel.providerId,
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [clineThinkingOptionDescriptor(thinkingLevel)] },
    });
  }

  if (configuredModel !== undefined && !isUnresolvedClineModel(configuredModel.modelId)) {
    // Preserve the selected model's default marker when it appears in history
    // after another, more recent model.
    return models.map((model) =>
      model.slug === configuredModel.modelId ? { ...model, isDefault: true } : model,
    );
  }
  return models;
}
