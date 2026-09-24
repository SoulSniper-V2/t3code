import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it("keeps a leading slash as a command trigger", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({
      kind: "slash-command",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
  });

  it("uses an inline slash after prompt text as a skill trigger", () => {
    const text = "Use /review";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-skill",
      query: "review",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("supports repeated inline skill picks in the same prompt", () => {
    const firstPrompt = "Use /review";
    const firstTrigger = detectComposerTrigger(firstPrompt, firstPrompt.length);
    expect(firstTrigger?.kind).toBe("slash-skill");
    if (!firstTrigger) throw new Error("Expected the first inline skill trigger");

    const firstSelection = replaceTextRange(
      firstPrompt,
      firstTrigger.rangeStart,
      firstTrigger.rangeEnd,
      "$review ",
    );
    const secondPrompt = `${firstSelection.text}then /implement`;

    expect(detectComposerTrigger(secondPrompt, secondPrompt.length)).toEqual({
      kind: "slash-skill",
      query: "implement",
      rangeStart: firstSelection.text.length + "then ".length,
      rangeEnd: secondPrompt.length,
    });
  });

  it.each(["Use /tmp/build.sh", String.raw`Use /tmp\build.sh`])(
    "leaves absolute paths as plain text: %s",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toBeNull();
    },
  );

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
