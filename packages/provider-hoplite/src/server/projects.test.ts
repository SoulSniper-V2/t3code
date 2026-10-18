import { describe, expect, it } from "vite-plus/test";

import { githubRepositoriesFromRemoteConfig, matchHopliteProject } from "./projects.ts";

const project = (id: string, ...repos: ReadonlyArray<string>) => ({
  id,
  name: id,
  repos: repos.map((repoFullName) => ({ repoFullName })),
});

describe("githubRepositoriesFromRemoteConfig", () => {
  it("puts origin first and ignores non-GitHub remotes", () => {
    expect(
      githubRepositoriesFromRemoteConfig(
        [
          "remote.upstream.url https://github.com/acme/web.git",
          "remote.mirror.url git@gitlab.com:acme/web.git",
          "remote.origin.url git@github.com:me/web.git",
        ].join("\n"),
      ),
    ).toEqual(["me/web", "acme/web"]);
  });

  it("returns nothing for a folder without GitHub remotes", () => {
    expect(githubRepositoriesFromRemoteConfig("")).toEqual([]);
  });
});

describe("matchHopliteProject", () => {
  const projects = [project("proj_api", "acme/api"), project("proj_web", "Acme/Web")];

  it("matches a remote to its linked project regardless of case", () => {
    expect(matchHopliteProject(projects, ["acme/web"])).toEqual({
      _tag: "Matched",
      project: projects[1],
    });
  });

  it("falls back to later remotes when origin is not linked", () => {
    expect(matchHopliteProject(projects, ["me/fork", "acme/api"])).toMatchObject({
      _tag: "Matched",
      project: { id: "proj_api" },
    });
  });

  it("names the repository when no project links it", () => {
    expect(matchHopliteProject(projects, ["me/fork"])).toEqual({
      _tag: "NotLinked",
      repositories: ["me/fork"],
    });
  });

  it("distinguishes a folder with no GitHub remote", () => {
    expect(matchHopliteProject(projects, [])).toEqual({ _tag: "NotGitHub" });
  });
});
