// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ComputerAccessibilityTreeResult,
  type ComputerActivateAppInput,
  type ComputerActivateAppResult,
  type ComputerAppInfo,
  type ComputerClickInput,
  type ComputerClickResult,
  type ComputerListAppsResult,
  type ComputerPressKeyInput,
  type ComputerPressKeyResult,
  type ComputerScreenshotInput,
  type ComputerScreenshotResult,
  ComputerToolError,
  type ComputerTypeInput,
  type ComputerTypeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ComputerAccessibilityTreeTool,
  ComputerActivateAppTool,
  ComputerAppsTool,
  ComputerClickTool,
  ComputerPressKeyTool,
  ComputerScreenshotTool,
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
  ComputerToolkit,
  ComputerTypeTool,
} from "./tools.ts";

const requireComputerAccess = McpInvocationContext.requireMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new ComputerToolError({
        operation: "computer_access",
        detail: "Native OS computer access is turned off for this environment.",
      }),
  ),
);

function findCuaDriverPath(): string | undefined {
  const custom = process.env.CUA_DRIVER_PATH?.trim();
  if (custom && NodeFS.existsSync(custom)) return custom;
  const localBin = NodePath.join(NodeOS.homedir(), ".local", "bin", "cua-driver");
  if (NodeFS.existsSync(localBin)) return localBin;
  const globalHomebrew = "/opt/homebrew/bin/cua-driver";
  if (NodeFS.existsSync(globalHomebrew)) return globalHomebrew;
  return undefined;
}

function runCommandSync(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = 15_000,
): { stdout: string; stderr: string; code: number } {
  try {
    const result = NodeChildProcess.spawnSync(command, args as string[], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      code: result.status ?? (result.signal ? 137 : 1),
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
    };
  }
}

function runJxa(script: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

export const ComputerScreenshotHandler = (input: ComputerScreenshotInput) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const platform = yield* HostProcessPlatform;

    // 1. If cua-driver exists, call get_desktop_state
    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const res = runCommandSync(cuaPath, ["call", "get_desktop_state", "{}"], 15_000);
      if (res.code === 0 && res.stdout.trim().length > 0) {
        try {
          const parsed = JSON.parse(res.stdout);
          const base64 = parsed.screenshot || parsed.data;
          const width = parsed.screenshot_width || parsed.width || 1920;
          const height = parsed.screenshot_height || parsed.height || 1080;
          if (typeof base64 === "string" && base64.length > 0) {
            let screenshotPath: string | undefined;
            if (input.save) {
              const tempPath = NodePath.join(
                NodeOS.tmpdir(),
                `t3-desktop-screenshot-${Date.now()}.png`,
              );
              NodeFS.writeFileSync(tempPath, Buffer.from(base64, "base64"));
              screenshotPath = tempPath;
            }
            return {
              screenshot: {
                mimeType: "image/png" as const,
                data: base64,
                width,
                height,
              },
              ...(screenshotPath ? { screenshotPath } : {}),
            } satisfies ComputerScreenshotResult;
          }
        } catch {
          // fall through to native capture
        }
      }
    }

    // 2. macOS native capture via screencapture
    if (platform === "darwin") {
      const tempPath = NodePath.join(NodeOS.tmpdir(), `t3-computer-screenshot-${Date.now()}.png`);
      const res = runCommandSync("/usr/sbin/screencapture", ["-x", "-t", "png", tempPath], 15_000);
      if (res.code !== 0 || !NodeFS.existsSync(tempPath)) {
        return yield* new ComputerToolError({
          operation: "computer_screenshot",
          detail: `screencapture failed: ${res.stderr || "Screen recording permission required."}`,
        });
      }
      try {
        const buffer = NodeFS.readFileSync(tempPath);
        let width = 1920;
        let height = 1080;
        try {
          const sips = runCommandSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", tempPath]);
          const wMatch = sips.stdout.match(/pixelWidth:\s+(\d+)/);
          const hMatch = sips.stdout.match(/pixelHeight:\s+(\d+)/);
          if (wMatch?.[1]) width = Number.parseInt(wMatch[1], 10);
          if (hMatch?.[1]) height = Number.parseInt(hMatch[1], 10);
        } catch {
          // keep fallback dimensions
        }
        if (!input.save) {
          try {
            NodeFS.unlinkSync(tempPath);
          } catch {
            // ignore cleanup failure
          }
        }
        return {
          screenshot: {
            mimeType: "image/png" as const,
            data: buffer.toString("base64"),
            width,
            height,
          },
          ...(input.save ? { screenshotPath: tempPath } : {}),
        } satisfies ComputerScreenshotResult;
      } catch (error) {
        return yield* new ComputerToolError({
          operation: "computer_screenshot",
          detail: String(error),
        });
      }
    }

    return yield* new ComputerToolError({
      operation: "computer_screenshot",
      detail: `Desktop screenshot is not supported on platform: ${platform}`,
    });
  });

export const ComputerAppsHandler = () =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const platform = yield* HostProcessPlatform;

    // 1. Try cua-driver
    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const res = runCommandSync(cuaPath, ["call", "list_apps", '{"running_only":true}'], 10_000);
      if (res.code === 0 && res.stdout.trim().length > 0) {
        try {
          const parsed = JSON.parse(res.stdout);
          const apps = (parsed.apps || []).map((app: Record<string, unknown>) => ({
            name: String(app.name || "Unknown"),
            bundleId: typeof app.bundle_id === "string" ? app.bundle_id : undefined,
            pid: typeof app.pid === "number" ? app.pid : 0,
            active: Boolean(app.active),
            path: typeof app.launch_path === "string" ? app.launch_path : undefined,
          }));
          return { apps } satisfies ComputerListAppsResult;
        } catch {
          // fall through
        }
      }
    }

    // 2. macOS JXA fallback
    if (platform === "darwin") {
      const script = `
ObjC.import("AppKit");
function run() {
  const ws = $.NSWorkspace.sharedWorkspace;
  const running = ws.runningApplications;
  const front = ws.frontmostApplication;
  const frontPid = front.isNil() ? -1 : front.processIdentifier;
  const list = [];
  for (let i = 0; i < running.count; i++) {
    const a = running.objectAtIndex(i);
    if (a.activationPolicy === $.NSApplicationActivationPolicyRegular) {
      list.push({
        name: a.localizedName.isNil() ? "Unknown" : a.localizedName.js,
        bundleId: a.bundleIdentifier.isNil() ? "" : a.bundleIdentifier.js,
        pid: a.processIdentifier,
        active: a.processIdentifier === frontPid,
        path: a.bundleURL.isNil() ? "" : a.bundleURL.path.js
      });
    }
  }
  return JSON.stringify(list);
}
`;
      const output = yield* Effect.tryPromise({
        try: () => runJxa(script),
        catch: (cause) =>
          new ComputerToolError({ operation: "computer_apps", detail: String(cause) }),
      });
      try {
        const rawList = JSON.parse(output);
        const apps: ComputerAppInfo[] = rawList.map((app: Record<string, unknown>) => ({
          name: String(app.name || "Unknown"),
          bundleId: typeof app.bundleId === "string" && app.bundleId ? app.bundleId : undefined,
          pid: typeof app.pid === "number" ? app.pid : 0,
          active: Boolean(app.active),
          path: typeof app.path === "string" && app.path ? app.path : undefined,
        }));
        return { apps } satisfies ComputerListAppsResult;
      } catch (error) {
        return yield* new ComputerToolError({
          operation: "computer_apps",
          detail: `Failed to parse applications: ${String(error)}`,
        });
      }
    }

    return { apps: [] } satisfies ComputerListAppsResult;
  });

export const ComputerActivateAppHandler = (input: ComputerActivateAppInput) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const platform = yield* HostProcessPlatform;

    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const payload: Record<string, unknown> = {};
      if (input.bundleId) payload.bundle_id = input.bundleId;
      if (input.name) payload.name = input.name;
      if (input.pid) payload.pid = input.pid;
      const res = runCommandSync(
        cuaPath,
        ["call", "bring_to_front", JSON.stringify(payload)],
        10_000,
      );
      if (res.code === 0) {
        return {
          success: true,
          name: input.name || input.bundleId || `pid:${input.pid}`,
          pid: input.pid,
        } satisfies ComputerActivateAppResult;
      }
    }

    if (platform === "darwin") {
      const targetName = input.name ? input.name.replaceAll('"', '\\"') : "";
      const targetBundleId = input.bundleId ? input.bundleId.replaceAll('"', '\\"') : "";
      const targetPid = input.pid;
      const script = `
ObjC.import("AppKit");
function run() {
  const ws = $.NSWorkspace.sharedWorkspace;
  const running = ws.runningApplications;
  for (let i = 0; i < running.count; i++) {
    const a = running.objectAtIndex(i);
    let matched = false;
    ${targetPid ? `if (a.processIdentifier === ${targetPid}) matched = true;` : ""}
    ${targetBundleId ? `if (!a.bundleIdentifier.isNil() && a.bundleIdentifier.js === "${targetBundleId}") matched = true;` : ""}
    ${targetName ? `if (!a.localizedName.isNil() && a.localizedName.js.toLowerCase() === "${targetName.toLowerCase()}") matched = true;` : ""}
    if (matched) {
      a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
      return JSON.stringify({ success: true, name: a.localizedName.js, pid: a.processIdentifier });
    }
  }
  ${targetName ? `ws.launchApplication("${targetName}"); return JSON.stringify({ success: true, name: "${targetName}" });` : ""}
  return JSON.stringify({ success: false, name: "${targetName || targetBundleId}" });
}
`;
      const output = yield* Effect.tryPromise({
        try: () => runJxa(script),
        catch: (cause) =>
          new ComputerToolError({ operation: "computer_activate_app", detail: String(cause) }),
      });
      try {
        const parsed = JSON.parse(output);
        return {
          success: parsed.success === true,
          name: parsed.name || input.name || "Unknown",
          pid: parsed.pid,
        } satisfies ComputerActivateAppResult;
      } catch {
        return {
          success: false,
          name: input.name || "Unknown",
        } satisfies ComputerActivateAppResult;
      }
    }

    return {
      success: false,
      name: input.name || "Unknown",
    } satisfies ComputerActivateAppResult;
  });

export const ComputerClickHandler = (input: ComputerClickInput) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const button = input.button || "left";
    const x = Math.round(input.x);
    const y = Math.round(input.y);

    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const verb = button === "double" ? "double_click" : "click";
      const payload = { x, y, button: button === "right" ? "right" : "left" };
      const res = runCommandSync(cuaPath, ["call", verb, JSON.stringify(payload)], 5_000);
      if (res.code === 0) {
        return { success: true, x, y, button } satisfies ComputerClickResult;
      }
    }

    const script = `
ObjC.import("CoreGraphics");
function run() {
  const pt = $.CGPointMake(${x}, ${y});
  ${
    button === "right"
      ? `
  const down = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, pt, $.kCGMouseButtonRight);
  const up = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, pt, $.kCGMouseButtonRight);
  $.CGEventPost($.kCGHIDEventTap, down);
  $.CGEventPost($.kCGHIDEventTap, up);
  `
      : button === "double"
        ? `
  for (let i = 1; i <= 2; i++) {
    const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
    const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
    $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i);
    $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
  }
  `
        : `
  const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
  const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  $.CGEventPost($.kCGHIDEventTap, up);
  `
  }
  return "ok";
}
`;
    yield* Effect.tryPromise({
      try: () => runJxa(script, 5_000),
      catch: (cause) =>
        new ComputerToolError({ operation: "computer_click", detail: String(cause) }),
    });

    return { success: true, x, y, button } satisfies ComputerClickResult;
  });

export const ComputerTypeHandler = (input: ComputerTypeInput) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const text = input.text;
    if (text.length === 0) {
      return { success: true, charactersTyped: 0 } satisfies ComputerTypeResult;
    }

    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const res = runCommandSync(cuaPath, ["call", "type_text", JSON.stringify({ text })], 10_000);
      if (res.code === 0) {
        return { success: true, charactersTyped: text.length } satisfies ComputerTypeResult;
      }
    }

    const escaped = JSON.stringify(text);
    const script = `
ObjC.import("CoreGraphics");
function run() {
  const str = ${escaped};
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    const down = $.CGEventCreateKeyboardEvent(null, 0, true);
    const up = $.CGEventCreateKeyboardEvent(null, 0, false);
    const unicode = [char];
    $.CGEventKeyboardSetUnicodeString(down, 1, unicode);
    $.CGEventKeyboardSetUnicodeString(up, 1, unicode);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
  }
  return "ok";
}
`;
    yield* Effect.tryPromise({
      try: () => runJxa(script, 10_000),
      catch: (cause) =>
        new ComputerToolError({ operation: "computer_type", detail: String(cause) }),
    });

    return { success: true, charactersTyped: text.length } satisfies ComputerTypeResult;
  });

const KEY_CODES_MAC: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  command: 55,
  shift: 56,
  capslock: 57,
  option: 58,
  alt: 58,
  control: 59,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export const ComputerPressKeyHandler = (input: ComputerPressKeyInput) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;
    const key = input.key.toLowerCase().trim();
    const modifiers = input.modifiers || [];

    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const keys = [...modifiers, key];
      const res = runCommandSync(cuaPath, ["call", "hotkey", JSON.stringify({ keys })], 5_000);
      if (res.code === 0) {
        return { success: true, key: input.key, modifiers } satisfies ComputerPressKeyResult;
      }
    }

    const code = KEY_CODES_MAC[key] ?? 36;
    const modifierFlags = modifiers.map((mod) => {
      switch (mod) {
        case "command":
          return "$.kCGEventFlagMaskCommand";
        case "shift":
          return "$.kCGEventFlagMaskShift";
        case "option":
        case "alt":
          return "$.kCGEventFlagMaskAlternate";
        case "control":
          return "$.kCGEventFlagMaskControl";
      }
    });

    const script = `
ObjC.import("CoreGraphics");
function run() {
  const code = ${code};
  const down = $.CGEventCreateKeyboardEvent(null, code, true);
  const up = $.CGEventCreateKeyboardEvent(null, code, false);
  let flags = 0;
  ${modifierFlags.map((f) => `flags |= ${f};`).join("\n")}
  if (flags > 0) {
    $.CGEventSetFlags(down, flags);
    $.CGEventSetFlags(up, flags);
  }
  $.CGEventPost($.kCGHIDEventTap, down);
  $.CGEventPost($.kCGHIDEventTap, up);
  return "ok";
}
`;
    yield* Effect.tryPromise({
      try: () => runJxa(script, 5_000),
      catch: (cause) =>
        new ComputerToolError({ operation: "computer_press_key", detail: String(cause) }),
    });

    return { success: true, key: input.key, modifiers } satisfies ComputerPressKeyResult;
  });

export const ComputerAccessibilityTreeHandler = (input: { appName?: string | undefined }) =>
  Effect.gen(function* () {
    yield* requireComputerAccess;

    const cuaPath = findCuaDriverPath();
    if (cuaPath) {
      const res = runCommandSync(cuaPath, ["call", "get_window_state", "{}"], 10_000);
      if (res.code === 0 && res.stdout.trim().length > 0) {
        try {
          const parsed = JSON.parse(res.stdout);
          const rawElements = parsed.elements || [];
          const elements = rawElements.slice(0, 100).map((el: Record<string, unknown>) => ({
            role: String(el.role || "element"),
            title: typeof el.title === "string" ? el.title : undefined,
            description: typeof el.description === "string" ? el.description : undefined,
            value: typeof el.value === "string" ? el.value : undefined,
            bounds:
              typeof el.bounds === "object" && el.bounds !== null
                ? {
                    x: Number((el.bounds as Record<string, number>).x || 0),
                    y: Number((el.bounds as Record<string, number>).y || 0),
                    width: Number((el.bounds as Record<string, number>).width || 0),
                    height: Number((el.bounds as Record<string, number>).height || 0),
                  }
                : undefined,
          }));
          return {
            activeApp: String(parsed.app_name || input.appName || "ActiveApp"),
            elements,
          } satisfies ComputerAccessibilityTreeResult;
        } catch {
          // fall through
        }
      }
    }

    // Native JXA accessibility inspect
    const appTarget = input.appName ? `application "${input.appName}"` : "frontmostApplication";
    const script = `
ObjC.import("AppKit");
function run() {
  const ws = $.NSWorkspace.sharedWorkspace;
  const app = ws.${appTarget === "frontmostApplication" ? "frontmostApplication" : `runningApplications.filter(a => a.localizedName.js === "${input.appName}")[0]`};
  if (!app || app.isNil()) return JSON.stringify({ activeApp: "None", elements: [] });
  return JSON.stringify({
    activeApp: app.localizedName.js,
    elements: [
      { role: "window", title: app.localizedName.js, bounds: { x: 0, y: 0, width: 1440, height: 900 } }
    ]
  });
}
`;
    const output = yield* Effect.tryPromise({
      try: () => runJxa(script, 5_000),
      catch: (cause) =>
        new ComputerToolError({
          operation: "computer_accessibility_tree",
          detail: String(cause),
        }),
    });
    try {
      const parsed = JSON.parse(output);
      return {
        activeApp: parsed.activeApp || "ActiveApp",
        elements: parsed.elements || [],
      } satisfies ComputerAccessibilityTreeResult;
    } catch {
      return { activeApp: "ActiveApp", elements: [] } satisfies ComputerAccessibilityTreeResult;
    }
  });

const handlers = {
  computer_apps: () => ComputerAppsHandler(),
  computer_activate_app: (input) => ComputerActivateAppHandler(input),
  computer_click: (input) => ComputerClickHandler(input),
  computer_type: (input) => ComputerTypeHandler(input),
  computer_press_key: (input) => ComputerPressKeyHandler(input),
  computer_accessibility_tree: (input) => ComputerAccessibilityTreeHandler(input),
  computer_screenshot: (input) => ComputerScreenshotHandler(input),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

const { computer_screenshot, ...standardHandlers } = handlers;

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerScreenshotToolkitHandlersLive = ComputerScreenshotToolkit.toLayer({
  computer_screenshot,
});
