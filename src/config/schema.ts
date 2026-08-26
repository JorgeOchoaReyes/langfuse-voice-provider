import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9._:\/-]+$/,
    "must contain only letters, digits and . _ : / -",
  );

export const bindingSchema = z
  .object({
    /** Stable id for this binding; used in state, logs and reports. */
    id: identifier.optional(),
    provider: z.enum(["retell", "elevenlabs", "vapi"]),
    /** Provider-side agent/assistant id. */
    agentId: z.string().min(1),
    /** Langfuse prompt name that mirrors this agent. */
    prompt: z.string().min(1),
    /**
     * Langfuse label this binding reads from and writes to. Versions created
     * from provider-side edits also receive this label, so the label always
     * names the prompt the agent is actually running.
     *
     * Left optional rather than defaulted so `defaults.label` can reach a
     * binding that does not set one.
     */
    label: z.string().min(1).optional(),
    /** Tags applied to every version this binding creates. */
    tags: z.array(z.string().min(1)).default([]),
    direction: z
      .enum(["langfuse-to-provider", "provider-to-langfuse", "bidirectional"])
      .optional(),
    conflictPolicy: z
      .enum(["prefer-langfuse", "prefer-provider", "manual"])
      .optional(),
    /** Extra fields (firstMessage, beginMessage, state:*) to sync. */
    syncFields: z.boolean().optional(),
    /** Provider-specific knobs, e.g. Retell `llmId`. */
    options: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
    /**
     * Values substituted into `{{variables}}` before pushing to the provider.
     * Leave empty to pass templates through untouched — all three providers
     * support `{{var}}` natively.
     */
    variables: z.record(z.string()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const providerCredentialsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    langfuse: z
      .object({
        baseUrl: z.string().url().default("https://cloud.langfuse.com"),
        publicKey: z.string().min(1).optional(),
        secretKey: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    providers: z
      .object({
        retell: providerCredentialsSchema.optional(),
        elevenlabs: providerCredentialsSchema.optional(),
        vapi: providerCredentialsSchema.optional(),
      })
      .strict()
      .default({}),
    /** Applied to any binding that does not override them. */
    defaults: z
      .object({
        direction: z
          .enum([
            "langfuse-to-provider",
            "provider-to-langfuse",
            "bidirectional",
          ])
          .default("bidirectional"),
        conflictPolicy: z
          .enum(["prefer-langfuse", "prefer-provider", "manual"])
          .default("manual"),
        label: z.string().min(1).default("production"),
        syncFields: z.boolean().default(true),
        tags: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
    bindings: z.array(bindingSchema).default([]),
    state: z
      .object({
        /**
         * `file` remembers the last synced hashes so bidirectional sync can
         * tell which side changed. `memory` forgets between runs and falls
         * back to the conflict policy whenever both sides differ.
         */
        driver: z.enum(["file", "memory"]).default("file"),
        path: z.string().min(1).default(".langfuse-voice-state.json"),
      })
      .strict()
      .default({}),
    watch: z
      .object({
        intervalSeconds: z.number().int().min(5).default(60),
        /** Random fraction of the interval added to each tick, 0–1. */
        jitter: z.number().min(0).max(1).default(0.1),
      })
      .strict()
      .default({}),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(8080),
        host: z.string().min(1).default("0.0.0.0"),
        /**
         * Shared secret required on webhook and sync calls. Compared in
         * constant time. Without it those routes are disabled.
         */
        webhookSecret: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
        format: z.enum(["json", "pretty"]).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RawConfig = z.input<typeof configSchema>;
export type ResolvedConfig = z.output<typeof configSchema>;
export type RawBinding = z.output<typeof bindingSchema>;
