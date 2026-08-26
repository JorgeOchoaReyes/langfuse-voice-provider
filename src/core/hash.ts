import { createHash } from "node:crypto";
import type { PromptDocument } from "../types.js";

/**
 * Serialise a value with object keys sorted, so two structurally equal values
 * always produce the same bytes regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/**
 * Normalise line endings and trailing whitespace. Dashboards, editors and API
 * clients disagree about CRLF and trailing newlines; those differences should
 * never register as a prompt change.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/**
 * Content hash of a prompt document.
 *
 * Empty fields are dropped so "field absent" and "field set to empty string"
 * hash identically — providers are inconsistent about which they return, and
 * the difference is not a prompt change anyone wants a version for.
 */
export function hashDocument(document: PromptDocument): string {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(document.fields ?? {})) {
    if (typeof value === "string") {
      const normalized = normalizeText(value);
      if (normalized.length > 0) fields[key] = normalized;
    }
  }
  return createHash("sha256")
    .update(canonicalize({ text: normalizeText(document.text ?? ""), fields }))
    .digest("hex");
}

/** True when two documents carry the same prompt content. */
export function documentsEqual(a: PromptDocument, b: PromptDocument): boolean {
  return hashDocument(a) === hashDocument(b);
}

/** Short form of a hash, for log lines and commit messages. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
