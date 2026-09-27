import { assert, describe, it } from "@effect/vitest";

import {
  resolveDesktopSshCliReleaseBaseUrl,
  resolveDesktopSshCliRunner,
} from "./desktopSshCliRunner.ts";

describe("resolveDesktopSshCliReleaseBaseUrl", () => {
  it("uses an explicit release mirror before the GitHub repository", () => {
    assert.equal(
      resolveDesktopSshCliReleaseBaseUrl({
        releaseBaseUrl: "https://mirror.example/releases/",
        updateRepository: "SoulSniper-V2/t3code",
      }),
      "https://mirror.example/releases",
    );
  });

  it("uses the fork repository for remote CLI archives", () => {
    assert.equal(
      resolveDesktopSshCliReleaseBaseUrl({
        updateRepository: "SoulSniper-V2/t3code",
        githubRepository: "pingdotgg/t3code",
      }),
      "https://github.com/SoulSniper-V2/t3code/releases/download",
    );
  });

  it("ignores malformed repository names instead of embedding them in a URL", () => {
    assert.isUndefined(
      resolveDesktopSshCliReleaseBaseUrl({ githubRepository: "https://example.com/evil" }),
    );
  });
});

describe("resolveDesktopSshCliRunner", () => {
  it("uses the source checkout during development", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner({
        isDevelopment: true,
        devRemoteT3ServerEntryPath: "/repo/apps/server/src/bin.ts",
        appVersion: "0.0.44-nightly.20260926.38",
        nodeEngineRange: ">=22",
        releaseBaseUrl: "https://github.com/SoulSniper-V2/t3code/releases/download",
      }),
      {
        nodeScriptPath: "/repo/apps/server/src/bin.ts",
        nodeEngineRange: ">=22",
      },
    );
  });

  it("uses the matching fork archive in packaged builds", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner({
        isDevelopment: false,
        appVersion: "0.0.44-nightly.20260926.38",
        nodeEngineRange: ">=22",
        releaseBaseUrl: "https://github.com/SoulSniper-V2/t3code/releases/download",
      }),
      {
        archiveVersion: "0.0.44-nightly.20260926.38",
        releaseBaseUrl: "https://github.com/SoulSniper-V2/t3code/releases/download",
      },
    );
  });
});
