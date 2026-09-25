// @effect-diagnostics nodeBuiltinImport:off - Tests use POSIX path resolution fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  CLINE_MCP_SETTINGS_MAX_BYTES,
  mergeClineMcpSettings,
  resolveClineMcpSettingsPath,
} from "./clineMcpSettings.ts";

const session = {
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer synthetic-t3-token",
} as const;

describe("Cline MCP settings merge", () => {
  it("preserves flat and nested user servers and uses a non-conflicting T3 name", () => {
    const existing = JSON.stringify({
      mcpServers: {
        "t3-code": {
          command: "user-owned-server",
          env: { API_TOKEN: "synthetic-user-token" },
          oauth: { accessToken: "synthetic-user-oauth-token" },
        },
        "remote-server": {
          transport: {
            type: "streamableHttp",
            url: "https://mcp.example.test/sse",
            headers: { Authorization: "Bearer synthetic-remote-token" },
          },
          disabled: false,
        },
      },
    });

    const merged = mergeClineMcpSettings(existing, session);

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(JSON.parse(merged.settings)).toEqual({
      mcpServers: {
        "t3-code": {
          command: "user-owned-server",
          env: { API_TOKEN: "synthetic-user-token" },
          oauth: { accessToken: "synthetic-user-oauth-token" },
        },
        "remote-server": {
          transport: {
            type: "streamableHttp",
            url: "https://mcp.example.test/sse",
            headers: { Authorization: "Bearer synthetic-remote-token" },
          },
          disabled: false,
        },
        "t3-code (T3 Code 1)": {
          type: "streamableHttp",
          url: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
          disabled: false,
          autoApprove: [],
        },
      },
    });
  });

  it("adds only T3 when there is no existing file", () => {
    const merged = mergeClineMcpSettings(undefined, session);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(JSON.parse(merged.settings)).toEqual({
      mcpServers: {
        "t3-code": {
          type: "streamableHttp",
          url: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
          disabled: false,
          autoApprove: [],
        },
      },
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing server map", "{}"],
    ["invalid server schema", JSON.stringify({ mcpServers: { broken: { command: 42 } } })],
  ])("does not merge %s", (_description, existing) => {
    expect(mergeClineMcpSettings(existing, session).ok).toBe(false);
  });

  it("rejects configs over the bounded size before parsing", () => {
    const existing = " ".repeat(CLINE_MCP_SETTINGS_MAX_BYTES + 1);
    expect(mergeClineMcpSettings(existing, session)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("Cline MCP settings path resolution", () => {
  const pathOperations = {
    join: (...segments: string[]) => NodePath.posix.join(...segments),
    resolve: (...segments: string[]) => NodePath.posix.resolve(...segments),
  };

  it("prefers the explicit per-user path", () => {
    expect(
      resolveClineMcpSettingsPath(
        { CLINE_MCP_SETTINGS_PATH: "/custom/cline-mcp.json", CLINE_DATA_DIR: "/data" },
        "/home/tester",
        pathOperations,
      ),
    ).toBe("/custom/cline-mcp.json");
  });

  it("follows Cline's data-dir and Cline-dir defaults", () => {
    expect(
      resolveClineMcpSettingsPath(
        { CLINE_DATA_DIR: "/cline-data" },
        "/home/tester",
        pathOperations,
      ),
    ).toBe("/cline-data/settings/cline_mcp_settings.json");
    expect(
      resolveClineMcpSettingsPath({ CLINE_DIR: "/cline-home" }, "/home/tester", pathOperations),
    ).toBe("/cline-home/data/settings/cline_mcp_settings.json");
    expect(resolveClineMcpSettingsPath({}, "/home/tester", pathOperations)).toBe(
      "/home/tester/.cline/data/settings/cline_mcp_settings.json",
    );
  });

  it("honors Cline CLI config and data-dir launch arguments relative to the session cwd", () => {
    expect(
      resolveClineMcpSettingsPath(
        {},
        "/home/tester",
        pathOperations,
        "--config ./.cline-config --data-dir ./cline-data",
        "/workspace/project",
      ),
    ).toBe("/workspace/project/cline-data/settings/cline_mcp_settings.json");
    expect(
      resolveClineMcpSettingsPath(
        {},
        "/home/tester",
        pathOperations,
        "--config ./.cline-config",
        "/workspace/project",
      ),
    ).toBe("/workspace/project/.cline-config/data/settings/cline_mcp_settings.json");
  });
});
