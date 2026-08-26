import { HttpClient } from "../core/http.js";
import { silentLogger, type Logger } from "../core/logger.js";
import type {
  AgentSummary,
  PromptDocument,
  ProviderTarget,
  RemotePrompt,
  VoiceProvider,
} from "../types.js";

export interface VapiProviderOptions {
  /** Vapi *private* API key. The public key cannot read or write assistants. */
  apiKey: string;
  baseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
}

interface VapiMessage {
  role: string;
  content: string | null;
}

interface VapiAssistant {
  id: string;
  name?: string | null;
  firstMessage?: string | null;
  model?: {
    provider?: string;
    model?: string;
    messages?: VapiMessage[];
    [key: string]: unknown;
  } | null;
}

/**
 * Vapi adapter.
 *
 * The prompt is the first `system` message of `model.messages`. Vapi replaces
 * the `model` object wholesale on PATCH, so this is strictly read-modify-write:
 * we resend the model we just read with only the system message swapped.
 */
export class VapiProvider implements VoiceProvider {
  readonly name = "vapi" as const;
  readonly supportedFields = ["firstMessage"] as const;

  private readonly http: HttpClient;
  private readonly logger: Logger;

  constructor(options: VapiProviderOptions) {
    this.logger = options.logger ?? silentLogger;
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? "https://api.vapi.ai",
      headers: { authorization: `Bearer ${options.apiKey}` },
      logger: this.logger.child({ provider: "vapi" }),
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async listAgents(): Promise<AgentSummary[]> {
    const assistants = await this.http.request<VapiAssistant[]>({
      method: "GET",
      path: "/assistant",
      query: { limit: 1000 },
    });
    return (assistants ?? []).map((assistant) => ({
      id: assistant.id,
      name: assistant.name ?? assistant.id,
      syncable: true,
      detail: {
        model: assistant.model?.model ?? "unknown",
        provider: assistant.model?.provider ?? "unknown",
      },
    }));
  }

  async getPrompt(target: ProviderTarget): Promise<RemotePrompt> {
    const assistant = await this.fetchAssistant(target.agentId);
    const systemMessage = (assistant.model?.messages ?? []).find(
      (message) => message.role === "system",
    );
    const fields: Record<string, string> = {};
    if (assistant.firstMessage) fields["firstMessage"] = assistant.firstMessage;
    return {
      document: { text: systemMessage?.content ?? "", fields },
      origin: { agentId: target.agentId },
    };
  }

  async setPrompt(
    target: ProviderTarget,
    document: PromptDocument,
  ): Promise<void> {
    const assistant = await this.fetchAssistant(target.agentId);
    const model = assistant.model ?? {};
    const messages = [...(model.messages ?? [])];

    const systemIndex = messages.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      const existing = messages[systemIndex] as VapiMessage;
      messages[systemIndex] = { ...existing, content: document.text };
    } else {
      messages.unshift({ role: "system", content: document.text });
    }

    const body: Record<string, unknown> = { model: { ...model, messages } };
    if (typeof document.fields["firstMessage"] === "string") {
      body["firstMessage"] = document.fields["firstMessage"];
    }

    await this.http.request({
      method: "PATCH",
      path: `/assistant/${encodeURIComponent(target.agentId)}`,
      body,
    });
    this.logger.debug("updated vapi assistant", { assistantId: target.agentId });
  }

  private async fetchAssistant(id: string): Promise<VapiAssistant> {
    return this.http.request<VapiAssistant>({
      method: "GET",
      path: `/assistant/${encodeURIComponent(id)}`,
    });
  }
}
