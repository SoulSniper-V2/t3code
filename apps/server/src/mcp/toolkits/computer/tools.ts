import {
  ComputerAccessibilityTreeInput,
  ComputerAccessibilityTreeResult,
  ComputerActivateAppInput,
  ComputerActivateAppResult,
  ComputerClickInput,
  ComputerClickResult,
  ComputerListAppsResult,
  ComputerPressKeyInput,
  ComputerPressKeyResult,
  ComputerScreenshotInput,
  ComputerScreenshotResult,
  ComputerToolError,
  ComputerTypeInput,
  ComputerTypeResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "Capture a full-resolution screenshot of the native desktop display. Returns the PNG image and dimensions.",
  parameters: ComputerScreenshotInput,
  success: ComputerScreenshotResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Desktop screenshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerAppsTool = Tool.make("computer_apps", {
  description:
    "List running native GUI applications on the host desktop with their names, process IDs, and bundle IDs.",
  parameters: Schema.Struct({}),
  success: ComputerListAppsResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "List native applications")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerActivateAppTool = Tool.make("computer_activate_app", {
  description:
    "Bring a native application window to the foreground by name, bundle ID, or process ID.",
  parameters: ComputerActivateAppInput,
  success: ComputerActivateAppResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Activate application")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerClickTool = Tool.make("computer_click", {
  description:
    "Click at native desktop screen coordinates (x, y) with left, right, or double-click.",
  parameters: ComputerClickInput,
  success: ComputerClickResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Click screen coordinates")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerTypeTool = Tool.make("computer_type", {
  description: "Insert literal text into the currently active native window or focused field.",
  parameters: ComputerTypeInput,
  success: ComputerTypeResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Type native text")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerPressKeyTool = Tool.make("computer_press_key", {
  description:
    "Press a keyboard key or shortcut (e.g. Return, Tab, Escape, space) with optional modifiers (command, shift, control, option).",
  parameters: ComputerPressKeyInput,
  success: ComputerPressKeyResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Press native key")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerAccessibilityTreeTool = Tool.make("computer_accessibility_tree", {
  description:
    "Inspect the native accessibility hierarchy (UI elements, buttons, text fields, menus, bounds) of the active application.",
  parameters: ComputerAccessibilityTreeInput,
  success: ComputerAccessibilityTreeResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect accessibility tree")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerAppsTool,
  ComputerActivateAppTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerPressKeyTool,
  ComputerAccessibilityTreeTool,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);

export const ComputerToolkit = Toolkit.make(
  ComputerScreenshotTool,
  ComputerAppsTool,
  ComputerActivateAppTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerPressKeyTool,
  ComputerAccessibilityTreeTool,
);
