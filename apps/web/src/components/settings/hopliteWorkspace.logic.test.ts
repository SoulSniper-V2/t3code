import { describe, expect, it } from "vite-plus/test";
import { isHopliteResourceMissing, parseHopliteSpendLimit } from "./hopliteWorkspace.logic";

describe("parseHopliteSpendLimit", () => {
  it("keeps an unset limit distinct from a valid micro-dollar amount", () => {
    expect(parseHopliteSpendLimit(" ")).toBeNull();
    expect(parseHopliteSpendLimit("1.234567")).toBe(1_234_567);
    expect(parseHopliteSpendLimit("0.000001")).toBe(1);
  });

  it.each(["0", "-2", "1e6", "2.0000001", "NaN", "Infinity", "9007199254.740992"])(
    "rejects invalid or unsafe limit %s",
    (value) => {
      expect(parseHopliteSpendLimit(value)).toBeUndefined();
    },
  );
});

describe("isHopliteResourceMissing", () => {
  it("treats a typed not-found response as absent", () => {
    expect(
      isHopliteResourceMissing({
        _tag: "HopliteError",
        reason: "not_found",
        operation: "pullRequest",
      }),
    ).toBe(true);
  });

  it.each([
    null,
    { reason: "not_found" },
    { _tag: "HopliteError", reason: "permission_denied" },
    { _tag: "HopliteError", reason: "request_failed", status: 401 },
    new Error("Network disconnected"),
  ])("does not hide an authorization or transport failure: %j", (error) => {
    expect(isHopliteResourceMissing(error)).toBe(false);
  });
});
