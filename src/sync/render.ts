import type { PromptDocument } from "../types.js";

/**
 * Substitute `{{name}}` placeholders with configured values.
 *
 * All three providers support `{{var}}` for runtime dynamic variables, so the
 * default is to substitute nothing and let templates pass through untouched.
 * Only the variables explicitly listed for a binding are replaced; anything
 * else is left for the provider to fill at call time.
 */
export function renderDocument(
  document: PromptDocument,
  variables: Record<string, string>,
): PromptDocument {
  if (Object.keys(variables).length === 0) return document;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(document.fields ?? {})) {
    fields[key] = renderText(value, variables);
  }
  return { text: renderText(document.text ?? "", variables), fields };
}

export function renderText(
  text: string,
  variables: Record<string, string>,
): string {
  return text.replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? (variables[name] as string)
        : match,
  );
}
