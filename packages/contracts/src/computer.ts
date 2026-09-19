/**
 * Computer - Schemas for native OS computer use and automation.
 *
 * Exposes native desktop OS inspection, app activation, screenshots,
 * accessibility element inspection, clicks, typing, and key presses to agents
 * through the `computer_*` MCP tools.
 *
 * @module Computer
 */
import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const ComputerMouseButton = Schema.Literals(["left", "right", "double"]);
export type ComputerMouseButton = typeof ComputerMouseButton.Type;

export const ComputerModifierKey = Schema.Literals([
  "command",
  "control",
  "option",
  "alt",
  "shift",
]);
export type ComputerModifierKey = typeof ComputerModifierKey.Type;

export const ComputerAppInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  bundleId: Schema.optional(TrimmedString),
  pid: Schema.Int,
  active: Schema.Boolean,
  path: Schema.optional(TrimmedString),
});
export type ComputerAppInfo = typeof ComputerAppInfo.Type;

export const ComputerListAppsResult = Schema.Struct({
  apps: Schema.Array(ComputerAppInfo),
});
export type ComputerListAppsResult = typeof ComputerListAppsResult.Type;

export const ComputerActivateAppInput = Schema.Struct({
  name: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Application name, e.g. Safari, Xcode, Slack" }),
  ),
  bundleId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "macOS bundle ID, e.g. com.apple.Safari",
    }),
  ),
  pid: Schema.optional(Schema.Int.annotate({ description: "Process ID" })),
});
export type ComputerActivateAppInput = typeof ComputerActivateAppInput.Type;

export const ComputerActivateAppResult = Schema.Struct({
  success: Schema.Boolean,
  name: TrimmedNonEmptyString,
  pid: Schema.optional(Schema.Int),
});
export type ComputerActivateAppResult = typeof ComputerActivateAppResult.Type;

export const ComputerScreenshotInput = Schema.Struct({
  save: Schema.optional(
    Schema.Boolean.annotate({
      description: "Save the screenshot to an evidence file on disk and return its path.",
    }),
  ),
  includeImage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include the raw image bytes in the tool result (default true).",
    }),
  ),
});
export type ComputerScreenshotInput = typeof ComputerScreenshotInput.Type;

export const ComputerScreenshotDimensions = Schema.Struct({
  width: NonNegativeInt,
  height: NonNegativeInt,
  scaleFactor: Schema.optional(Schema.Number),
});
export type ComputerScreenshotDimensions = typeof ComputerScreenshotDimensions.Type;

export const ComputerScreenshotResult = Schema.Struct({
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: NonNegativeInt,
    height: NonNegativeInt,
  }),
  screenshotPath: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerScreenshotResult = typeof ComputerScreenshotResult.Type;

export const ComputerClickInput = Schema.Struct({
  x: Schema.Number.annotate({ description: "X coordinate in screen points" }),
  y: Schema.Number.annotate({ description: "Y coordinate in screen points" }),
  button: Schema.optional(
    ComputerMouseButton.annotate({
      description: "Mouse button: left, right, or double (default left)",
    }),
  ),
});
export type ComputerClickInput = typeof ComputerClickInput.Type;

export const ComputerClickResult = Schema.Struct({
  success: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  button: ComputerMouseButton,
});
export type ComputerClickResult = typeof ComputerClickResult.Type;

export const ComputerTypeInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Text to type into the currently focused window" }),
});
export type ComputerTypeInput = typeof ComputerTypeInput.Type;

export const ComputerTypeResult = Schema.Struct({
  success: Schema.Boolean,
  charactersTyped: NonNegativeInt,
});
export type ComputerTypeResult = typeof ComputerTypeResult.Type;

export const ComputerPressKeyInput = Schema.Struct({
  key: TrimmedNonEmptyString.annotate({
    description: "Key name such as Return, Tab, Escape, Space, or single letter",
  }),
  modifiers: Schema.optional(
    Schema.Array(ComputerModifierKey).annotate({
      description: "Modifier keys held, e.g. ['command'], ['command', 'shift']",
    }),
  ),
});
export type ComputerPressKeyInput = typeof ComputerPressKeyInput.Type;

export const ComputerPressKeyResult = Schema.Struct({
  success: Schema.Boolean,
  key: TrimmedNonEmptyString,
  modifiers: Schema.Array(ComputerModifierKey),
});
export type ComputerPressKeyResult = typeof ComputerPressKeyResult.Type;

export const ComputerAccessibilityElement = Schema.Struct({
  role: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedString),
  description: Schema.optional(TrimmedString),
  value: Schema.optional(TrimmedString),
  bounds: Schema.optional(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
});
export type ComputerAccessibilityElement = typeof ComputerAccessibilityElement.Type;

export const ComputerAccessibilityTreeInput = Schema.Struct({
  appName: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Target application name. Defaults to the frontmost active application.",
    }),
  ),
});
export type ComputerAccessibilityTreeInput = typeof ComputerAccessibilityTreeInput.Type;

export const ComputerAccessibilityTreeResult = Schema.Struct({
  activeApp: TrimmedNonEmptyString,
  elements: Schema.Array(ComputerAccessibilityElement),
});
export type ComputerAccessibilityTreeResult = typeof ComputerAccessibilityTreeResult.Type;

export class ComputerToolError extends Schema.TaggedError<ComputerToolError>()(
  "ComputerToolError",
  {
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Native computer action '${this.operation}' failed: ${this.detail}`;
  }
}
