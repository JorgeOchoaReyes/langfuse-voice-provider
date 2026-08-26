/**
 * In-memory stand-ins for the Langfuse, Retell, ElevenLabs and Vapi HTTP APIs.
 *
 * These mirror the request/response shapes of the real services (paths, auth
 * headers, nesting) so the adapters are exercised over the wire format they
 * will actually meet in production, not over a hand-shaped interface.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface LangfuseVersion {
  name: string;
  version: number;
  type: "text" | "chat";
  prompt: unknown;
  labels: string[];
  tags: string[];
  commitMessage: string | null;
  config: Record<string, unknown>;
}

export class MockApi {
  readonly requests: RecordedRequest[] = [];

  /** Langfuse prompt versions, newest last, keyed by prompt name. */
  readonly prompts = new Map<string, LangfuseVersion[]>();

  /** Retell LLM objects keyed by llm id. */
  readonly retellLlms = new Map<string, Record<string, unknown>>();
  /** Retell agents keyed by agent id. */
  readonly retellAgents = new Map<string, Record<string, unknown>>();
  /** ElevenLabs agents keyed by agent id. */
  readonly elevenLabsAgents = new Map<string, Record<string, unknown>>();
  /** Vapi assistants keyed by assistant id. */
  readonly vapiAssistants = new Map<string, Record<string, unknown>>();

  /** Force the next matching request to fail with this status. */
  failNext: { path: string; status: number } | undefined;

  /** A `fetch` implementation to hand to any client in this package. */
  readonly fetch: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers = normalizeHeaders(init?.headers);

    this.requests.push({
      method,
      url: url.toString(),
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    });

    if (this.failNext && url.pathname.includes(this.failNext.path)) {
      const status = this.failNext.status;
      this.failNext = undefined;
      return json({ error: "forced failure" }, status);
    }

    if (url.hostname.includes("langfuse")) {
      return this.handleLangfuse(method, url, body, headers);
    }
    if (url.hostname.includes("retellai")) {
      return this.handleRetell(method, url, body, headers);
    }
    if (url.hostname.includes("elevenlabs")) {
      return this.handleElevenLabs(method, url, body, headers);
    }
    if (url.hostname.includes("vapi")) {
      return this.handleVapi(method, url, body, headers);
    }
    return json({ error: `unmocked host ${url.hostname}` }, 404);
  }) as typeof fetch;

  /** Requests recorded for a path substring, for assertions. */
  requestsFor(pathFragment: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path.includes(pathFragment));
  }

  /** Latest version of a Langfuse prompt, or undefined. */
  latestPrompt(name: string): LangfuseVersion | undefined {
    const versions = this.prompts.get(name);
    return versions?.[versions.length - 1];
  }

  // --- Langfuse -----------------------------------------------------------

  private handleLangfuse(
    method: string,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    if (!headers["authorization"]?.startsWith("Basic ")) {
      return json({ error: "missing basic auth" }, 401);
    }

    const promptMatch = /^\/api\/public\/v2\/prompts\/(.+)$/.exec(url.pathname);
    if (method === "GET" && promptMatch) {
      const name = decodeURIComponent(promptMatch[1] as string);
      const versions = this.prompts.get(name) ?? [];
      const label = url.searchParams.get("label");
      const version = url.searchParams.get("version");
      let found: LangfuseVersion | undefined;
      if (version) {
        found = versions.find((entry) => entry.version === Number(version));
      } else if (label) {
        found = [...versions].reverse().find((entry) => entry.labels.includes(label));
      } else {
        found = [...versions].reverse().find((entry) => entry.labels.includes("production"));
      }
      return found ? json(found, 200) : json({ error: "not found" }, 404);
    }

    if (method === "POST" && url.pathname === "/api/public/v2/prompts") {
      const input = body as {
        name: string;
        prompt: unknown;
        type?: "text" | "chat";
        labels?: string[];
        tags?: string[];
        commitMessage?: string;
        config?: Record<string, unknown>;
      };
      const versions = this.prompts.get(input.name) ?? [];
      const labels = input.labels ?? [];
      // Real Langfuse moves a label to the newest version that claims it.
      for (const existing of versions) {
        existing.labels = existing.labels.filter((label) => !labels.includes(label));
      }
      const created: LangfuseVersion = {
        name: input.name,
        version: versions.length + 1,
        type: input.type ?? "text",
        prompt: input.prompt,
        labels,
        tags: input.tags ?? [],
        commitMessage: input.commitMessage ?? null,
        config: input.config ?? {},
      };
      versions.push(created);
      this.prompts.set(input.name, versions);
      return json(created, 201);
    }

    if (method === "GET" && url.pathname === "/api/public/v2/prompts") {
      const data = [...this.prompts.entries()].map(([name, versions]) => ({
        name,
        versions: versions.map((entry) => entry.version),
        labels: [...new Set(versions.flatMap((entry) => entry.labels))],
        tags: [...new Set(versions.flatMap((entry) => entry.tags))],
      }));
      return json({ data, meta: { totalPages: 1, page: 1 } }, 200);
    }

    return json({ error: "unmocked langfuse route" }, 404);
  }

  // --- Retell -------------------------------------------------------------

  private handleRetell(
    method: string,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    if (!headers["authorization"]?.startsWith("Bearer ")) {
      return json({ error: "missing bearer" }, 401);
    }

    if (method === "POST" && url.pathname === "/v2/list-agents") {
      return json([...this.retellAgents.values()], 200);
    }
    const getAgent = /^\/get-agent\/(.+)$/.exec(url.pathname);
    if (method === "GET" && getAgent) {
      const agent = this.retellAgents.get(decodeURIComponent(getAgent[1] as string));
      return agent ? json(agent, 200) : json({ error: "not found" }, 404);
    }
    const getLlm = /^\/get-retell-llm\/(.+)$/.exec(url.pathname);
    if (method === "GET" && getLlm) {
      const llm = this.retellLlms.get(decodeURIComponent(getLlm[1] as string));
      return llm ? json(llm, 200) : json({ error: "not found" }, 404);
    }
    const updateLlm = /^\/update-retell-llm\/(.+)$/.exec(url.pathname);
    if (method === "PATCH" && updateLlm) {
      const id = decodeURIComponent(updateLlm[1] as string);
      const llm = this.retellLlms.get(id);
      if (!llm) return json({ error: "not found" }, 404);
      // Retell merges the patch into the existing LLM.
      const updated = { ...llm, ...(body as Record<string, unknown>) };
      this.retellLlms.set(id, updated);
      return json(updated, 200);
    }
    return json({ error: "unmocked retell route" }, 404);
  }

  // --- ElevenLabs ---------------------------------------------------------

  private handleElevenLabs(
    method: string,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    if (!headers["xi-api-key"]) return json({ error: "missing xi-api-key" }, 401);

    if (method === "GET" && url.pathname === "/v1/convai/agents") {
      return json(
        {
          agents: [...this.elevenLabsAgents.values()].map((agent) => ({
            agent_id: agent["agent_id"],
            name: agent["name"],
          })),
          has_more: false,
          next_cursor: null,
        },
        200,
      );
    }
    const single = /^\/v1\/convai\/agents\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const id = decodeURIComponent(single[1] as string);
      const agent = this.elevenLabsAgents.get(id);
      if (!agent) return json({ error: "not found" }, 404);
      if (method === "GET") return json(agent, 200);
      if (method === "PATCH") {
        const updated = { ...agent, ...(body as Record<string, unknown>) };
        this.elevenLabsAgents.set(id, updated);
        return json(updated, 200);
      }
    }
    return json({ error: "unmocked elevenlabs route" }, 404);
  }

  // --- Vapi ---------------------------------------------------------------

  private handleVapi(
    method: string,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    if (!headers["authorization"]?.startsWith("Bearer ")) {
      return json({ error: "missing bearer" }, 401);
    }

    if (method === "GET" && url.pathname === "/assistant") {
      return json([...this.vapiAssistants.values()], 200);
    }
    const single = /^\/assistant\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const id = decodeURIComponent(single[1] as string);
      const assistant = this.vapiAssistants.get(id);
      if (!assistant) return json({ error: "not found" }, 404);
      if (method === "GET") return json(assistant, 200);
      if (method === "PATCH") {
        const updated = { ...assistant, ...(body as Record<string, unknown>) };
        this.vapiAssistants.set(id, updated);
        return json(updated, 200);
      }
    }
    return json({ error: "unmocked vapi route" }, 404);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normalizeHeaders(
  headers: NonNullable<Parameters<typeof fetch>[1]>["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** Seed a Retell agent plus the LLM it points at. */
export function seedRetell(
  api: MockApi,
  options: {
    agentId: string;
    llmId: string;
    generalPrompt: string;
    beginMessage?: string;
    states?: Array<{ name: string; state_prompt: string }>;
  },
): void {
  api.retellAgents.set(options.agentId, {
    agent_id: options.agentId,
    agent_name: "Support line",
    response_engine: { type: "retell-llm", llm_id: options.llmId },
  });
  api.retellLlms.set(options.llmId, {
    llm_id: options.llmId,
    general_prompt: options.generalPrompt,
    begin_message: options.beginMessage ?? null,
    states: options.states ?? null,
    model: "gpt-5",
  });
}

export function seedElevenLabs(
  api: MockApi,
  options: { agentId: string; prompt: string; firstMessage?: string },
): void {
  api.elevenLabsAgents.set(options.agentId, {
    agent_id: options.agentId,
    name: "Onboarding",
    conversation_config: {
      tts: { voice_id: "voice_123", stability: 0.4 },
      asr: { quality: "high" },
      agent: {
        prompt: { prompt: options.prompt, llm: "gpt-4o", temperature: 0.2 },
        first_message: options.firstMessage ?? "",
        language: "en",
      },
    },
  });
}

export function seedVapi(
  api: MockApi,
  options: { assistantId: string; prompt: string; firstMessage?: string },
): void {
  api.vapiAssistants.set(options.assistantId, {
    id: options.assistantId,
    name: "Outbound qualifier",
    firstMessage: options.firstMessage ?? "",
    model: {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      messages: [{ role: "system", content: options.prompt }],
    },
  });
}

/** Seed a Langfuse prompt version directly. */
export function seedLangfusePrompt(
  api: MockApi,
  options: {
    name: string;
    text: string;
    label?: string;
    fields?: Record<string, string>;
    config?: Record<string, unknown>;
  },
): void {
  const versions = api.prompts.get(options.name) ?? [];
  const config: Record<string, unknown> = { ...(options.config ?? {}) };
  if (options.fields) {
    config["voiceProvider"] = {
      ...((config["voiceProvider"] as Record<string, unknown>) ?? {}),
      fields: options.fields,
    };
  }
  versions.push({
    name: options.name,
    version: versions.length + 1,
    type: "text",
    prompt: options.text,
    labels: [options.label ?? "production"],
    tags: [],
    commitMessage: null,
    config,
  });
  api.prompts.set(options.name, versions);
}
