/**
 * Secrets reach this package from env vars and config files and end up near
 * log lines and error bodies. Every value that could be a credential goes
 * through here before it is written anywhere.
 */

const SECRET_KEY_PATTERN =
  /(api[-_]?key|secret|token|password|authorization|xi[-_]?api[-_]?key|private[-_]?key)/i;

/** Replace a secret with a fingerprint that is still useful for debugging. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "<unset>";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/** Recursively mask any object entry whose key looks like a credential. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? typeof entry === "string"
        ? maskSecret(entry)
        : "***"
      : redactObject(entry, depth + 1);
  }
  return out as unknown as T;
}

/**
 * Mask anything in free text that looks like a bearer token or a known
 * provider key prefix, for error bodies echoed back by an API.
 */
export function redactText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1***")
    .replace(/\b(sk|pk|key)[-_][A-Za-z0-9]{8,}\b/g, "$1_***");
}
