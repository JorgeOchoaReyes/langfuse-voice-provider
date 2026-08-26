# langfuse-voice-provider

Keep voice-agent prompts on **Retell**, **ElevenLabs** and **Vapi** in sync with
**Langfuse** prompt management — in both directions, continuously.

Voice platforms let anyone edit an agent's system prompt in a dashboard. Those
edits are the highest-leverage changes in the whole system and, by default, the
least tracked: no version, no author, no diff, no rollback. Langfuse already
does prompt versioning well. This package is the wire between them.

```
   Langfuse prompt                      Retell  /  ElevenLabs  /  Vapi
   ───────────────                      ─────────────────────────────
   voice/support-line  ◀────pull────    someone edited the dashboard
        v7 (production) ────push───▶    agent now runs v7
```

Every change lands as a Langfuse prompt version with a commit message, a label
and a record of which agent it came from — whether it was made in Langfuse or
in the provider's dashboard.

---

## Install

```bash
npm install -g langfuse-voice-provider     # CLI
npm install langfuse-voice-provider        # library
```

Or run it without installing:

```bash
npx langfuse-voice-provider --help
```

Requires Node 20.11+. Runtime dependencies: `commander`, `yaml`, `zod`.

## Quick start

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export RETELL_API_KEY=...            # and/or ELEVENLABS_API_KEY, VAPI_API_KEY

langfuse-voice init                  # write a starter config
langfuse-voice list retell           # find your agent ids
# ...fill in bindings...
langfuse-voice sync --dry-run        # see the plan
langfuse-voice sync                  # do it
```

The first `sync` imports each agent's live prompt into Langfuse as version 1,
so you can adopt this on a running system without editing a prompt by hand.

## How it works

A **binding** ties one provider agent to one Langfuse prompt:

```yaml
bindings:
  - id: support-line
    provider: retell
    agentId: agent_0123456789abcdef
    prompt: voice/support-line
    label: production
```

On every pass the engine reads both sides, plus the content hashes recorded at
the last successful sync, and does a three-way merge:

| Langfuse | Provider | Result |
| --- | --- | --- |
| unchanged | unchanged | nothing to do |
| changed | unchanged | **push** — the agent is updated in place |
| unchanged | changed | **pull** — a new Langfuse version is created |
| changed | changed | **conflict** — resolved by `conflictPolicy` |

The recorded hashes are what make "who moved?" answerable. Without them a
difference is ambiguous, so the engine falls back to the conflict policy rather
than guessing — which is why the default policy is `manual`.

Langfuse prompt versions are immutable, so a pull never overwrites history: it
appends a version and moves the label onto it, exactly as the Langfuse UI does.

### What gets synced

The agent's system prompt is the body of a Langfuse **text prompt**. Smaller
strings that belong to the same edit ride along in the prompt's `config` under
a `voiceProvider` key:

| Provider | Prompt body | Extra fields |
| --- | --- | --- |
| Retell | Retell LLM `general_prompt` | `beginMessage`, `state:<name>` per conversation state |
| ElevenLabs | `conversation_config.agent.prompt.prompt` | `firstMessage` |
| Vapi | first `system` message of `model.messages` | `firstMessage` |

Set `syncFields: false` on a binding to sync only the prompt body.

Writes are always read-modify-write: the adapter re-reads the agent, changes
only the keys it owns, and sends the rest back untouched. Voice settings, ASR
config, model parameters, tools and non-system messages survive a sync.

### Field ownership

A Langfuse prompt declares which extra fields it manages: a field it carries is
managed, a field it does not carry is left alone.

This matters for prompts authored by hand in the Langfuse UI, which carry no
field bookkeeping at all. Without the rule, their empty field set would read as
"delete the agent's greeting" and every run would report a change it never
actually made. A pull captures the agent's full field set, so anything
unmanaged today becomes managed the first time the provider side wins.

## Directions and conflicts

Set per binding, or under `defaults`:

- `bidirectional` (default) — changes flow both ways, three-way merged.
- `langfuse-to-provider` — Langfuse is the source of truth; dashboard edits are
  overwritten on the next pass. Use once a prompt is under review.
- `provider-to-langfuse` — nothing is ever written to the provider; Langfuse
  just records what changes. The lowest-risk way to start.

When both sides moved, `conflictPolicy` decides:

- `manual` (default) — report it, touch nothing, exit non-zero.
- `prefer-langfuse` / `prefer-provider` — resolve automatically.

A one-off override resolves a standing conflict without editing config:

```bash
langfuse-voice sync --conflict prefer-provider
```

## Running it

### One-shot

```bash
langfuse-voice sync
```

Exit codes: `0` clean, `1` errors, `2` unresolved conflicts — so CI can fail on
drift.

### Continuously

```bash
langfuse-voice watch --interval 60
```

Ticks never overlap; a slow pass delays the next one rather than racing it. A
failed tick is logged and retried on the next interval instead of killing the
loop.

### As a service

```bash
langfuse-voice serve            # polls *and* serves HTTP
```

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz`, `GET /readyz` | open | liveness / readiness |
| `GET /metrics` | open | Prometheus text format |
| `GET /status` | open | last run's report as JSON |
| `POST /sync` | secret | trigger a full sync |
| `POST /webhooks/langfuse` | secret | trigger a sync, narrowed to the changed prompt |

Set `WEBHOOK_SECRET` to enable the two triggering routes; until you do they
reject every request. The secret is accepted as `Authorization: Bearer <s>`, an
`X-Webhook-Secret` header, or a `?secret=` query parameter, and is compared in
constant time.

Webhook payloads only ever *trigger* a sync — the body is never trusted as
prompt content, so a forged request can at worst cause an extra read of the two
APIs. Concurrent triggers are coalesced onto a single run.

### Docker

```bash
docker compose up -d
```

The compose file mounts your config read-only and keeps sync state in a named
volume. Without a persistent volume the sync still works, but bidirectional
bindings fall back to their conflict policy on the first run after a restart.

### GitHub Actions

`.github/workflows/sync.yml` runs the sync on a schedule with no hosting at
all, caching the state file between runs.

## Configuration

Config is discovered by walking up from the working directory looking for
`langfuse-voice.config.yaml` (`.yml`, `.json` and `.langfusevoicerc` also
work), or passed with `--config`.

**Secrets belong in the environment, not the file.** Environment variables take
precedence over file values, so a committed config never needs editing to
deploy. The file can also reference the environment directly:

```yaml
providers:
  retell:
    apiKey: ${RETELL_API_KEY}
    baseUrl: ${RETELL_BASE_URL:-https://api.retellai.com}
```

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | required |
| `LANGFUSE_BASE_URL` | self-hosted Langfuse (`LANGFUSE_HOST` also accepted) |
| `RETELL_API_KEY`, `ELEVENLABS_API_KEY`, `VAPI_API_KEY` | per provider, as used |
| `WEBHOOK_SECRET`, `PORT`, `LOG_LEVEL` | server |

Vapi needs the **private** key; the public key cannot read assistants.

See [`examples/langfuse-voice.config.yaml`](examples/langfuse-voice.config.yaml)
for a worked config covering every option.

### Variables

All three providers support `{{variable}}` for runtime dynamic variables, so
templates pass through untouched by default. A binding can bake values in at
push time:

```yaml
- id: support-line-staging
  provider: retell
  agentId: agent_aaaabbbbccccdddd
  prompt: voice/support-line
  label: staging
  direction: langfuse-to-provider
  variables:
    environment: staging
```

Only the listed variables are substituted; everything else is left for the
provider to fill at call time. Rendering is one-way — a rendered prompt cannot
be turned back into its template — so bindings with `variables` must be
`langfuse-to-provider`. The config loader rejects any other direction rather
than letting a later pull overwrite your template with rendered output.

## Commands

| Command | Purpose |
| --- | --- |
| `sync` | one pass over every enabled binding |
| `push` / `pull` | force one direction for this run |
| `status` | report drift, write nothing |
| `watch` | poll continuously |
| `serve` | HTTP server, with or without the poll loop |
| `list [provider]` | list agents, to find ids for your bindings |
| `init` | write a starter config |
| `validate` | check config without contacting any API |

Global flags: `--config`, `--log-level`, `--json`. Most commands take
`--dry-run` and `--only <ids...>`, which matches on binding id, prompt name or
agent id.

## Library use

```ts
import { SyncEngine, formatReport } from "langfuse-voice-provider";

const engine = new SyncEngine({ config });
const report = await engine.run({ dryRun: true });
console.log(formatReport(report));
```

Providers, the Langfuse client, the state stores, the watcher and the server
are all exported and usable on their own. See
[`examples/programmatic.ts`](examples/programmatic.ts).

Adding a provider means implementing `VoiceProvider` — `listAgents`,
`getPrompt`, `setPrompt` — and registering it. All hashing, versioning and
conflict handling lives in the engine, not the adapters.

## Notes and limits

- **Retell agents must use a `retell-llm` response engine.** Agents backed by a
  custom LLM or a conversation flow have no single prompt to own; they are
  reported as skipped with a reason, never silently ignored.
- **Retell conversation states** are synced as `state:<name>` fields. States the
  binding does not carry are preserved, never dropped.
- **Chat prompts** in Langfuse are folded to their system turns when pushed,
  since voice agents take a single system prompt. Pulls always write text
  prompts.
- **Whitespace is normalised** before hashing (CRLF, trailing spaces, leading
  and trailing blank lines), so a copy-paste round trip through a dashboard
  does not create a spurious version.
- **State is advisory.** Losing the state file costs you one conflict-policy
  decision per binding, never data: Langfuse versions are immutable and the
  provider is re-read every pass.
- Credentials are masked in logs and in API error bodies.

## Development

```bash
npm install
npm run typecheck
npm test          # 106 tests, no network
```

Tests run against in-memory fakes of all four APIs that mirror the real request
and response shapes — paths, auth headers and nesting — so the adapters are
exercised over the wire format they meet in production.

## License

MIT
