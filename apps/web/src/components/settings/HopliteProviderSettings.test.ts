import { describe, expect, it } from "vite-plus/test";
import { hopliteClient } from "@t3tools/provider-hoplite/client";
import { HopliteSettings } from "@t3tools/provider-hoplite/settings";
import * as Schema from "effect/Schema";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

const decodeSettings = Schema.decodeUnknownSync(HopliteSettings);
const isSettings = Schema.is(HopliteSettings);

describe("Hoplite provider settings", () => {
  it("uses constrained choices whose displayed defaults match the server", () => {
    const defaults = decodeSettings({});
    const fields = deriveProviderSettingsFields(hopliteClient);
    for (const key of ["reasoning", "speed"] as const) {
      const field = fields.find((entry) => entry.key === key)!;
      expect(field.control).toBe("select");
      expect(field.options?.[0]?.value).toBe(defaults[key]);
      const updated = nextProviderConfigWithFieldValue({}, field, field.options![1]!.value);
      expect(decodeSettings(updated)[key]).toBe(field.options![1]!.value);
    }
  });

  it("preserves decimal dollar input through the settings form without exposing credentials", () => {
    const fields = deriveProviderSettingsFields(hopliteClient);
    const budget = fields.find((field) => field.key === "spendLimitUsd")!;
    const updated = nextProviderConfigWithFieldValue({}, budget, "2.50");
    expect(decodeSettings(updated).spendLimitUsd).toBe("2.50");
    expect(fields.some((field) => /key|token/i.test(field.key))).toBe(false);
    expect(
      isSettings({
        ...decodeSettings({}),
        spendLimitUsd: "-1",
      }),
    ).toBe(false);
  });
});
