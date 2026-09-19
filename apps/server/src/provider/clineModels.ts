/**
 * clineModels — parse `cline history --json` output into the snapshot's
 * model list.
 *
 * Cline has no model-catalog command, so T3 advertises whatever the local
 * CLI has actually run: distinct `(provider, model)` pairs from recent
 * history entries, newest first. Entries with a `~`-prefixed model never
 * resolved a real model (failed runs); they are skipped. On a fresh machine
 * with no runs yet the list is empty and `customModels` carries the picker.
 *
 * @module provider/clineModels
 */
import type { ServerProviderModel } from "@t3tools/contracts";

/** Unresolved fallback models are prefixed with `~` (failed runs). */
export function isUnresolvedClineModel(model: string): boolean {
  return model.startsWith("~");
}

interface ClineHistoryEntry {
  readonly provider?: unknown;
  readonly model?: unknown;
}

/** Parse one `cline history --json` document into advertised models. */
export function parseClineHistoryModels(output: string): ReadonlyArray<ServerProviderModel> {
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
      ...(typeof provider === "string" && provider.trim().length > 0
        ? { subProvider: provider.trim() }
        : {}),
      isCustom: false,
      capabilities: null,
      ...(models.length === 0 ? { isDefault: true } : {}),
    });
  }
  return models;
}
