import { expect, it } from "vitest";

import { ProviderDriverKind, UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders.ts";

const usageProviders = [
  "codex",
  "claude",
  "grok",
  "commandcode",
  "cline",
  "cursor",
  "opencode",
  "antigravity",
] as const;

it("keeps usage provider contracts and icon presentations aligned", () => {
  for (const provider of usageProviders) {
    expect(Schema.is(UsageProviderKind)(provider)).toBe(true);
    expect(PROVIDER_PRESENTATION[provider].driverKind).toBe(
      ProviderDriverKind.make(
        provider === "claude"
          ? "claudeAgent"
          : provider === "commandcode"
            ? "commandCode"
            : provider,
      ),
    );
  }
  expect(PROVIDER_ORDER).toEqual(usageProviders);
});

it("orders only providers with actual token or cost usage", () => {
  expect(
    providersWithUsage([
      { provider: "codex", costUsd: 0, totalTokens: 0 },
      { provider: "cline", costUsd: 0, totalTokens: 12 },
      { provider: "opencode", costUsd: 0.02, totalTokens: 0 },
    ]),
  ).toEqual(["cline", "opencode"]);
});
