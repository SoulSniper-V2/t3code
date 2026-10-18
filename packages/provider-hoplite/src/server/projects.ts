import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import type { HopliteProject } from "./api.ts";

/**
 * Parses `git config --get-regexp` remote URLs into GitHub `owner/name`
 * repositories, origin first, since that is the remote a clone pushes to.
 */
export function githubRepositoriesFromRemoteConfig(output: string): ReadonlyArray<string> {
  const remotes = output.split(/\r?\n/).flatMap((line) => {
    const match = /^remote\.(.+)\.url\s+(\S+)$/.exec(line.trim());
    const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(match?.[2] ?? null);
    return match && repository ? [{ remote: match[1], repository }] : [];
  });
  const ordered = [
    ...remotes.filter((entry) => entry.remote === "origin"),
    ...remotes.filter((entry) => entry.remote !== "origin"),
  ];
  return [...new Set(ordered.map((entry) => entry.repository))];
}

export const readGitHubRepositories = (cwd: string) =>
  spawnAndCollect(
    "git",
    ChildProcess.make("git", ["-C", cwd, "config", "--get-regexp", "^remote\\..*\\.url$"]),
  ).pipe(
    Effect.map((result) =>
      result.code === 0 ? githubRepositoriesFromRemoteConfig(result.stdout) : [],
    ),
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

export type HopliteProjectMatch =
  | { readonly _tag: "Matched"; readonly project: HopliteProject }
  | { readonly _tag: "NotGitHub" }
  | { readonly _tag: "NotLinked"; readonly repositories: ReadonlyArray<string> };

/** Several projects can link one repository; pinning a project ID in settings picks between them. */
export function matchHopliteProject(
  projects: ReadonlyArray<HopliteProject>,
  repositories: ReadonlyArray<string>,
): HopliteProjectMatch {
  if (repositories.length === 0) return { _tag: "NotGitHub" };
  for (const repository of repositories) {
    const project = projects.find((candidate) =>
      candidate.repos.some((repo) => repo.repoFullName.toLowerCase() === repository.toLowerCase()),
    );
    if (project) return { _tag: "Matched", project };
  }
  return { _tag: "NotLinked", repositories };
}
