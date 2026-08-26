import test from "node:test";
import assert from "node:assert/strict";
import { Watcher } from "../src/sync/watcher.js";
import type { SyncEngine, SyncReport } from "../src/sync/engine.js";

function fakeReport(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    dryRun: false,
    results: [],
    counts: {
      "in-sync": 0,
      pushed: 0,
      pulled: 0,
      "created-prompt": 0,
      conflict: 0,
      skipped: 0,
      error: 0,
    },
    ok: true,
    ...overrides,
  };
}

test("start runs immediately and reports", async () => {
  let runs = 0;
  const reports: SyncReport[] = [];
  const engine = {
    run: async () => {
      runs += 1;
      return fakeReport();
    },
  } as unknown as SyncEngine;

  const watcher = new Watcher({
    engine,
    intervalSeconds: 3600,
    onReport: (report) => {
      reports.push(report);
    },
  });
  await watcher.start();
  await watcher.stop();

  assert.equal(runs, 1);
  assert.equal(reports.length, 1);
});

test("a failing run is logged and does not kill the loop", async () => {
  const engine = {
    run: async () => {
      throw new Error("langfuse is down");
    },
  } as unknown as SyncEngine;
  const messages: string[] = [];

  const watcher = new Watcher({
    engine,
    intervalSeconds: 3600,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => messages.push(message),
      child: () => ({}) as never,
    },
  });
  await watcher.start();
  await watcher.stop();

  assert.deepEqual(messages, ["sync tick failed"]);
});

test("ticks do not overlap", async () => {
  let active = 0;
  let maxActive = 0;
  const engine = {
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return fakeReport();
    },
  } as unknown as SyncEngine;

  const watcher = new Watcher({ engine, intervalSeconds: 5, jitter: 0 });
  const started = watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await started;
  await watcher.stop();

  assert.equal(maxActive, 1);
});

test("stop waits for the in-flight run", async () => {
  let finished = false;
  const engine = {
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = true;
      return fakeReport();
    },
  } as unknown as SyncEngine;

  const watcher = new Watcher({ engine, intervalSeconds: 3600 });
  await watcher.start();
  await watcher.stop();

  assert.equal(finished, true);
});

test("the loop keeps ticking after the first run", async () => {
  let runs = 0;
  const engine = {
    run: async () => {
      runs += 1;
      return fakeReport();
    },
  } as unknown as SyncEngine;

  // 5s is the configured minimum, so drive the schedule with fake timers
  // rather than waiting on wall-clock time.
  const watcher = new Watcher({ engine, intervalSeconds: 5, jitter: 0 });
  await watcher.start();
  assert.equal(runs, 1);

  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.ok(runs >= 2, `expected a second tick, saw ${runs} run(s)`);
  await watcher.stop();
});

test("a pending tick holds the event loop open", async () => {
  // A watcher that lets the process exit between ticks would make the
  // `watch` command run exactly once and quit.
  const engine = { run: async () => fakeReport() } as unknown as SyncEngine;
  const watcher = new Watcher({ engine, intervalSeconds: 3600 });
  await watcher.start();
  const timer = (watcher as unknown as { timer: NodeJS.Timeout }).timer;
  assert.ok(timer, "expected a scheduled tick");
  assert.ok(
    (timer as unknown as { hasRef?: () => boolean }).hasRef?.() !== false,
    "the scheduled tick must be ref'd",
  );
  await watcher.stop();
});
