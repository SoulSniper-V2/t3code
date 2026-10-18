import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const HopliteSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("hoplite").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Hoplite CLI binary.",
        providerSettingsForm: { placeholder: "hoplite", clearWhenEmpty: "omit" },
      }),
    ),
    projectId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Hoplite project",
        description:
          "Leave blank to use the Hoplite project linked to each repository's GitHub remote.",
        providerSettingsForm: { placeholder: "proj_…", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "projectId"],
  },
);
export type HopliteSettings = typeof HopliteSettings.Type;
