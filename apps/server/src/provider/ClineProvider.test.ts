import { describe, expect, it } from "vite-plus/test";

import {
  parseClineVersion,
  readClineCredentialSummary,
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
  it("prefers CLINE_DATA_DIR and falls back to ~/.cline", () => {
    expect(
      resolveClineDataDir({ CLINE_DATA_DIR: "  /tmp/isolated " } as NodeJS.ProcessEnv, "/home/u"),
    ).toBe("/tmp/isolated");
    expect(resolveClineDataDir({}, "/home/u")).toBe("/home/u/.cline");
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
});
