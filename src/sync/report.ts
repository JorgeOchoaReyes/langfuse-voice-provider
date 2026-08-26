import type { BindingResult, SyncAction, SyncReport } from "./engine.js";

const SYMBOL: Record<SyncAction, string> = {
  "in-sync": "=",
  pushed: ">",
  pulled: "<",
  "created-prompt": "+",
  conflict: "!",
  skipped: "-",
  error: "x",
};

/** Render a report as aligned plain text for a terminal. */
export function formatReport(report: SyncReport): string {
  const lines: string[] = [];
  if (report.dryRun) lines.push("DRY RUN - nothing was written\n");

  if (report.results.length === 0) {
    lines.push("No bindings matched.");
    return lines.join("\n");
  }

  const width = Math.max(
    ...report.results.map((result) => result.bindingId.length),
    7,
  );
  for (const result of report.results) {
    lines.push(
      `${SYMBOL[result.action]} ${result.bindingId.padEnd(width)}  ${result.action.padEnd(
        14,
      )} ${result.summary}`,
    );
  }

  lines.push("");
  const parts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([action, count]) => `${count} ${action}`);
  lines.push(
    `${report.results.length} binding(s) in ${report.durationMs}ms: ${
      parts.join(", ") || "nothing to do"
    }`,
  );
  return lines.join("\n");
}

/** Exit code for a CLI run: 0 clean, 1 errors, 2 unresolved conflicts. */
export function exitCodeFor(report: SyncReport): number {
  if (report.counts.error > 0) return 1;
  if (report.counts.conflict > 0) return 2;
  return 0;
}

/** Prometheus text-format metrics derived from the most recent report. */
export function formatMetrics(
  report: SyncReport | null,
  extra: { runsTotal: number; failuresTotal: number; lastRunUnix: number },
): string {
  const lines: string[] = [
    "# HELP langfuse_voice_runs_total Sync runs started since process start.",
    "# TYPE langfuse_voice_runs_total counter",
    `langfuse_voice_runs_total ${extra.runsTotal}`,
    "# HELP langfuse_voice_run_failures_total Sync runs that ended with errors or conflicts.",
    "# TYPE langfuse_voice_run_failures_total counter",
    `langfuse_voice_run_failures_total ${extra.failuresTotal}`,
    "# HELP langfuse_voice_last_run_timestamp_seconds Unix time of the last completed run.",
    "# TYPE langfuse_voice_last_run_timestamp_seconds gauge",
    `langfuse_voice_last_run_timestamp_seconds ${extra.lastRunUnix}`,
  ];

  if (report) {
    lines.push(
      "# HELP langfuse_voice_last_run_duration_seconds Duration of the last completed run.",
      "# TYPE langfuse_voice_last_run_duration_seconds gauge",
      `langfuse_voice_last_run_duration_seconds ${(report.durationMs / 1000).toFixed(3)}`,
      "# HELP langfuse_voice_bindings Bindings in the last run, by outcome.",
      "# TYPE langfuse_voice_bindings gauge",
    );
    for (const [action, count] of Object.entries(report.counts)) {
      lines.push(`langfuse_voice_bindings{action="${action}"} ${count}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** JSON shape intended for piping into other tools. */
export function toJson(report: SyncReport): string {
  return JSON.stringify(report, null, 2);
}

export type { BindingResult, SyncReport };
