import { ApiError, NotFoundError } from "./errors.js";
import { redactText } from "./redact.js";
import { silentLogger, type Logger } from "./logger.js";

export interface HttpClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  retryBaseMs?: number;
  logger?: Logger;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Return `null` instead of throwing when the response is 404. */
  allow404?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A small JSON-over-HTTP client shared by every adapter.
 *
 * Retries are limited to transport failures and the status codes above, so a
 * 4xx caused by a bad prompt payload fails fast instead of being hammered.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async request<T>(options: RequestOptions & { allow404: true }): Promise<T | null>;
  async request<T>(options: RequestOptions): Promise<T>;
  async request<T>(options: RequestOptions): Promise<T | null> {
    const url = this.buildUrl(options.path, options.query);
    const method = options.method ?? "GET";
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        ...this.headers,
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.backoffDelay(attempt, lastError);
        this.logger.debug("retrying request", {
          method,
          url,
          attempt,
          delayMs: delay,
        });
        await this.sleepImpl(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
        });

        if (response.status === 404 && options.allow404) return null;

        if (!response.ok) {
          const text = await safeText(response);
          const error = makeApiError(response.status, url, text);
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
            lastError = withRetryAfter(error, response);
            continue;
          }
          throw error;
        }

        if (response.status === 204) return null as T;
        const text = await safeText(response);
        if (!text) return null as T;
        return JSON.parse(text) as T;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // Transport-level failure (DNS, socket, timeout) — worth retrying.
        lastError = error;
        if (attempt >= this.maxRetries) {
          throw new ApiError(
            `${method} ${url} failed after ${attempt + 1} attempt(s): ${
              error instanceof Error ? error.message : String(error)
            }`,
            0,
            url,
            "",
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ApiError(`${method} ${url} failed`, 0, url, "");
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const url = new URL(
      path.startsWith("/") ? `${this.baseUrl}${path}` : `${this.baseUrl}/${path}`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Exponential backoff with full jitter, honouring a Retry-After hint. */
  private backoffDelay(attempt: number, lastError: unknown): number {
    const hinted =
      lastError instanceof ApiError
        ? (lastError as ApiError & { retryAfterMs?: number }).retryAfterMs
        : undefined;
    if (typeof hinted === "number" && hinted > 0) return Math.min(hinted, 60_000);
    const ceiling = Math.min(this.retryBaseMs * 2 ** (attempt - 1), 30_000);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }
}

function withRetryAfter(error: ApiError, response: Response): ApiError {
  const header = response.headers?.get?.("retry-after");
  if (!header) return error;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    (error as ApiError & { retryAfterMs?: number }).retryAfterMs = seconds * 1000;
  }
  return error;
}

function makeApiError(status: number, url: string, body: string): ApiError {
  const message = `HTTP ${status} for ${url}${body ? `: ${truncate(redactText(body))}` : ""}`;
  return status === 404
    ? new NotFoundError(message, status, url, body)
    : new ApiError(message, status, url, body);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}... (truncated)` : text;
}
