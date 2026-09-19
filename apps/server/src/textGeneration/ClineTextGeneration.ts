/**
 * ClineTextGeneration — text generation seam for the Cline driver (commit
 * messages, PR content, titles).
 *
 * Cline can generate this text with a headless run, but wiring the four call
 * sites to a real prompt budget is out of scope for the initial driver: the
 * instance reports its text-generation capability as failing so commit/PR
 * writers can fall back to another provider instance instead of silently
 * burning model turns on unstructured prompts.
 *
 * @module textGeneration/ClineTextGeneration
 */
import type { ClineSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Cline text generation is not supported yet. Choose another provider instance for commit and PR text.",
    }),
  );

export const makeClineTextGeneration = (_config: ClineSettings): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  });
