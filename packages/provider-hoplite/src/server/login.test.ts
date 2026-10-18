import { describe, expect, it } from "vite-plus/test";

import {
  hopliteLoginEnvironment,
  parseHopliteDeviceLogin,
  parseHopliteMcpConfigKey,
} from "./login.ts";

describe("parseHopliteDeviceLogin", () => {
  it("reads the approval link and code the CLI prints", () => {
    expect(
      parseHopliteDeviceLogin(
        [
          "Opening your browser to sign in to Hoplite…",
          "  If it does not open, visit https://hoplite.sh/device?user_code=AUAVQHE7",
          "  and confirm the code AUAVQHE7",
        ].join("\n"),
      ),
    ).toEqual({ url: "https://hoplite.sh/device?user_code=AUAVQHE7", userCode: "AUAVQHE7" });
  });

  it("waits until the link has been printed", () => {
    expect(parseHopliteDeviceLogin("Opening your browser to sign in to Hoplite…")).toBeUndefined();
  });
});

describe("parseHopliteMcpConfigKey", () => {
  const config = (headers: Record<string, string>) =>
    JSON.stringify({
      mcpServers: { hoplite: { headers, type: "http", url: "https://api.hoplite.sh/mcp" } },
    });

  it("extracts the key after the CLI's notice line", () => {
    expect(
      parseHopliteMcpConfigKey(
        `Embedding hop_…abcd for organization org_1.\n${config({ Authorization: "Bearer hop_cli_key" })}`,
      ),
    ).toBe("hop_cli_key");
  });

  it("accepts the X-Api-Key header form", () => {
    expect(parseHopliteMcpConfigKey(config({ "X-Api-Key": "hop_other" }))).toBe("hop_other");
  });

  it("rejects output that does not carry a Hoplite key", () => {
    expect(parseHopliteMcpConfigKey(config({ Authorization: "Bearer $HOPLITE_API_KEY" }))).toBe(
      undefined,
    );
    expect(parseHopliteMcpConfigKey("error: not authenticated")).toBeUndefined();
  });
});

describe("hopliteLoginEnvironment", () => {
  it("drops inherited keys so the CLI exports the one it just stored", () => {
    const env = hopliteLoginEnvironment({
      PATH: "/bin",
      HOPLITE_API_KEY: "hop_ambient",
      HOPLITE_ACP_API_KEY: "hop_acp",
      HOPLITE_ACP_URL: "https://api.hoplite.sh/acp",
    });
    expect(env).toEqual({ PATH: "/bin", NO_BROWSER: "1", HOPLITE_NO_UPDATE_CHECK: "1" });
  });
});
