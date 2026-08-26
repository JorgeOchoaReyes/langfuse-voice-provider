/**
 * langfuse-voice-provider
 *
 * Keeps voice-agent prompts on Retell, ElevenLabs and Vapi in sync with
 * Langfuse prompt management, so every prompt change — wherever it was made —
 * lands as a versioned, labelled, attributable Langfuse prompt version.
 */

export type {
  AgentSummary,
  ConflictPolicy,
  LangfusePrompt,
  PromptDocument,
  ProviderName,
  ProviderTarget,
  RemotePrompt,
  SyncDirection,
  VoiceProvider,
} from "./types.js";

export {
  ApiError,
  ConfigError,
  ConflictError,
  LangfuseVoiceError,
  NotFoundError,
  UnsupportedAgentError,
} from "./core/errors.js";

export { createLogger, silentLogger } from "./core/logger.js";
export type { Logger, LogLevel } from "./core/logger.js";
export { HttpClient } from "./core/http.js";
export { documentsEqual, hashDocument, normalizeText, shortHash } from "./core/hash.js";
export { maskSecret, redactObject, redactText } from "./core/redact.js";

export {
  CONFIG_NAMESPACE,
  LangfuseClient,
  readVoiceConfig,
} from "./langfuse/client.js";
export type {
  CreatePromptInput,
  LangfuseClientOptions,
  PromptMeta,
  VoiceProviderConfig,
} from "./langfuse/client.js";

export {
  createProvider,
  isProviderName,
  ElevenLabsProvider,
  PROVIDER_ENV_VARS,
  PROVIDER_NAMES,
  RetellProvider,
  VapiProvider,
} from "./providers/index.js";

export {
  CONFIG_FILE_NAMES,
  expandEnvPlaceholders,
  findConfigFile,
  loadConfig,
  parseConfig,
} from "./config/load.js";
export type { AppConfig, Binding, LoadConfigOptions } from "./config/load.js";
export { bindingSchema, configSchema } from "./config/schema.js";
export type { RawConfig, ResolvedConfig } from "./config/schema.js";

export { SyncEngine } from "./sync/engine.js";
export type {
  BindingResult,
  RunOptions,
  SyncAction,
  SyncEngineOptions,
  SyncReport,
} from "./sync/engine.js";
export { diffDocuments, summarizeChanges } from "./sync/diff.js";
export type { FieldChange } from "./sync/diff.js";
export { renderDocument, renderText } from "./sync/render.js";
export {
  createStateStore,
  FileStateStore,
  MemoryStateStore,
} from "./sync/state.js";
export type { BindingState, StateStore } from "./sync/state.js";
export { exitCodeFor, formatMetrics, formatReport, toJson } from "./sync/report.js";
export { Watcher } from "./sync/watcher.js";
export type { WatcherOptions } from "./sync/watcher.js";
export { SyncServer } from "./server/server.js";
export type { ServerOptions } from "./server/server.js";
