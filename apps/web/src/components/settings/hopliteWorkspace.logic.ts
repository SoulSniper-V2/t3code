export function parseHopliteSpendLimit(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) return undefined;
  const micros = Math.round(Number(normalized) * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : undefined;
}

export function isHopliteResourceMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "HopliteError" &&
    "reason" in error &&
    error.reason === "not_found"
  );
}
