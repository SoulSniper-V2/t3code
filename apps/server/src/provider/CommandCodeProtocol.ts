/**
 * Command Code headless NDJSON protocol helpers shared by the provider adapters.
 *
 * @module provider/CommandCodeProtocol
 */

export interface CommandCodeEventFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type CommandCodeParsedLine =
  | { readonly kind: "frame"; readonly frame: CommandCodeEventFrame }
  | {
      readonly kind: "result";
      readonly result: {
        readonly subtype?: unknown;
        readonly sessionId?: unknown;
        readonly stopReason?: unknown;
        readonly usage?: unknown;
        readonly error?: unknown;
        readonly finalText?: unknown;
      };
    }
  | { readonly kind: "skip" };

/** Parse one NDJSON line from `command-code -p --output-format json`. */
export function parseCommandCodeNdjsonLine(line: string): CommandCodeParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "skip" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "skip" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "skip" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["type"] === "event") {
    const event = record["event"];
    if (event !== null && typeof event === "object") {
      return { kind: "frame", frame: event as CommandCodeEventFrame };
    }
    return { kind: "skip" };
  }
  if (record["type"] === "result") {
    return {
      kind: "result",
      result: {
        subtype: record["subtype"],
        sessionId: record["sessionId"],
        stopReason: record["stopReason"],
        usage: record["usage"],
        error: record["error"],
        finalText: record["finalText"],
      },
    };
  }
  return { kind: "skip" };
}
