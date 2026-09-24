import { describe, expect, it } from "vite-plus/test";

import {
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
  shouldAllowDesktopUpdateDowngrade,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it("allows a version downgrade only when crossing update channels", () => {
    expect(shouldAllowDesktopUpdateDowngrade("nightly", "0.0.44-nightly.20260923.2")).toBe(false);
    expect(shouldAllowDesktopUpdateDowngrade("nightly", "0.0.44")).toBe(true);
    expect(shouldAllowDesktopUpdateDowngrade("latest", "0.0.44-nightly.20260923.2")).toBe(true);
    expect(shouldAllowDesktopUpdateDowngrade("latest", "0.0.44")).toBe(false);
  });
});
