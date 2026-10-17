import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  AuthDiagnosticsReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { HopliteImportThreadInput, HopliteMutateInput, HopliteReadInput } from "./hoplite.ts";
import { WS_METHODS } from "./rpc.ts";

const binding = { instanceId: "hoplite-work" };
const write = (mutation: unknown) => ({ ...binding, idempotencyKey: "stable-key", mutation });
const decodeRead = Schema.decodeUnknownExit(HopliteReadInput);
const decodeWrite = Schema.decodeUnknownExit(HopliteMutateInput);
const decodeImport = Schema.decodeUnknownExit(HopliteImportThreadInput);
const decodeMutation = Schema.decodeUnknownSync(HopliteMutateInput);

describe("Hoplite contracts and permissions", () => {
  it("does not expose arbitrary authenticated URLs or PR merges", () => {
    expect(
      Exit.isFailure(
        decodeRead({
          ...binding,
          request: { type: "proxy", url: "https://elsewhere.test" },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(decodeWrite(write({ type: "mergePullRequest", threadId: "remote" }))),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeImport({
          ...binding,
          projectId: "local",
          remoteThreadId: "../projects",
        }),
      ),
    ).toBe(true);
  });

  it("keeps each mutation in its destination environment permission domain", () => {
    const scopes = (mutation: unknown) =>
      clientRpcRequiredScopes(WS_METHODS.hopliteMutate, write(mutation));
    expect(scopes({ type: "updateThread", threadId: "remote", title: "Renamed" })).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(
      scopes({
        type: "setEnvironmentVariable",
        projectId: "remote",
        key: "TOKEN",
        value: "secret",
      }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(scopes({ type: "setRepositories", projectId: "remote", repositories: [] })).toEqual([
      AuthSourceControlWriteScope,
    ]);
    expect(scopes({ type: "createProject", name: "Cloud", repositoryId: "repository" })).toEqual([
      AuthOrchestrationOperateScope,
      AuthSettingsWriteScope,
      AuthSourceControlWriteScope,
    ]);
    expect(scopes({ type: "deleteProject", projectId: "remote" })).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(scopes({ type: "setReviewLoop", threadId: "remote", enabled: true })).toEqual([
      AuthSourceControlWriteScope,
      AuthOrchestrationOperateScope,
    ]);
    expect(
      scopes({ type: "restoreCheckpoint", threadId: "remote", checkpointId: "checkpoint" }),
    ).toEqual([AuthFilesystemWriteScope, AuthOrchestrationOperateScope]);
    expect(scopes({ type: "startPreview", threadId: "remote" })).toEqual([AuthPreviewOperateScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.hopliteRead, {
        ...binding,
        request: { type: "billingSummary" },
      }),
    ).toEqual([AuthDiagnosticsReadScope]);
  });

  it("requires full scheduled automation inputs and explicit question answers", () => {
    expect(
      Exit.isFailure(
        decodeWrite(
          write({ type: "createAutomation", projectId: "remote", settings: { name: "Empty" } }),
        ),
      ),
    ).toBe(true);
    expect(
      decodeMutation(
        write({
          type: "answerQuestion",
          threadId: "remote",
          questionId: "question",
          answers: null,
        }),
      ).mutation,
    ).toEqual({
      type: "answerQuestion",
      threadId: "remote",
      questionId: "question",
      answers: null,
    });
    expect(
      Exit.isFailure(
        decodeWrite(
          write({
            type: "answerApproval",
            threadId: "remote",
            approvalId: "legacy",
            approved: true,
          }),
        ),
      ),
    ).toBe(true);
  });
});
