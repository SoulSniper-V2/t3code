import { describe, expect, it } from "@effect/vitest";

import {
  extractIssueReferencesFromText,
  formatIssueContextPrompt,
  parseIssueUrl,
} from "./issueReferences.ts";

describe("parseIssueUrl", () => {
  it("parses Linear URLs with workspace, ID, and slug", () => {
    const issue = parseIssueUrl("https://linear.app/acme/issue/ENG-1234/fix-auth-header");
    expect(issue).toEqual({
      tracker: "linear",
      id: "ENG-1234",
      title: "fix auth header",
      url: "https://linear.app/acme/issue/ENG-1234/fix-auth-header",
      workspace: "acme",
      suggestedBranchName: "eng-1234-fix-auth-header",
    });
  });

  it("parses Jira Cloud URLs", () => {
    const issue = parseIssueUrl("https://mycompany.atlassian.net/browse/PROJ-456");
    expect(issue).toEqual({
      tracker: "jira",
      id: "PROJ-456",
      url: "https://mycompany.atlassian.net/browse/PROJ-456",
      suggestedBranchName: "proj-456",
    });
  });

  it("parses GitLab and GitHub issue URLs", () => {
    const gitlab = parseIssueUrl("https://gitlab.com/group/repo/-/issues/789");
    expect(gitlab?.tracker).toBe("gitlab");
    expect(gitlab?.id).toBe("#789");

    const github = parseIssueUrl("https://github.com/pingdotgg/t3code/issues/1234");
    expect(github?.tracker).toBe("github");
    expect(github?.id).toBe("#1234");
  });

  it("returns null for non-issue URLs", () => {
    expect(parseIssueUrl("https://example.com/other")).toBeNull();
  });
});

describe("extractIssueReferencesFromText and formatIssueContextPrompt", () => {
  it("extracts multiple issue URLs from freeform text", () => {
    const text =
      "Please review https://linear.app/team/issue/ENG-42/add-cache and check https://github.com/owner/repo/issues/100";
    const issues = extractIssueReferencesFromText(text);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.id).toBe("ENG-42");
    expect(issues[1]?.id).toBe("#100");
  });

  it("formats prompt context headers properly", () => {
    const issue = parseIssueUrl("https://linear.app/acme/issue/ENG-1234/fix-auth")!;
    const prompt = formatIssueContextPrompt(issue);
    expect(prompt).toContain("[Linear Issue Reference: ENG-1234]");
    expect(prompt).toContain("Suggested Branch: eng-1234-fix-auth");
  });
});
