/** Base class for every error this package raises deliberately. */
export class LangfuseVoiceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration was missing, malformed, or internally inconsistent. */
export class ConfigError extends LangfuseVoiceError {}

/** A remote API returned a non-2xx response. */
export class ApiError extends LangfuseVoiceError {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
  }
}

/** The requested resource does not exist yet (a 404 that callers may expect). */
export class NotFoundError extends ApiError {}

/**
 * Both sides of a bidirectional binding changed since the last sync and the
 * conflict policy is `manual`.
 */
export class ConflictError extends LangfuseVoiceError {
  constructor(
    message: string,
    readonly binding: string,
  ) {
    super(message);
  }
}

/** A provider cannot sync the requested agent (wrong engine type, etc). */
export class UnsupportedAgentError extends LangfuseVoiceError {}
