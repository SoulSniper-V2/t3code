import { describe, expect, it } from "vite-plus/test";

import {
  parseClineVersion,
  readClineCredentialSummary,
  readClineProviderSettingsSummary,
  resolveClineDataDir,
} from "./ClineProvider.ts";

describe("parseClineVersion", () => {
  it("reads the bare semver the CLI prints", () => {
    expect(parseClineVersion("3.0.62\n")).toBe("3.0.62");
    expect(parseClineVersion("")).toBeNull();
    expect(parseClineVersion("interactive mode requires a TTY")).toBeNull();
  });
});

describe("resolveClineDataDir", () => {
  it("honors Cline's data-dir, Cline-dir, HOME, and default-home precedence", () => {
    expect(
      resolveClineDataDir({ CLINE_DATA_DIR: "  /tmp/isolated " } as NodeJS.ProcessEnv, "/home/u"),
    ).toBe("/tmp/isolated");
    expect(
      resolveClineDataDir({ CLINE_DIR: "/tmp/cline-home" } as NodeJS.ProcessEnv, "/home/u"),
    ).toBe("/tmp/cline-home/data");
    expect(resolveClineDataDir({ HOME: "/home/env" } as NodeJS.ProcessEnv, "/home/u")).toBe(
      "/home/env/.cline/data",
    );
    expect(resolveClineDataDir({}, "/home/u")).toBe("/home/u/.cline/data");
  });
});

describe("readClineCredentialSummary", () => {
  it("reports the last-used provider when it carries a credential marker", () => {
    expect(
      readClineCredentialSummary(
        JSON.stringify({
          lastUsedProvider: "cline",
          providers: { cline: { settings: {}, tokenSource: "oauth" } },
        }),
      ),
    ).toEqual({ authenticated: true, providerId: "cline" });
  });

  it("falls back to any credentialed provider and never reads key values", () => {
    expect(
      readClineCredentialSummary(
        JSON.stringify({
          lastUsedProvider: "cline",
          providers: {
            cline: { settings: {} },
            openrouter: { settings: { apiKey: "sk-…" } },
          },
        }),
      ),
    ).toEqual({ authenticated: true, providerId: "openrouter" });
  });

  it("reports unauthenticated for missing, broken, or keyless state", () => {
    expect(readClineCredentialSummary("")).toEqual({ authenticated: false, providerId: null });
    expect(readClineCredentialSummary("not json")).toEqual({
      authenticated: false,
      providerId: null,
    });
    expect(
      readClineCredentialSummary(
        JSON.stringify({ lastUsedProvider: "cline", providers: { cline: { settings: {} } } }),
      ),
    ).toEqual({ authenticated: false, providerId: "cline" });
  });

  it("reads the current provider model without exposing its credentials", () => {
    const summary = readClineProviderSettingsSummary(
      JSON.stringify({
        lastUsedProvider: "openrouter",
        providers: {
          openrouter: {
            settings: {
              provider: "openrouter",
              model: "anthropic/claude-sonnet-4.6",
              apiKey: "must-not-escape",
            },
            tokenSource: "manual",
          },
        },
      }),
    );

    expect(summary).toEqual({
      authenticated: true,
      providerId: "openrouter",
      configuredModel: {
        providerId: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
      },
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-escape");
  });

  it("ignores absent or unresolved current models", () => {
    expect(
      readClineProviderSettingsSummary(
        JSON.stringify({
          lastUsedProvider: "cline",
          providers: { cline: { settings: { model: "~not-resolved" }, tokenSource: "oauth" } },
        }),
      ),
    ).toEqual({
      authenticated: true,
      providerId: "cline",
      configuredModel: null,
    });
  });
});
