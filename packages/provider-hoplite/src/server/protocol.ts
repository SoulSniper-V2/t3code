import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

export const operationKey = (kind: string, id: string) =>
  `t3-${Hex.encode(sha256(new TextEncoder().encode(`${kind}:${id}`))).slice(0, 60)}`;

export const HopliteRun = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  finishedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type HopliteRun = typeof HopliteRun.Type;

export const HopliteActivity = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  toolName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputPreview: Schema.optional(Schema.String),
  outputPreview: Schema.optional(Schema.String),
  errorPreview: Schema.optional(Schema.String),
});

export const HopliteQuestion = Schema.Struct({
  questionId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  request: Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        header: Schema.String,
        multiSelect: Schema.Boolean,
        question: Schema.String,
        options: Schema.Array(
          Schema.Struct({
            label: Schema.String,
            description: Schema.String,
            preview: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
});

export const HopliteDraft = Schema.Struct({
  messageId: Schema.String,
  streamId: Schema.optional(Schema.String),
  revision: Schema.Number,
  kind: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  draft: Schema.optional(
    Schema.Struct({
      content: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    }),
  ),
});
export type HopliteDraft = typeof HopliteDraft.Type;

export const HopliteTranscript = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      createdAt: Schema.String,
      finishedAt: Schema.optional(Schema.String),
      entries: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          id: Schema.String,
          createdAt: Schema.String,
          completedAt: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          prompt: Schema.optional(Schema.String),
          summary: Schema.optional(Schema.String),
          toolName: Schema.optional(Schema.String),
          input: Schema.optional(Schema.String),
          output: Schema.optional(Schema.String),
          error: Schema.optional(Schema.String),
          label: Schema.optional(Schema.String),
          content: Schema.optional(Schema.String),
          role: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export class DraftSnapshots {
  private readonly revisions = new Map<
    string,
    { streamId: string | undefined; revision: number }
  >();
  private readonly persisted = new Set<string>();

  accept(draft: HopliteDraft): boolean {
    if (this.persisted.has(draft.messageId)) return false;
    const previous = this.revisions.get(draft.messageId);
    if (previous && previous.streamId === draft.streamId && previous.revision >= draft.revision)
      return false;
    this.revisions.set(draft.messageId, { streamId: draft.streamId, revision: draft.revision });
    return true;
  }

  settle(messageId: string) {
    this.revisions.delete(messageId);
    this.persisted.add(messageId);
  }
}
