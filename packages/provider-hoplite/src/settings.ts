import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const reasoningLevels = [
  "high",
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "xhigh",
  "max",
] as const;

export const HopliteSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    projectId: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Hoplite project ID",
        description: "Cloud project used for new threads. Local workspace files are not uploaded.",
      }),
    ),
    speed: Schema.Literals(["standard", "fast"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("standard" as const)),
      Schema.annotateKey({
        title: "Speed for new threads",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "standard", label: "Standard" },
            { value: "fast", label: "Fast" },
          ],
        },
      }),
    ),
    reasoning: Schema.Literals(reasoningLevels).pipe(
      Schema.withDecodingDefault(Effect.succeed("high" as const)),
      Schema.annotateKey({
        title: "Reasoning for new threads",
        providerSettingsForm: {
          control: "select",
          options: reasoningLevels.map((value) => ({ value, label: value })),
        },
      }),
    ),
    spendLimitUsd: Schema.String.check(Schema.isPattern(/^(?:\d{1,9}(?:\.\d{1,6})?)?$/)).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Thread spend limit (USD)",
        description:
          "Budget for each new cloud thread, in US dollars. Leave blank or enter 0 for no limit.",
      }),
    ),
  },
  { order: ["projectId", "speed", "reasoning", "spendLimitUsd"] },
);
export type HopliteSettings = typeof HopliteSettings.Type;
