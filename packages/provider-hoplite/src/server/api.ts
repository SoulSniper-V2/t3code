import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const HOPLITE_API_URL = "https://api.hoplite.sh";

/** What a T3 thread needs: read the project, then create, continue and stop its thread. */
const REQUIRED_PERMISSIONS = [
  "project:read",
  "thread:create",
  "thread:read",
  "thread:update",
  "thread:stop",
] as const;

/** The CLI honors `HOPLITE_BASE_URL`, so the REST calls follow the same instance environment. */
export function hopliteApiUrl(environment: NodeJS.ProcessEnv): string {
  return environment.HOPLITE_BASE_URL?.trim().replace(/\/+$/, "") || HOPLITE_API_URL;
}

export class HopliteApiError extends Schema.TaggedError<HopliteApiError>()("HopliteApiError", {
  reason: Schema.Literals(["rejected", "unavailable"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isHopliteApiError = Schema.is(HopliteApiError);

const Capabilities = Schema.Struct({
  orgId: Schema.String,
  permissions: Schema.NullOr(Schema.Array(Schema.String)),
});

export const HopliteProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repos: Schema.Array(Schema.Struct({ repoFullName: Schema.String })),
});
export type HopliteProject = typeof HopliteProject.Type;

const Projects = Schema.Struct({ projects: Schema.Array(HopliteProject) });
const BillingPlan = Schema.Struct({ plan: Schema.Struct({ plan: Schema.String }) });

export interface HopliteApi {
  /** Verifies the key and that it can run threads. */
  readonly verify: Effect.Effect<{ readonly orgId: string }, HopliteApiError>;
  readonly listProjects: Effect.Effect<ReadonlyArray<HopliteProject>, HopliteApiError>;
  /** Needs `usage:read`, which a scoped service account may not have. */
  readonly readPlan: Effect.Effect<string, HopliteApiError>;
}

export const makeHopliteApi = Effect.fn("makeHopliteApi")(function* (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
}) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(input.apiKey)),
  );
  const get = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
    client.get(`${input.baseUrl}${path}`).pipe(
      Effect.filterOrFail(
        (response) => response.status !== 401 && response.status !== 403,
        () =>
          new HopliteApiError({
            reason: "rejected",
            detail: "Hoplite rejected this API key. It may have expired or been revoked.",
          }),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.timeout("15 seconds"),
      Effect.mapError((cause) =>
        isHopliteApiError(cause)
          ? cause
          : new HopliteApiError({
              reason: "unavailable",
              detail: "Could not reach Hoplite. Check your connection and try again.",
              cause,
            }),
      ),
    );

  const api: HopliteApi = {
    verify: get("/api/capabilities", Capabilities).pipe(
      Effect.flatMap(({ orgId, permissions }) => {
        const missing =
          permissions === null
            ? []
            : REQUIRED_PERMISSIONS.filter((permission) => !permissions.includes(permission));
        return missing.length === 0
          ? Effect.succeed({ orgId })
          : Effect.fail(
              new HopliteApiError({
                reason: "rejected",
                detail: `This Hoplite API key is missing ${missing.join(", ")}. Create a key with Projects: Read and Threads: Write.`,
              }),
            );
      }),
    ),
    listProjects: get("/api/projects", Projects).pipe(Effect.map(({ projects }) => projects)),
    readPlan: get("/api/billing/plan", BillingPlan).pipe(Effect.map(({ plan }) => plan.plan)),
  };
  return api;
});
