import { describe, expect, it } from "@effect/vitest";

import {
  parseCommandCodeAuthStatus,
  parseCommandCodeVersion,
  resolveCommandCodeHome,
} from "./CommandCodeProvider.ts";

describe("Command Code status metadata", () => {
  it("reads the CLI version without mistaking update-banner versions for the CLI", () => {
    expect(parseCommandCodeVersion("Checking updates 2.8.1\ncommand-code 1.4.0\n")).toBe("1.4.0");
    expect(parseCommandCodeVersion("not installed")).toBeNull();
  });

  it("recognizes only an explicit JSON authentication boolean", () => {
    expect(
      parseCommandCodeAuthStatus('{"authenticated":true,"email":"private@example.test"}'),
    ).toEqual({ status: "authenticated", type: "command-code" });
    expect(parseCommandCodeAuthStatus('{"authenticated":false}')).toEqual({
      status: "unauthenticated",
      type: "command-code",
    });
    expect(parseCommandCodeAuthStatus('{"status":"signed in"}')).toEqual({ status: "unknown" });
    expect(parseCommandCodeAuthStatus("not JSON")).toEqual({ status: "unknown" });
  });

  it("uses the normal HOME directory for automatic BYOK discovery", () => {
    expect(
      resolveCommandCodeHome({ HOME: " /users/example " } as NodeJS.ProcessEnv, "/fallback"),
    ).toBe("/users/example");
    expect(resolveCommandCodeHome({}, "/fallback")).toBe("/fallback");
  });
});
