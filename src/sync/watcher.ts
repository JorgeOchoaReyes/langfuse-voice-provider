import { silentLogger, type Logger } from "../core/logger.js";
import type { SyncEngine, RunOptions, SyncReport } from "./engine.js";

export interface WatcherOptions {
  engine: SyncEngine;
  intervalSeconds: number;
  /** Fraction of the interval added at random to each tick, 0–1. */
  jitter?: number;
  logger?: Logger;
  runOptions?: RunOptions;
  onReport?: (report: SyncReport) => void | Promise<void>;
}

/**
 * Polling loop.
 *
 * Ticks are sequential, never overlapping: a slow run delays the next tick
 * rather than racing it, which matters because two concurrent runs on the same
 * binding would both read a stale state entry.
 */
export class Watcher {
  private readonly options: WatcherOptions;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<void> = Promise.resolve();

  constructor(options: WatcherOptions) {
    this.options = options;
    this.logger = options.logger ?? silentLogger;
  }

  /** Run immediately, then on the interval until `stop()` is called. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.tick();
    this.schedule();
  }

  /** Stop scheduling and wait for any in-flight run to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    const base = this.options.intervalSeconds * 1000;
    const jitter = Math.max(0, Math.min(1, this.options.jitter ?? 0));
    const delay = base + Math.round(Math.random() * base * jitter);
    // Deliberately ref'd: the pending tick is what keeps a `watch` process
    // alive between runs. Callers embedding the watcher end it with `stop()`.
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, delay);
  }

  private tick(): Promise<void> {
    this.running = (async () => {
      try {
        const report = await this.options.engine.run(this.options.runOptions);
        const changed =
          report.counts.pushed +
          report.counts.pulled +
          report.counts["created-prompt"];
        if (changed > 0 || !report.ok) {
          this.logger.info("sync tick", {
            changed,
            ...report.counts,
            durationMs: report.durationMs,
          });
        } else {
          this.logger.debug("sync tick", { ...report.counts });
        }
        await this.options.onReport?.(report);
      } catch (error) {
        // A watcher that dies on a transient error is worse than one that
        // logs and tries again on the next tick.
        this.logger.error("sync tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return this.running;
  }
}
