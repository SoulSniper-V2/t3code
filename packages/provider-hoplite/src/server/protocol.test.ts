import { describe, expect, it } from "@effect/vitest";
import { DraftSnapshots, operationKey } from "./protocol.ts";
import { hopliteModels } from "./models.ts";
import { hopliteCapabilities } from "./capabilities.ts";

describe("Hoplite replay identity", () => {
  it("keeps idempotency keys stable and within the API's 64-character bound", () => {
    const id = "message:".repeat(100);
    expect(operationKey("message", id)).toBe(operationKey("message", id));
    expect(operationKey("message", id)).not.toBe(operationKey("stop", id));
    expect(operationKey("message", id).length).toBeLessThanOrEqual(64);
  });

  it("replaces drafts by revision without allowing stale or persisted drafts to overwrite text", () => {
    const snapshots = new DraftSnapshots();
    const draft = { messageId: "msg_1", streamId: "stream_1", revision: 1, content: "Hello" };
    expect(snapshots.accept(draft)).toBe(true);
    expect(snapshots.accept(draft)).toBe(false);
    expect(snapshots.accept({ ...draft, revision: 2, content: "Hello world" })).toBe(true);
    expect(snapshots.accept(draft)).toBe(false);
    snapshots.settle(draft.messageId);
    expect(snapshots.accept({ ...draft, revision: 3 })).toBe(false);
  });

  it("accepts a new draft stream without appending the previous stream's snapshot", () => {
    const snapshots = new DraftSnapshots();
    expect(snapshots.accept({ messageId: "msg_1", streamId: "old", revision: 10 })).toBe(true);
    expect(snapshots.accept({ messageId: "msg_1", streamId: "new", revision: 1 })).toBe(true);
  });
});

describe("Hoplite authorized catalog", () => {
  it("offers only the reasoning and speed controls reported for each model", () => {
    const models = hopliteModels({
      runConfig: { defaultModelId: "model-a", defaultReasoning: "high", defaultSpeed: "standard" },
      models: [
        {
          id: "model-a",
          name: "Model A",
          provider: "openai",
          capabilities: { reasoningLevels: ["low", "high"], supportsFast: true },
        },
        {
          id: "model-b",
          name: "Model B",
          provider: "anthropic",
          capabilities: { reasoningLevels: [], supportsFast: false },
        },
      ],
    });
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
      "reasoningEffort",
      "speed",
    ]);
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("does not claim local workspace checkpoints or unsupported forks and steering", () => {
    expect(hopliteCapabilities.checkpointing.appCanCheckpointFilesystem).toBe(false);
    expect(hopliteCapabilities.threads.canForkThread).toBe(false);
    expect(hopliteCapabilities.turns.supportsActiveSteering).toBe(false);
    expect(hopliteCapabilities.threads.canCreateEmptyThread).toBe(false);
  });
});
