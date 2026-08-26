import { normalizeText } from "../core/hash.js";
import type { PromptDocument } from "../types.js";

export interface FieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
  beforeChars: number;
  afterChars: number;
}

/**
 * Describe what differs between two documents, without ever putting prompt
 * bodies into the result — reports and logs should be safe to paste anywhere.
 */
export function diffDocuments(
  before: PromptDocument,
  after: PromptDocument,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const beforeText = normalizeText(before.text ?? "");
  const afterText = normalizeText(after.text ?? "");
  if (beforeText !== afterText) {
    changes.push({
      field: "text",
      kind:
        beforeText === "" ? "added" : afterText === "" ? "removed" : "changed",
      beforeChars: beforeText.length,
      afterChars: afterText.length,
    });
  }

  const keys = new Set([
    ...Object.keys(before.fields ?? {}),
    ...Object.keys(after.fields ?? {}),
  ]);
  for (const key of [...keys].sort()) {
    const beforeValue = normalizeText(before.fields?.[key] ?? "");
    const afterValue = normalizeText(after.fields?.[key] ?? "");
    if (beforeValue === afterValue) continue;
    changes.push({
      field: key,
      kind:
        beforeValue === ""
          ? "added"
          : afterValue === ""
            ? "removed"
            : "changed",
      beforeChars: beforeValue.length,
      afterChars: afterValue.length,
    });
  }
  return changes;
}

/** One-line, secret-free summary of a diff, for logs and commit messages. */
export function summarizeChanges(changes: FieldChange[]): string {
  if (changes.length === 0) return "no changes";
  return changes
    .map((change) => {
      const delta = change.afterChars - change.beforeChars;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      return `${change.field} ${change.kind} (${sign} chars)`;
    })
    .join(", ");
}
