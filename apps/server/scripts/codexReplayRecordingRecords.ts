const REPLAY_WORKSPACE_PLACEHOLDER = "<workspace>";

function withWorkspacePlaceholder(value: unknown, workspace: string): unknown {
  if (value === workspace) {
    return REPLAY_WORKSPACE_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => withWorkspacePlaceholder(entry, workspace));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withWorkspacePlaceholder(entry, workspace)]),
  );
}

/**
 * Codex supports multiple provider threads in one app-server session, so native
 * fork recording keeps the request ids emitted by that single client. Outbound
 * frames name the recording cwd `<workspace>`, which replay swaps for its own
 * checkpoint workspace.
 */
export function codexReplayRecordingOutputRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  options: { readonly workspace: string },
): ReadonlyArray<Record<string, unknown>> {
  return records.map((record) =>
    record.type === "expect_outbound"
      ? { ...record, frame: withWorkspacePlaceholder(record.frame, options.workspace) }
      : record,
  );
}
