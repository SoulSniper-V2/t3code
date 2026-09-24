import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import ProjectionThreadsAutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// V2 previews used either migration 53 (before PullRequestFilesViewed landed)
// or migrations 54-55 (after V2 took migration 54). This bridge preserves the
// V2 schema while restoring the fork's released migration sequence:
// 53 PullRequestFilesViewed, 54 ProjectionThreadsAutoSettleDisabledAt,
// 55 OrchestrationV2, 56 RemoveRedundantProjectionIndexes.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];

      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      const v2At53 = history.find((row) => row.migration_id === 53 && row.name === "OrchestrationV2");
      const v2At54 = history.find((row) => row.migration_id === 54 && row.name === "OrchestrationV2");
      if (v2At53 === undefined && v2At54 === undefined) return [];

      if (v2At53 !== undefined) {
        if (history.length !== 1) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade V2 preview migration 53 with unexpected later migrations.",
          });
        }

        yield* PullRequestFilesViewed;
        yield* ProjectionThreadsAutoSettleDisabledAt;
        yield* sql`
          UPDATE effect_sql_migrations SET migration_id = 55
          WHERE migration_id = 53 AND name = 'OrchestrationV2'
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (53, 'PullRequestFilesViewed'), (54, 'ProjectionThreadsAutoSettleDisabledAt')
        `;
        return [
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
        ] as const;
      }

      const hasV2Indexes = history.some(
        (row) => row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes",
      );
      const expectedHistoryLength = hasV2Indexes ? 3 : 2;
      const hasExpected53 = history.some(
        (row) => row.migration_id === 53 && row.name === "PullRequestFilesViewed",
      );
      if (history.length !== expectedHistoryLength || !hasExpected53) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview migrations 54-55 with unexpected later migrations.",
        });
      }

      yield* ProjectionThreadsAutoSettleDisabledAt;
      if (hasV2Indexes) {
        // Move the higher id first to avoid colliding with the V2 row at 54.
        yield* sql`
          UPDATE effect_sql_migrations SET migration_id = 56
          WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'
        `;
      }
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = 55
        WHERE migration_id = 54 AND name = 'OrchestrationV2'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')
      `;
      return [[54, "ProjectionThreadsAutoSettleDisabledAt"]] as const;
    }),
  );
});
