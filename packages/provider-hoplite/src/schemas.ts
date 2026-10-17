import * as Schema from "effect/Schema";

export const HopliteCredentials = Schema.Struct({
  apiKey: Schema.optional(Schema.NonEmptyString),
  accessToken: Schema.optional(Schema.NonEmptyString),
  refreshToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.optional(Schema.Number),
  clientId: Schema.optional(Schema.String),
  redirectUri: Schema.optional(Schema.String),
});
export type HopliteCredentials = typeof HopliteCredentials.Type;

export const HopliteErrorCode = Schema.Literals([
  "insufficient_credits",
  "subscription_required",
  "creation_budget_exceeded",
  "rate_limited",
]);

export class HopliteApiError extends Schema.TaggedError<HopliteApiError>()("HopliteApiError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfter: Schema.optional(Schema.Number),
  errorCode: Schema.optional(HopliteErrorCode),
}) {
  override get message() {
    if (this.errorCode === "insufficient_credits")
      return "Hoplite has insufficient credits. Add credits in Hoplite workspace billing, then retry this operation.";
    if (this.status === 401)
      return "Hoplite sign-in expired or the API key was rejected. Sign in again or update the API key.";
    if (this.status === 403)
      return "Hoplite denied this operation. Check the API key's permissions and workspace/project access.";
    if (this.status === 402 || this.errorCode === "subscription_required")
      return "Hoplite requires available credits or plan access for this operation. Check Hoplite workspace billing, then retry.";
    if (
      this.status === 429 ||
      this.errorCode === "rate_limited" ||
      this.errorCode === "creation_budget_exceeded"
    )
      return this.retryAfter
        ? `Hoplite is rate limited. Wait ${this.retryAfter} seconds, then retry the same operation.`
        : "Hoplite is rate limited. Wait before retrying the same operation.";
    return this.status
      ? `Hoplite ${this.operation} failed (HTTP ${this.status}).`
      : `Hoplite ${this.operation} failed. Check the API key and network connection.`;
  }
}
