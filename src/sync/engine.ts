import { ConflictError, UnsupportedAgentError } from "../core/errors.js";
import { hashDocument, shortHash } from "../core/hash.js";
import { silentLogger, type Logger } from "../core/logger.js";
import {
  CONFIG_NAMESPACE,
  LangfuseClient,
  type VoiceProviderConfig,
} from "../langfuse/client.js";
import { createProvider } from "../providers/index.js";
import type {
  LangfusePrompt,
  PromptDocument,
  ProviderName,
  RemotePrompt,
  VoiceProvider,
} from "../types.js";
import type { AppConfig, Binding } from "../config/load.js";
import { diffDocuments, summarizeChanges, type FieldChange } from "./diff.js";
import { renderDocument } from "./render.js";
import { createStateStore, type BindingState, type StateStore } from "./state.js";

export type SyncAction =
  | "in-sync"
  | "pushed"
  | "pulled"
  | "created-prompt"
  | "conflict"
  | "skipped"
  | "error";

export interface BindingResult {
  bindingId: string;
  provider: ProviderName;
  agentId: string;
  prompt: string;
  action: SyncAction;
  /** True when `dryRun` stopped this from being written. */
  planned: boolean;
  changes: FieldChange[];
  summary: string;
  langfuseVersion?: number;
  error?: string;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  results: BindingResult[];
  counts: Record<SyncAction, number>;
  /** True when nothing failed and no conflict was left unresolved. */
  ok: boolean;
}

export interface SyncEngineOptions {
  config: AppConfig;
  logger?: Logger;
  stateStore?: StateStore;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injected in tests to bypass the HTTP adapters entirely. */
  providerFactory?: (name: ProviderName) => VoiceProvider;
  langfuseClient?: LangfuseClient;
  /** Injected in tests so commit messages are deterministic. */
  now?: () => Date;
}

export interface RunOptions {
  /** Compute and report the plan without writing to either side. */
  dryRun?: boolean;
  /** Restrict the run to these binding ids or Langfuse prompt names. */
  only?: string[];
  /** Override the configured direction for this run. */
  direction?: Binding["direction"];
}

/**
 * The synchroniser.
 *
 * Each binding is a three-way merge between the Langfuse prompt, the live
 * provider prompt, and the hashes recorded at the last successful sync. The
 * recorded hashes are what let bidirectional mode tell "Langfuse moved" from
 * "the provider dashboard moved" instead of guessing.
 */
export class SyncEngine {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly state: StateStore;
  private readonly langfuse: LangfuseClient;
  private readonly providers = new Map<ProviderName, VoiceProvider>();
  private readonly providerFactory: (name: ProviderName) => VoiceProvider;
  private readonly now: () => Date;

  constructor(options: SyncEngineOptions) {
    this.config = options.config;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.state =
      options.stateStore ?? createStateStore(this.config.state);
    this.langfuse =
      options.langfuseClient ??
      new LangfuseClient({
        baseUrl: this.config.langfuse.baseUrl,
        publicKey: this.config.langfuse.publicKey,
        secretKey: this.config.langfuse.secretKey,
        logger: this.logger,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
      });
    this.providerFactory =
      options.providerFactory ??
      ((name: ProviderName) => {
        const credentials = this.config.providers[name];
        return createProvider(name, {
          apiKey: credentials?.apiKey ?? "",
          ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
          logger: this.logger,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
        });
      });
  }

  /** Resolve (and cache) the adapter for a provider. */
  provider(name: ProviderName): VoiceProvider {
    let instance = this.providers.get(name);
    if (!instance) {
      instance = this.providerFactory(name);
      this.providers.set(name, instance);
    }
    return instance;
  }

  /** Run every enabled binding. One failure never stops the others. */
  async run(options: RunOptions = {}): Promise<SyncReport> {
    const startedAt = this.now();
    const selected = selectBindings(this.config.bindings, options.only);
    const results: BindingResult[] = [];

    for (const binding of selected) {
      if (!binding.enabled) {
        results.push(
          baseResult(binding, "skipped", "binding is disabled", false),
        );
        continue;
      }
      try {
        results.push(await this.syncBinding(binding, options));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.error("binding sync failed", {
          binding: binding.id,
          error: message,
        });
        results.push({
          ...baseResult(binding, "error", message, false),
          error: message,
        });
      }
    }

    const finishedAt = this.now();
    const counts = countActions(results);
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      dryRun: options.dryRun === true,
      results,
      counts,
      ok: counts.error === 0 && counts.conflict === 0,
    };
  }

  /** Sync one binding. Exposed so callers can drive a single agent. */
  async syncBinding(
    binding: Binding,
    options: RunOptions = {},
  ): Promise<BindingResult> {
    const log = this.logger.child({ binding: binding.id });
    const dryRun = options.dryRun === true;
    const direction = options.direction ?? binding.direction;
    const provider = this.provider(binding.provider);
    const target = { agentId: binding.agentId, options: binding.options };

    let remote: RemotePrompt;
    try {
      remote = await provider.getPrompt(target);
    } catch (error) {
      if (error instanceof UnsupportedAgentError) {
        return baseResult(binding, "skipped", error.message, false);
      }
      throw error;
    }

    const langfusePrompt = await this.langfuse.getPrompt(binding.prompt, {
      label: binding.label,
    });

    // The full provider-side document. Used when writing to Langfuse, so a
    // new version records everything the agent actually holds.
    const fullProviderDoc = project(remote.document, binding.syncFields);
    const langfuseDoc = langfusePrompt
      ? project(langfusePrompt.document, binding.syncFields)
      : null;

    // The prompt does not exist in Langfuse yet: seed it from the live agent,
    // whatever the configured direction. There is nothing to push, and refusing
    // would make first-time onboarding a manual step.
    if (!langfuseDoc) {
      if (isEmptyDocument(fullProviderDoc)) {
        return baseResult(
          binding,
          "skipped",
          `Langfuse prompt "${binding.prompt}" does not exist and the agent has no prompt to seed it from`,
          false,
        );
      }
      const changes = diffDocuments({ text: "", fields: {} }, fullProviderDoc);
      if (dryRun) {
        return {
          ...baseResult(
            binding,
            "created-prompt",
            `would create Langfuse prompt "${binding.prompt}" from ${binding.provider} (${summarizeChanges(changes)})`,
            true,
          ),
          changes,
        };
      }
      const created = await this.writeLangfuseVersion(
        binding,
        fullProviderDoc,
        remote,
        langfusePrompt,
        `Imported from ${binding.provider} agent ${binding.agentId}`,
      );
      await this.recordState(
        binding,
        fullProviderDoc,
        fullProviderDoc,
        created.version,
        "pull",
      );
      log.info("created langfuse prompt from provider", {
        prompt: binding.prompt,
        version: created.version,
      });
      return {
        ...baseResult(
          binding,
          "created-prompt",
          `created Langfuse prompt "${binding.prompt}" v${created.version} from ${binding.provider}`,
          false,
        ),
        changes,
        langfuseVersion: created.version,
      };
    }

    // Which extra fields this binding is responsible for.
    //
    // The Langfuse prompt declares them: a field it carries is managed, one it
    // does not is left to the provider. That matters for a prompt authored by
    // hand in the Langfuse UI, which carries no field bookkeeping at all —
    // without this rule its empty field set would read as "delete the agent's
    // greeting", and every run would report a change it never actually makes.
    // A pull captures the agent's full field set, so anything unmanaged today
    // becomes managed the first time the provider side wins.
    const managed = new Set(Object.keys(langfuseDoc.fields));
    const providerDoc = projectOnto(fullProviderDoc, managed);

    // What the provider *should* hold if Langfuse is authoritative. When a
    // binding declares variables, this differs from the stored template.
    const renderedLangfuseDoc = renderDocument(langfuseDoc, binding.variables);

    if (hashDocument(renderedLangfuseDoc) === hashDocument(providerDoc)) {
      await this.recordState(
        binding,
        langfuseDoc,
        fullProviderDoc,
        langfusePrompt!.version,
        "none",
      );
      return {
        ...baseResult(binding, "in-sync", "already in sync", false),
        langfuseVersion: langfusePrompt!.version,
      };
    }

    const decision = await this.decide(
      binding,
      direction,
      langfuseDoc,
      fullProviderDoc,
    );

    if (decision === "conflict") {
      const message =
        `Both sides changed since the last sync and conflictPolicy is "manual". ` +
        `Resolve by re-running with --conflict prefer-langfuse or --conflict prefer-provider, ` +
        `or by making the two sides match.`;
      log.warn("sync conflict", { binding: binding.id });
      if (!dryRun && binding.conflictPolicy === "manual") {
        // Surfaced as a result rather than thrown, so one conflicted binding
        // does not abort the rest of the run.
        return {
          ...baseResult(binding, "conflict", message, false),
          changes: diffDocuments(renderedLangfuseDoc, providerDoc),
          langfuseVersion: langfusePrompt!.version,
        };
      }
      return {
        ...baseResult(binding, "conflict", message, dryRun),
        changes: diffDocuments(renderedLangfuseDoc, providerDoc),
        langfuseVersion: langfusePrompt!.version,
      };
    }

    if (decision === "push") {
      const changes = diffDocuments(providerDoc, renderedLangfuseDoc);
      const summary = `Langfuse v${langfusePrompt!.version} -> ${binding.provider} ${binding.agentId} (${summarizeChanges(changes)})`;
      if (dryRun) {
        return {
          ...baseResult(binding, "pushed", `would push ${summary}`, true),
          changes,
          langfuseVersion: langfusePrompt!.version,
        };
      }
      await provider.setPrompt(target, renderedLangfuseDoc);
      // setPrompt writes the text and the managed fields, and leaves every
      // other field on the agent alone — so the agent's full document
      // afterwards is the old one with the managed fields overwritten.
      // Recording anything narrower would read as a provider-side edit on the
      // next pass.
      await this.recordState(
        binding,
        langfuseDoc,
        {
          text: renderedLangfuseDoc.text,
          fields: { ...fullProviderDoc.fields, ...renderedLangfuseDoc.fields },
        },
        langfusePrompt!.version,
        "push",
      );
      log.info("pushed prompt to provider", {
        prompt: binding.prompt,
        version: langfusePrompt!.version,
        changes: summarizeChanges(changes),
      });
      return {
        ...baseResult(binding, "pushed", `pushed ${summary}`, false),
        changes,
        langfuseVersion: langfusePrompt!.version,
      };
    }

    // decision === "pull"
    const changes = diffDocuments(renderedLangfuseDoc, fullProviderDoc);
    const summary = `${binding.provider} ${binding.agentId} -> Langfuse "${binding.prompt}" (${summarizeChanges(changes)})`;
    if (dryRun) {
      return {
        ...baseResult(binding, "pulled", `would pull ${summary}`, true),
        changes,
        langfuseVersion: langfusePrompt!.version,
      };
    }
    const created = await this.writeLangfuseVersion(
      binding,
      fullProviderDoc,
      remote,
      langfusePrompt,
      `Synced from ${binding.provider} agent ${binding.agentId}: ${summarizeChanges(changes)}`,
    );
    await this.recordState(
      binding,
      fullProviderDoc,
      fullProviderDoc,
      created.version,
      "pull",
    );
    log.info("pulled prompt into langfuse", {
      prompt: binding.prompt,
      version: created.version,
      changes: summarizeChanges(changes),
    });
    return {
      ...baseResult(binding, "pulled", `pulled ${summary} as v${created.version}`, false),
      changes,
      langfuseVersion: created.version,
    };
  }

  /**
   * Choose what to do when the two sides differ.
   *
   * With recorded state this is a real three-way merge. Without it (first run,
   * `memory` driver, cleared state file) neither side can be shown to have
   * moved, so the binding's conflict policy decides — which is why the default
   * policy is `manual` rather than a silent overwrite.
   */
  private async decide(
    binding: Binding,
    direction: Binding["direction"],
    langfuseDoc: PromptDocument,
    /**
     * The provider's *full* document, never one projected onto the managed
     * field set. "Did this side change?" has to be a property of that side
     * alone: the managed set is derived from whatever the Langfuse prompt
     * happens to carry, so projecting here would make a Langfuse-side edit
     * that drops the field bookkeeping look like a provider-side edit too,
     * and turn an ordinary push into a phantom conflict.
     */
    fullProviderDoc: PromptDocument,
  ): Promise<"push" | "pull" | "conflict"> {
    if (direction === "langfuse-to-provider") return "push";
    if (direction === "provider-to-langfuse") return "pull";

    const state = await this.state.get(binding.id);
    if (!state) return applyPolicy(binding.conflictPolicy);

    const langfuseChanged = hashDocument(langfuseDoc) !== state.langfuseHash;
    const providerChanged = hashDocument(fullProviderDoc) !== state.providerHash;

    if (langfuseChanged && !providerChanged) return "push";
    if (providerChanged && !langfuseChanged) return "pull";
    // Both moved, or neither did while the sides still differ (a previous run
    // that failed part-way). Either way there is no safe automatic answer.
    return applyPolicy(binding.conflictPolicy);
  }

  /** Append a Langfuse version carrying the provider's current content. */
  private async writeLangfuseVersion(
    binding: Binding,
    document: PromptDocument,
    remote: RemotePrompt,
    previous: LangfusePrompt | null,
    commitMessage: string,
  ): Promise<LangfusePrompt> {
    const voiceConfig: VoiceProviderConfig = {
      provider: binding.provider,
      agentId: binding.agentId,
      fields: document.fields,
      origin: remote.origin,
      syncedAt: this.now().toISOString(),
      syncedFrom: "provider",
    };
    // Preserve any unrelated application config the prompt already carried;
    // this package owns exactly one key inside it.
    const config = { ...(previous?.config ?? {}), [CONFIG_NAMESPACE]: voiceConfig };
    return this.langfuse.createPromptVersion({
      name: binding.prompt,
      document,
      labels: [binding.label],
      tags: binding.tags,
      commitMessage,
      config,
    });
  }

  private async recordState(
    binding: Binding,
    langfuseDoc: PromptDocument,
    providerDoc: PromptDocument,
    langfuseVersion: number,
    lastDirection: BindingState["lastDirection"],
  ): Promise<void> {
    await this.state.set(binding.id, {
      langfuseHash: hashDocument(langfuseDoc),
      providerHash: hashDocument(providerDoc),
      langfuseVersion,
      lastSyncAt: this.now().toISOString(),
      lastDirection,
    });
  }
}

function applyPolicy(policy: Binding["conflictPolicy"]): "push" | "pull" | "conflict" {
  if (policy === "prefer-langfuse") return "push";
  if (policy === "prefer-provider") return "pull";
  return "conflict";
}

/** Keep only the fields a binding is responsible for. */
function projectOnto(
  document: PromptDocument,
  managed: Set<string>,
): PromptDocument {
  const fields: Record<string, string> = {};
  for (const key of managed) {
    const value = document.fields[key];
    if (typeof value === "string") fields[key] = value;
  }
  return { text: document.text, fields };
}

/** Drop `fields` when a binding only wants the main prompt body synced. */
function project(document: PromptDocument, syncFields: boolean): PromptDocument {
  return syncFields
    ? { text: document.text ?? "", fields: document.fields ?? {} }
    : { text: document.text ?? "", fields: {} };
}

function isEmptyDocument(document: PromptDocument): boolean {
  return (
    (document.text ?? "").trim() === "" &&
    Object.values(document.fields ?? {}).every((v) => (v ?? "").trim() === "")
  );
}

function selectBindings(bindings: Binding[], only?: string[]): Binding[] {
  if (!only || only.length === 0) return bindings;
  const wanted = new Set(only);
  return bindings.filter(
    (binding) =>
      wanted.has(binding.id) ||
      wanted.has(binding.prompt) ||
      wanted.has(binding.agentId),
  );
}

function baseResult(
  binding: Binding,
  action: SyncAction,
  summary: string,
  planned: boolean,
): BindingResult {
  return {
    bindingId: binding.id,
    provider: binding.provider,
    agentId: binding.agentId,
    prompt: binding.prompt,
    action,
    planned,
    changes: [],
    summary,
  };
}

function countActions(results: BindingResult[]): Record<SyncAction, number> {
  const counts: Record<SyncAction, number> = {
    "in-sync": 0,
    pushed: 0,
    pulled: 0,
    "created-prompt": 0,
    conflict: 0,
    skipped: 0,
    error: 0,
  };
  for (const result of results) counts[result.action] += 1;
  return counts;
}

export { ConflictError, shortHash };
