export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** `json` for machine-readable logs (containers), `pretty` for a terminal. */
  format?: "json" | "pretty";
  /** Injected for tests. */
  write?: (line: string) => void;
}

const COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const RESET = "\u001b[0m";

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format =
    options.format ?? (process.stderr.isTTY === true ? "pretty" : "json");
  const write =
    options.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const useColor = format === "pretty" && process.stderr.isTTY === true;

  const make = (bound: Record<string, unknown>): Logger => {
    const emit = (
      lineLevel: Exclude<LogLevel, "silent">,
      message: string,
      fields?: Record<string, unknown>,
    ) => {
      if (ORDER[lineLevel] < ORDER[level]) return;
      const merged = { ...bound, ...fields };
      if (format === "json") {
        write(
          JSON.stringify({
            time: new Date().toISOString(),
            level: lineLevel,
            message,
            ...merged,
          }),
        );
        return;
      }
      const tag = useColor
        ? `${COLOR[lineLevel]}${lineLevel.padEnd(5)}${RESET}`
        : lineLevel.padEnd(5);
      const suffix = Object.keys(merged).length
        ? " " +
          Object.entries(merged)
            .map(([k, v]) => `${k}=${formatValue(v)}`)
            .join(" ")
        : "";
      write(`${tag} ${message}${suffix}`);
    };

    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };

  return make({});
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** A logger that discards everything — the default for library consumers. */
export const silentLogger: Logger = createLogger({ level: "silent" });
