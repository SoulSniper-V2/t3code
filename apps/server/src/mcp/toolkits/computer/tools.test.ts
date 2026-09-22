import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ComputerAppsTool } from "./tools.ts";

it("exports an empty object schema for the parameterless computer tool", () => {
  expect(Tool.getJsonSchema(ComputerAppsTool)).toEqual({
    type: "object",
    additionalProperties: false,
  });
});
