import { ConfigError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { ProviderName, VoiceProvider } from "../types.js";
import { ElevenLabsProvider } from "./elevenlabs.js";
import { RetellProvider } from "./retell.js";
import { VapiProvider } from "./vapi.js";

export { ElevenLabsProvider } from "./elevenlabs.js";
export { RetellProvider } from "./retell.js";
export { VapiProvider } from "./vapi.js";

export const PROVIDER_NAMES: readonly ProviderName[] = [
  "retell",
  "elevenlabs",
  "vapi",
];

/** Env var each provider's credential is read from when config omits it. */
export const PROVIDER_ENV_VARS: Record<ProviderName, string> = {
  retell: "RETELL_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  vapi: "VAPI_API_KEY",
};

export interface ProviderFactoryOptions {
  apiKey: string;
  baseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Build the adapter for a provider name. */
export function createProvider(
  name: ProviderName,
  options: ProviderFactoryOptions,
): VoiceProvider {
  if (!options.apiKey) {
    throw new ConfigError(
      `Missing API key for provider "${name}". Set ${PROVIDER_ENV_VARS[name]} or providers.${name}.apiKey in the config.`,
    );
  }
  switch (name) {
    case "retell":
      return new RetellProvider(options);
    case "elevenlabs":
      return new ElevenLabsProvider(options);
    case "vapi":
      return new VapiProvider(options);
    default: {
      const exhaustive: never = name;
      throw new ConfigError(`Unknown provider "${String(exhaustive)}".`);
    }
  }
}

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}
