/**
 * Universal issue reference parser for Linear, Jira, GitLab, and GitHub.
 *
 * Inspired by Emdash & Orca: allows pasting issue URLs directly into
 * workspaces or prompts to automatically extract tracker identity, issue ID,
 * title/slug, and suggested branch names.
 *
 * @module issueReferences
 */

export interface ParsedIssueReference {
  readonly tracker: "linear" | "jira" | "gitlab" | "github";
  readonly id: string;
  readonly title?: string | undefined;
  readonly url: string;
  readonly workspace?: string | undefined;
  readonly suggestedBranchName: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const LINEAR_REGEX =
  /^https?:\/\/linear\.app\/([a-zA-Z0-9_-]+)\/issue\/([a-zA-Z0-9]+-[0-9]+)(?:\/([a-zA-Z0-9_-]+))?\/?$/i;

const JIRA_REGEX = /^https?:\/\/[a-zA-Z0-9.-]+\/browse\/([a-zA-Z0-9]+-[0-9]+)\/?$/i;

const GITLAB_REGEX =
  /^https?:\/\/gitlab(?:\.[a-zA-Z0-9.-]+)?\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+)\/-\/issues\/([0-9]+)\/?$/i;

const GITHUB_ISSUE_REGEX =
  /^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/([0-9]+)\/?$/i;

export function parseIssueUrl(rawUrl: string): ParsedIssueReference | null {
  const url = rawUrl.trim();

  // Linear
  const linearMatch = LINEAR_REGEX.exec(url);
  if (linearMatch) {
    const [, workspace, id, slug] = linearMatch;
    const cleanId = id!.toUpperCase();
    const title = slug ? slug.replaceAll("-", " ") : undefined;
    const branchSuffix = slug ? `-${slugify(slug)}` : "";
    return {
      tracker: "linear",
      id: cleanId,
      title,
      url,
      workspace,
      suggestedBranchName: `${cleanId.toLowerCase()}${branchSuffix}`,
    };
  }

  // Jira
  const jiraMatch = JIRA_REGEX.exec(url);
  if (jiraMatch) {
    const [, id] = jiraMatch;
    const cleanId = id!.toUpperCase();
    return {
      tracker: "jira",
      id: cleanId,
      url,
      suggestedBranchName: cleanId.toLowerCase(),
    };
  }

  // GitLab
  const gitlabMatch = GITLAB_REGEX.exec(url);
  if (gitlabMatch) {
    const [, projectPath, id] = gitlabMatch;
    return {
      tracker: "gitlab",
      id: `#${id}`,
      url,
      workspace: projectPath,
      suggestedBranchName: `issue-${id}`,
    };
  }

  // GitHub
  const githubMatch = GITHUB_ISSUE_REGEX.exec(url);
  if (githubMatch) {
    const [, owner, repo, id] = githubMatch;
    return {
      tracker: "github",
      id: `#${id}`,
      url,
      workspace: `${owner}/${repo}`,
      suggestedBranchName: `issue-${id}`,
    };
  }

  return null;
}

/**
 * Scan arbitrary text for supported issue tracker links.
 */
export function extractIssueReferencesFromText(text: string): ReadonlyArray<ParsedIssueReference> {
  const matches: ParsedIssueReference[] = [];
  const urlRegex = /https?:\/\/[^\s<>"')]+/g;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const parsed = parseIssueUrl(match[0]);
    if (parsed && !matches.some((m) => m.url === parsed.url)) {
      matches.push(parsed);
    }
  }

  return matches;
}

/**
 * Format a parsed issue into a prompt context header for coding agents.
 */
export function formatIssueContextPrompt(issue: ParsedIssueReference): string {
  const trackerName =
    issue.tracker === "linear"
      ? "Linear"
      : issue.tracker === "jira"
        ? "Jira"
        : issue.tracker === "gitlab"
          ? "GitLab"
          : "GitHub";

  return `[${trackerName} Issue Reference: ${issue.id}]
Issue URL: ${issue.url}
${issue.title ? `Title / Slug: ${issue.title}\n` : ""}${issue.workspace ? `Workspace / Project: ${issue.workspace}\n` : ""}Suggested Branch: ${issue.suggestedBranchName}`;
}
