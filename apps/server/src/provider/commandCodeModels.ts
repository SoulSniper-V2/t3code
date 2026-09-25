/**
 * commandCodeModels — parse `command-code --list-models` output into the
 * snapshot's model list.
 *
 * Command Code owns its own model routing (plan catalog plus BYOK providers,
 * some of which are other vendors' models), so T3 never hardcodes a catalog:
 * whatever the local CLI can select is what the snapshot advertises.
 *
 * `--list-models` prints a human table:
 *
 * ```
 * Available models  ·  69 models
 *
 * Open Source
 *
 * deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
 * ...
 * ```
 *
 * @module provider/commandCodeModels
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

// oxlint-disable-next-line eslint/no-control-regex -- ANSI color sequences begin with the ESC control byte.
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;

/** Slug charset: letters, digits, and the separators real ids use (`/`, `:`, `.`, `-`, `_`, `+`). */
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

/** Effort values documented by Command Code's CLI and BYOK schema. */
export const COMMAND_CODE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LABELS: Readonly<Record<(typeof COMMAND_CODE_REASONING_EFFORTS)[number], string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export type CommandCodeByokReasoning = ReadonlyMap<string, ReadonlyArray<string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEfforts(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.filter((candidate): candidate is string => {
    if (
      typeof candidate !== "string" ||
      !COMMAND_CODE_REASONING_EFFORTS.includes(
        candidate as (typeof COMMAND_CODE_REASONING_EFFORTS)[number],
      ) ||
      seen.has(candidate)
    ) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

/**
 * Parse only public model capability metadata from Command Code's BYOK file.
 * Provider endpoints and credential references are deliberately ignored.
 */
export function parseCommandCodeProvidersJson(source: string): CommandCodeByokReasoning {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return new Map();
  }
  if (!isRecord(parsed) || !isRecord(parsed["provider"])) return new Map();

  const result = new Map<string, ReadonlyArray<string>>();
  for (const [providerId, rawProvider] of Object.entries(parsed["provider"])) {
    if (!isRecord(rawProvider) || !isRecord(rawProvider["models"])) continue;
    for (const [modelId, rawModel] of Object.entries(rawProvider["models"])) {
      if (!isRecord(rawModel)) continue;
      const declaredEfforts = validEfforts(rawModel["reasoningEfforts"]);
      const efforts =
        declaredEfforts ??
        (rawModel["reasoning"] === true ? (["low", "medium", "high"] as const) : undefined);
      // Presence in the user's BYOK catalog suppresses the built-in generic
      // fallback even when no effort metadata was declared.
      result.set(`${providerId}/${modelId}`, efforts ?? []);
    }
  }
  return result;
}

function capabilitiesForEfforts(efforts: ReadonlyArray<string>): ModelCapabilities | null {
  const valid = efforts.filter(
    (effort): effort is (typeof COMMAND_CODE_REASONING_EFFORTS)[number] =>
      COMMAND_CODE_REASONING_EFFORTS.includes(
        effort as (typeof COMMAND_CODE_REASONING_EFFORTS)[number],
      ),
  );
  if (valid.length === 0) return null;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "default", label: "Provider default", isDefault: true },
          ...valid.map((id) => ({ id, label: EFFORT_LABELS[id] })),
        ],
        currentValue: "default",
      },
    ],
  });
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * True for the plain category headers (`Open Source`, `Anthropic`, …) that
 * would otherwise be misread as a one-token slug row.
 */
function isCategoryHeader(slug: string, note: string | undefined): boolean {
  if (note !== undefined) return false;
  // Real slugs are lowercase or qualified (provider/model). Headers are
  // capitalized single words with no qualifier.
  return /^[A-Z]/.test(slug) && !slug.includes("/") && !slug.includes(":");
}

export function parseCommandCodeModelList(
  output: string,
  byokReasoning: CommandCodeByokReasoning = new Map(),
): ReadonlyArray<ServerProviderModel> {
  const rows: Array<{ readonly slug: string; readonly note: string | undefined }> = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trimEnd();
    if (line.length === 0 || /^available models/i.test(line)) {
      continue;
    }
    const match = line.match(/^(\S+)(?:\s{2,}(.*))?$/);
    if (!match) continue;
    const slug = match[1]!;
    const note = match[2]?.trim() || undefined;
    if (!MODEL_SLUG_REGEX.test(slug) || isCategoryHeader(slug, note) || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    rows.push({ slug, note });
  }

  const hasExplicitDefault = rows.some((row) => /\(default\)/i.test(row.note ?? ""));
  return rows.map((row, index) => {
    const isDefault =
      row.note !== undefined && /\(default\)/i.test(row.note)
        ? true
        : !hasExplicitDefault && index === 0;
    return {
      slug: row.slug,
      // Keep the slug as the display name: descriptions are free-form
      // capability prose, and the picker searches both fields anyway.
      name: row.slug,
      isCustom: false,
      capabilities: byokReasoning.has(row.slug)
        ? capabilitiesForEfforts(byokReasoning.get(row.slug) ?? [])
        : /\breasoning\b/i.test(row.note ?? "")
          ? capabilitiesForEfforts(COMMAND_CODE_REASONING_EFFORTS)
          : null,
      ...(isDefault ? { isDefault: true } : {}),
    };
  });
}
