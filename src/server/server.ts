import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { silentLogger, type Logger } from "../core/logger.js";
import type { SyncEngine, SyncReport } from "../sync/engine.js";
import { formatMetrics } from "../sync/report.js";
import { Watcher } from "../sync/watcher.js";

export interface ServerOptions {
  engine: SyncEngine;
  host: string;
  port: number;
  /** Required on /sync and /webhooks/*. Without it those routes return 404. */
  webhookSecret?: string;
  /** When set, the server also runs the polling watcher. */
  watch?: { intervalSeconds: number; jitter?: number };
  logger?: Logger;
}

/** Largest webhook body accepted, to bound memory on a public endpoint. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Deployable HTTP surface.
 *
 * Health and metrics are open; anything that triggers a sync requires the
 * shared secret. Webhooks only ever *trigger* a sync — the payload is never
 * trusted as the new prompt content, so a forged body can at worst cause an
 * extra read of the two APIs.
 */
export class SyncServer {
  private readonly options: ServerOptions;
  private readonly logger: Logger;
  private readonly server: Server;
  private readonly watcher: Watcher | undefined;

  private lastReport: SyncReport | null = null;
  private runsTotal = 0;
  private failuresTotal = 0;
  private lastRunUnix = 0;
  private inFlight: Promise<SyncReport> | null = null;

  constructor(options: ServerOptions) {
    this.options = options;
    this.logger = options.logger ?? silentLogger;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.logger.error("request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(res, 500, { error: "internal error" });
      });
    });
    if (options.watch) {
      this.watcher = new Watcher({
        engine: options.engine,
        intervalSeconds: options.watch.intervalSeconds,
        ...(options.watch.jitter !== undefined ? { jitter: options.watch.jitter } : {}),
        logger: this.logger,
        onReport: (report) => this.record(report),
      });
    }
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.options.port, this.options.host, resolve);
    });
    this.logger.info("server listening", {
      host: this.options.host,
      port: this.options.port,
      watching: Boolean(this.watcher),
      authenticated: Boolean(this.options.webhookSecret),
    });
    if (this.watcher) await this.watcher.start();
  }

  async close(): Promise<void> {
    await this.watcher?.stop();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** The bound port, useful when listening on port 0 in tests. */
  address(): { port: number } | null {
    const address = this.server.address();
    return address && typeof address === "object" ? { port: address.port } : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method ?? "GET"} ${url.pathname}`;

    switch (route) {
      case "GET /healthz":
      case "GET /readyz":
        return sendJson(res, 200, { status: "ok" });

      case "GET /status":
        return sendJson(res, 200, {
          runsTotal: this.runsTotal,
          failuresTotal: this.failuresTotal,
          lastRunAt: this.lastRunUnix ? new Date(this.lastRunUnix * 1000).toISOString() : null,
          lastReport: this.lastReport,
        });

      case "GET /metrics":
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(
          formatMetrics(this.lastReport, {
            runsTotal: this.runsTotal,
            failuresTotal: this.failuresTotal,
            lastRunUnix: this.lastRunUnix,
          }),
        );
        return;

      case "POST /sync":
      case "POST /webhooks/langfuse": {
        if (!this.authorize(req, url)) {
          return sendJson(res, 401, { error: "unauthorized" });
        }
        // Drain the body so the socket can be reused, but do not trust it.
        const body = await readBody(req);
        const only = extractPromptNames(body);
        const report = await this.runOnce(only);
        return sendJson(res, report.ok ? 200 : 409, report);
      }

      default:
        return sendJson(res, 404, { error: "not found" });
    }
  }

  /**
   * Coalesce concurrent triggers onto one run. Several webhooks arriving at
   * once should not start several overlapping syncs of the same bindings.
   */
  private runOnce(only?: string[]): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    const run = this.options.engine
      .run(only?.length ? { only } : {})
      .then(async (report) => {
        await this.record(report);
        return report;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async record(report: SyncReport): Promise<void> {
    this.lastReport = report;
    this.runsTotal += 1;
    if (!report.ok) this.failuresTotal += 1;
    this.lastRunUnix = Math.floor(Date.parse(report.finishedAt) / 1000);
  }

  /** Constant-time comparison of the shared secret. */
  private authorize(req: IncomingMessage, url: URL): boolean {
    const expected = this.options.webhookSecret;
    if (!expected) return false;
    const header = req.headers["authorization"];
    const presented =
      (typeof header === "string" && header.replace(/^Bearer\s+/i, "")) ||
      (typeof req.headers["x-webhook-secret"] === "string"
        ? (req.headers["x-webhook-secret"] as string)
        : "") ||
      url.searchParams.get("secret") ||
      "";
    return constantTimeEquals(presented, expected);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Still compare something of equal length so the timing does not leak
    // the expected secret's length.
    timingSafeEqual(bufferB, bufferB);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Pull prompt names out of a Langfuse webhook payload so a triggered run can
 * be narrowed to the prompt that actually changed.
 */
function extractPromptNames(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const candidates = [
    record["promptName"],
    (record["prompt"] as Record<string, unknown> | undefined)?.["name"],
    (record["data"] as Record<string, unknown> | undefined)?.["promptName"],
    ((record["data"] as Record<string, unknown> | undefined)?.["prompt"] as
      | Record<string, unknown>
      | undefined)?.["name"],
  ];
  const names = candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return names.length ? [...new Set(names)] : undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
