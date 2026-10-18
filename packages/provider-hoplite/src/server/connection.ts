import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { HopliteSettings } from "../settings.ts";
import { hopliteApiUrl, makeHopliteApi, type HopliteApiError, type HopliteProject } from "./api.ts";
import { makeHopliteKeyStore } from "./auth.ts";
import { matchHopliteProject, readGitHubRepositories } from "./projects.ts";

const PROJECTS_TTL_MS = 60_000;
const HOPLITE_APP_URL = "https://app.hoplite.sh";

export interface HopliteConnection {
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly projectId: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type HopliteConnector = Effect.Success<ReturnType<typeof makeHopliteConnector>>;

/** The CLI relays to this endpoint with the key and never opens a browser sign-in. */
export function hopliteAcpEnvironment(connection: HopliteConnection): NodeJS.ProcessEnv {
  const url = new URL("/acp", connection.apiBaseUrl);
  url.searchParams.set("projectId", connection.projectId);
  return {
    ...connection.environment,
    HOPLITE_ACP_URL: url.toString(),
    HOPLITE_ACP_API_KEY: connection.apiKey,
    HOPLITE_NO_UPDATE_CHECK: "1",
  };
}

const sessionError = (errorMessage: string, cause?: unknown) =>
  new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage,
    ...(cause === undefined ? {} : { cause }),
  });

/** Owns an instance's stored key and maps a workspace folder to the Hoplite project it runs in. */
export const makeHopliteConnector = Effect.fn("makeHopliteConnector")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HopliteSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const host = yield* ProviderHost.ProviderHost;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const credentials = yield* host.credentials("hoplite", input.instanceId);
  const keys = makeHopliteKeyStore(credentials).store;
  const apiBaseUrl = hopliteApiUrl(input.environment);
  const projectsCache = yield* Ref.make<
    | {
        readonly apiKey: string;
        readonly at: number;
        readonly projects: ReadonlyArray<HopliteProject>;
      }
    | undefined
  >(undefined);

  const api = (apiKey: string) =>
    makeHopliteApi({ baseUrl: apiBaseUrl, apiKey }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const listProjects = Effect.fnUntraced(function* (apiKey: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(projectsCache);
    if (cached?.apiKey === apiKey && now - cached.at < PROJECTS_TTL_MS) return cached.projects;
    const projects = yield* (yield* api(apiKey)).listProjects;
    yield* Ref.set(projectsCache, { apiKey, at: now, projects });
    return projects;
  });

  const resolveProject = Effect.fnUntraced(function* (apiKey: string, cwd: string) {
    const projects = yield* listProjects(apiKey).pipe(
      Effect.mapError((error: HopliteApiError) => sessionError(error.detail, error)),
    );
    const pinned = input.settings.projectId.trim();
    if (pinned) {
      const project = projects.find((candidate) => candidate.id === pinned);
      if (project) return project;
      return yield* sessionError(
        `The Hoplite project ${pinned} set in provider settings is not available to this account.`,
      );
    }
    const repositories = yield* readGitHubRepositories(cwd).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const match = matchHopliteProject(projects, repositories);
    switch (match._tag) {
      case "Matched":
        return match.project;
      case "NotGitHub":
        return yield* sessionError(
          "Hoplite runs threads on a GitHub repository, and this folder has no GitHub remote. Open a GitHub clone or pick a Hoplite project in provider settings.",
        );
      case "NotLinked":
        return yield* sessionError(
          `No Hoplite project is linked to ${match.repositories[0]}. Create one at ${HOPLITE_APP_URL}, or pick a project in provider settings.`,
        );
    }
  });

  const requireKey = keys.read.pipe(
    Effect.filterOrFail(
      (apiKey): apiKey is string => apiKey !== undefined,
      () => sessionError("Sign in to Hoplite in Settings → Providers to start this thread."),
    ),
  );

  return {
    credentials,
    keys,
    apiBaseUrl,
    api,
    listProjects,
    connect: (cwd: string) =>
      Effect.gen(function* () {
        const apiKey = yield* requireKey;
        const project = yield* resolveProject(apiKey, cwd);
        return {
          apiBaseUrl,
          apiKey,
          projectId: project.id,
          environment: input.environment,
        } satisfies HopliteConnection;
      }),
  };
});
