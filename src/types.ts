/**
 * Canonical, provider-neutral types shared by the Langfuse client, the voice
 * provider adapters and the sync engine.
 */

/** Identifier of a supported voice platform. */
export type ProviderName = "retell" | "elevenlabs" | "vapi";

/** Which way content is allowed to flow for a binding. */
export type SyncDirection =
  | "langfuse-to-provider"
  | "provider-to-langfuse"
  | "bidirectional";

/** How to resolve a bidirectional sync where both sides changed. */
export type ConflictPolicy = "prefer-langfuse" | "prefer-provider" | "manual";

/**
 * The unit of synchronisation.
 *
 * `text` is the agent's system prompt and is stored as the body of a Langfuse
 * text prompt. `fields` carries the smaller provider-specific strings that
 * belong to the same edit (a greeting, a per-state prompt, ...) and round-trips
 * through the Langfuse prompt `config`. Both participate in the content hash,
 * so a change to a greeting is a tracked prompt change like any other.
 */
export interface PromptDocument {
  text: string;
  fields: Record<string, string>;
}

/** A prompt as it currently exists on a voice provider. */
export interface RemotePrompt {
  document: PromptDocument;
  /**
   * Opaque provider-side identifiers describing where the prompt was read
   * from (agent id, Retell LLM id, ...). Written back into the Langfuse
   * prompt config so a prompt version records its origin.
   */
  origin: Record<string, string>;
}

/** A prompt as it currently exists in Langfuse. */
export interface LangfusePrompt {
  name: string;
  version: number;
  type: "text" | "chat";
  document: PromptDocument;
  labels: string[];
  tags: string[];
  commitMessage?: string | null;
  config: Record<string, unknown>;
}

/** A single agent as returned by a provider's list endpoint. */
export interface AgentSummary {
  id: string;
  name: string;
  /** Whether this package can read/write a prompt for this agent. */
  syncable: boolean;
  /** Human-readable reason when `syncable` is false. */
  reason?: string;
  /** Extra provider detail worth showing in `list` output. */
  detail?: Record<string, string>;
}

/** Everything a provider adapter needs to address one agent. */
export interface ProviderTarget {
  agentId: string;
  /**
   * Optional provider-specific overrides, e.g. Retell `llmId` to skip the
   * agent lookup, or `version` to pin a versioned resource.
   */
  options?: Record<string, string | number | boolean>;
}

/**
 * A voice platform adapter. Adapters are intentionally thin: read the prompt,
 * write the prompt, list what is available. All conflict handling, hashing and
 * versioning lives in the sync engine.
 */
export interface VoiceProvider {
  readonly name: ProviderName;
  /** Field keys (besides `text`) this provider can sync, for docs and diffs. */
  readonly supportedFields: readonly string[];
  listAgents(): Promise<AgentSummary[]>;
  getPrompt(target: ProviderTarget): Promise<RemotePrompt>;
  setPrompt(target: ProviderTarget, document: PromptDocument): Promise<void>;
}
