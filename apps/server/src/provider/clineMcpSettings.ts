/**
 * Helpers for merging T3's scoped MCP server into Cline's per-run settings.
 *
 * Cline documents `CLINE_MCP_SETTINGS_PATH` as a path override, so the file at
 * that path replaces the normal settings file. We read the original config,
 * validate the server records against Cline's flat and nested transport
 * shapes, and write the merged result to a short-lived private file.
 */
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import { parseCliArgs } from "@t3tools/shared/cliArgs";

export const CLINE_MCP_SETTINGS_FILE_NAME = "cline_mcp_settings.json";
export const CLINE_MCP_SETTINGS_MAX_BYTES = 1_048_576;

export type ClineMcpSettingsMergeResult =
  | { readonly ok: true; readonly settings: string }
  | {
      readonly ok: false;
      readonly reason: "too_large" | "invalid_json" | "invalid_shape";
    };

type StringRecord = Record<string, unknown>;

export interface ClineMcpSettingsPathEnvironment {
  readonly CLINE_MCP_SETTINGS_PATH?: string | undefined;
  readonly CLINE_DATA_DIR?: string | undefined;
  readonly CLINE_DIR?: string | undefined;
}

export interface ClineMcpSettingsPathOperations {
  readonly join: (...segments: string[]) => string;
  readonly resolve: (...segments: string[]) => string;
}

function isRecord(value: unknown): value is StringRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value);
}

function hasValidCommonFields(server: StringRecord): boolean {
  return (
    (server.autoApprove === undefined || isStringArray(server.autoApprove)) &&
    (server.disabled === undefined || typeof server.disabled === "boolean") &&
    (server.remoteConfigured === undefined || typeof server.remoteConfigured === "boolean")
  );
}

function hasValidNestedTransport(server: StringRecord): boolean {
  const transport = server.transport;
  if (!isRecord(transport)) return false;
  if (transport.type === "stdio") {
    return (
      typeof transport.command === "string" &&
      (transport.args === undefined || isStringArray(transport.args)) &&
      (transport.cwd === undefined || typeof transport.cwd === "string") &&
      (transport.env === undefined || isStringRecord(transport.env))
    );
  }
  if (transport.type === "sse" || transport.type === "streamableHttp") {
    return (
      isUrl(transport.url) && (transport.headers === undefined || isStringRecord(transport.headers))
    );
  }
  return false;
}

function hasValidFlatTransport(server: StringRecord): boolean {
  if (server.transportType !== undefined && typeof server.transportType !== "string") {
    return false;
  }
  const hasStdioCommand = typeof server.command === "string";
  if (hasStdioCommand && (server.type === undefined || server.type === "stdio")) {
    return (
      (server.args === undefined || isStringArray(server.args)) &&
      (server.cwd === undefined || typeof server.cwd === "string") &&
      (server.env === undefined || isStringRecord(server.env)) &&
      (server.url === undefined || typeof server.url === "string") &&
      (server.headers === undefined || isStringRecord(server.headers))
    );
  }
  if (
    (server.type === undefined || server.type === "sse" || server.type === "streamableHttp") &&
    isUrl(server.url)
  ) {
    return (
      (server.command === undefined || typeof server.command === "string") &&
      (server.args === undefined || isStringArray(server.args)) &&
      (server.env === undefined || isStringRecord(server.env)) &&
      (server.headers === undefined || isStringRecord(server.headers))
    );
  }
  return false;
}

function hasValidServerConfig(value: unknown): value is StringRecord {
  if (!isRecord(value) || !hasValidCommonFields(value)) return false;
  return hasValidNestedTransport(value) || hasValidFlatTransport(value);
}

function findT3ServerName(servers: StringRecord): string {
  if (!Object.hasOwn(servers, "t3-code")) return "t3-code";
  let suffix = 1;
  while (Object.hasOwn(servers, `t3-code (T3 Code ${suffix})`)) suffix += 1;
  return `t3-code (T3 Code ${suffix})`;
}

/**
 * Return Cline's effective MCP config path before T3 installs its own
 * per-turn `CLINE_MCP_SETTINGS_PATH` override. `join` and `homeDir` are passed
 * in so this resolver stays deterministic and easy to test.
 */
export function resolveClineMcpSettingsPath(
  environment: ClineMcpSettingsPathEnvironment,
  homeDir: string,
  path: ClineMcpSettingsPathOperations,
  launchArgs?: string,
  workingDirectory = homeDir,
): string {
  const flags = parseCliArgs(launchArgs ?? "").flags;
  const configuredByCli = flags.config;
  const configDirFromCli = typeof configuredByCli === "string" ? configuredByCli.trim() : "";
  const dataDirFromCli = flags["data-dir"];
  const cliDataDir = typeof dataDirFromCli === "string" ? dataDirFromCli.trim() : "";

  const configuredPath = environment.CLINE_MCP_SETTINGS_PATH?.trim();
  if (configuredPath) return path.resolve(workingDirectory, configuredPath);

  const dataDir = cliDataDir || environment.CLINE_DATA_DIR?.trim();
  const clineDir =
    configDirFromCli || environment.CLINE_DIR?.trim() || path.join(homeDir, ".cline");
  const baseDataDir = dataDir || path.join(clineDir, "data");
  return path.resolve(
    workingDirectory,
    path.join(baseDataDir, "settings", CLINE_MCP_SETTINGS_FILE_NAME),
  );
}

/**
 * Validate and merge a bounded Cline config without normalizing or logging
 * existing server values. Opaque OAuth/metadata and unknown compatible fields
 * are preserved exactly as JSON data; the existing `t3-code` name is retained
 * by choosing a unique name for this turn's scoped server.
 */
export function mergeClineMcpSettings(
  existingSettings: string | undefined,
  mcpSession: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
): ClineMcpSettingsMergeResult {
  if (
    existingSettings !== undefined &&
    new TextEncoder().encode(existingSettings).byteLength > CLINE_MCP_SETTINGS_MAX_BYTES
  ) {
    return { ok: false, reason: "too_large" };
  }

  let parsed: unknown = { mcpServers: {} };
  if (existingSettings !== undefined) {
    try {
      parsed = JSON.parse(existingSettings) as unknown;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const servers = parsed.mcpServers;
  if (!Object.values(servers).every(hasValidServerConfig)) {
    return { ok: false, reason: "invalid_shape" };
  }

  const serverName = findT3ServerName(servers);
  const merged = {
    ...parsed,
    mcpServers: {
      ...servers,
      [serverName]: {
        type: "streamableHttp",
        url: mcpSession.endpoint,
        headers: { Authorization: mcpSession.authorizationHeader },
        disabled: false,
        autoApprove: [],
      },
    },
  };
  return { ok: true, settings: JSON.stringify(merged) };
}
